import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import type { Invoke, KubeObject, ResourceType } from './types'
import './session.css'
import { KiteSessionTransport } from '../lib/kite-session-transport'

type Mode = 'logs' | 'exec' | 'files' | 'forward'
type Frame = { sessionId: string; data?: string; closed?: boolean; ready?: boolean; error?: string; droppedBytes?: number; ports?: { Local: number; Remote: number }[] }
type Props = { resource: ResourceType; object: KubeObject; invoke: Invoke; onClose: () => void }
type Live = { id: string; invoke: Invoke; generation: number }

// Resource identity is also a lifecycle boundary when a parent reuses the panel.
export default function SessionPanel(props: Props) {
  return <SessionContent key={`${props.resource.group}/${props.resource.resource}/${props.object.metadata?.namespace}/${props.object.metadata?.uid || props.object.metadata?.name}`} {...props} />
}

function SessionContent({ resource, object, invoke, onClose }: Props) {
  const isPod = resource.resource === 'pods'
  const [mode, setMode] = useState<Mode>(isPod ? 'logs' : 'forward')
  const containers: { name: string }[] = [...(object.spec?.containers || []), ...(object.spec?.initContainers || []), ...(object.spec?.ephemeralContainers || [])]
  const [container, setContainer] = useState('')
  const [tail, setTail] = useState(500)
  const [since, setSince] = useState('')
  const [follow, setFollow] = useState(true)
  const [previous, setPrevious] = useState(false)
  const [shell, setShell] = useState('/bin/sh')
  const [filePath, setFilePath] = useState('/')
  const [fileReadPath, setFileReadPath] = useState('')
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [fileEntries, setFileEntries] = useState<{type:string;path:string}[]>([])
  const [copyStatus, setCopyStatus] = useState('')
  const uploadInput = useRef<HTMLInputElement>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const fileMutation = useRef(false)
  const declaredPorts: number[] = resource.resource === 'services'
    ? (object.spec?.ports || []).filter((p: { protocol?: string }) => !p.protocol || p.protocol === 'TCP').map((p: { port: number }) => p.port)
    : (object.spec?.containers || object.spec?.template?.spec?.containers || []).flatMap((c: { ports?: { containerPort: number; protocol?: string }[] }) => (c.ports || []).filter(p => !p.protocol || p.protocol === 'TCP').map(p => p.containerPort))
  const [remotePort, setRemotePort] = useState(declaredPorts[0] || 8080)
  const [localPort, setLocalPort] = useState(0)
  const [status, setStatus] = useState('未连接 / Disconnected')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [active, setActive] = useState(false)
  const [forwards, setForwards] = useState<Frame[]>([])
  const [search, setSearch] = useState('')
  const terminalElement = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const searchAddon = useRef<SearchAddon | null>(null)
  const live = useRef<Live | null>(null)
  const generation = useRef(0)
  const mounted = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const transport = useRef(new KiteSessionTransport(invoke))
  const rpc = useRef(invoke)
  rpc.current = invoke
  transport.current = new KiteSessionTransport(invoke)
  const inputQueue = useRef(Promise.resolve())
  const pendingInput = useRef(0)
  const ownedForwards = useRef(new Map<string, Invoke>())

  function closeQuietly(call: Invoke, id: string) {
    void call('session/close', { sessionId: id }).catch(() => {})
  }

  function stop() {
    generation.current++
    clearTimeout(timer.current)
    const old = live.current
    live.current = null
    if (old) {
      ownedForwards.current.delete(old.id)
      closeQuietly(old.invoke, old.id)
    }
    setActive(false)
    setBusy(false)
    setStatus('已关闭 / Closed')
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current++
      clearTimeout(timer.current)
      const old = live.current
      live.current = null
      if (old) closeQuietly(old.invoke, old.id)
      for (const [id, call] of ownedForwards.current) if (id !== old?.id) closeQuietly(call, id)
      ownedForwards.current.clear()
    }
  }, [])

  useEffect(() => {
    if (!terminalElement.current || mode === 'forward') return
    const term = new Terminal({ convertEol: mode === 'logs', disableStdin: mode !== 'exec', scrollback: 5000, fontSize: 13, theme: { background: '#111827', foreground: '#e5e7eb' } })
    const fit = new FitAddon()
    const find = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(find)
    term.open(terminalElement.current)
    terminal.current = term
    searchAddon.current = find
    const resize = () => {
      if (!terminalElement.current?.clientWidth || !terminalElement.current?.clientHeight) return
      fit.fit()
      const session = live.current
      if (session && mode === 'exec') void session.invoke('pod/exec-resize', { sessionId: session.id, cols: term.cols, rows: term.rows }).catch(e => { if (live.current === session) setError(String(e)) })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(terminalElement.current)
    resize()
    const data = term.onData(text => {
      const session = live.current
      if (!session || mode !== 'exec') return
      // Serialize keyboard writes and reject large pastes rather than growing an unbounded queue.
      if (pendingInput.current + text.length > 16384) { setError('输入队列已满，请等待后重试 / Input queue full'); return }
      pendingInput.current += text.length
      inputQueue.current = inputQueue.current.then(async () => {
        if (live.current !== session) return
        await session.invoke('pod/exec-write', { sessionId: session.id, data: text })
      }).catch(e => { if (live.current === session) setError(String(e)) }).finally(() => { pendingInput.current -= text.length })
    })
    return () => { observer.disconnect(); data.dispose(); term.dispose(); terminal.current = null; searchAddon.current = null }
  }, [mode])

  async function refreshForwards() {
    const call = rpc.current
    try {
      const result = await call<Frame[]>('port-forward/list')
      if (mounted.current && rpc.current === call) setForwards(result || [])
    } catch (e) { if (mounted.current) setError(String(e)) }
  }

  useEffect(() => {
    if (mode !== 'forward') return
    let cancelled = false
    let timeout: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const result = await rpc.current<Frame[]>('port-forward/list')
        if (!cancelled) setForwards(result || [])
      } catch (e) { if (!cancelled) setError(String(e)) }
      if (!cancelled) timeout = setTimeout(refresh, 2000)
    }
    void refresh()
    return () => { cancelled = true; clearTimeout(timeout) }
  }, [mode])

  useEffect(() => { setFileContent(null) }, [fileReadPath, container, mode])
  async function readFile() {
    if (busy || !fileReadPath.startsWith('/') || fileReadPath === '/') return
    const token = ++generation.current
    setBusy(true); setError(''); setFileContent(null)
    try {
      const result = await rpc.current<{content:string;truncated:boolean}>('pod/file-read', {
        namespace:object.metadata?.namespace, name:object.metadata?.name,
        container:container||containers[0]?.name, path:fileReadPath,
      })
      if (!mounted.current || token !== generation.current) return
      terminal.current?.reset(); terminal.current?.write(result.content)
      // A preview must never be downloaded as though it were a complete file.
      if (!result.truncated) setFileContent(result.content)
      if (result.truncated) terminal.current?.writeln('\r\n[内容已截断至 256 KiB，不能作为完整文件下载]')
      setStatus('文件内容已加载 / File loaded')
    } catch(e) { if (mounted.current && token === generation.current) setError(String(e)) }
    finally { if (mounted.current && token === generation.current) setBusy(false) }
  }
  async function mutateFile(kind: 'write' | 'delete', target: string, file?: File) {
    if (fileMutation.current || busy || active) return
    fileMutation.current = true
    const token = ++generation.current
    const call = rpc.current
    const identity = { namespace: object.metadata?.namespace, name: object.metadata?.name, container: container || containers[0]?.name }
    const current = () => mounted.current && generation.current === token && rpc.current === call
    setBusy(true); setError(''); setPendingDelete(null)
    try {
      let content: string | undefined
      if (file) {
        if (file.size > 262144) throw new Error('文件超过 256 KiB / File exceeds 256 KiB')
        const bytes = await file.arrayBuffer()
        // Reject binary/invalid text instead of silently corrupting uploads.
        content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
        if (content.includes('\0')) throw new Error('请选择 UTF-8 文本文件 / Choose a UTF-8 text file')
        if (!current()) return
      }
      await call(`pod/file-${kind}`, { ...identity, path: target, ...(file ? { content } : {}) })
      if (!current()) return
      setFileContent(null)
      setFileReadPath(kind === 'write' ? target : '')
      terminal.current?.reset()
      const message = kind === 'write' ? '文件已上传 / File uploaded' : '文件已删除 / File deleted'
      setStatus(message)
      try {
        const result = await call<{ items: {type:string;path:string}[] }>('pod/files-list', { ...identity, path: filePath, depth: 2 })
        if (current()) setFileEntries(result.items || [])
      } catch (e) {
        if (current()) setError(`${message}；目录刷新失败 / Directory refresh failed: ${String(e)}`)
      }
    } catch (e) { if (current()) setError(String(e)) }
    finally { fileMutation.current = false; if (current()) setBusy(false) }
  }
  async function uploadFile(file: File) {
    const target = `${filePath.replace(/\/$/, '')}/${file.name}`
    await mutateFile('write', target, file)
  }

  async function start() {
    if (busy || active) return
    const token = ++generation.current
    const call = rpc.current
    setError('')
    setBusy(true)
    setStatus('正在建立会话 / Connecting…')
    terminal.current?.reset()
    const target = { namespace: object.metadata?.namespace, name: object.metadata?.name }
    try {
      if (mode === 'files') {
        const result = await call<{ items: { type: string; path: string }[] }>('pod/files-list', { namespace: object.metadata?.namespace, name: object.metadata?.name, container: container || containers[0]?.name, path: filePath, depth: 2 })
        if (!mounted.current || token !== generation.current) return
        terminal.current?.writeln((result.items || []).map(item => `${item.type}\t${item.path}`).join('\r\n') || '没有文件 / No files')
        setFileEntries(result.items || []); setBusy(false); setStatus('文件列表已加载 / File list loaded'); return
      }
      const opened = await call<Frame>(mode === 'logs' ? 'pod/logs-open' : mode === 'exec' ? 'pod/exec-open' : 'port-forward/open', {
        ...target,
        ...(mode === 'logs' ? { container, tailLines: tail, follow, previous, timestamps: true, ...(since ? { sinceSeconds: Number(since) } : {}) }
          : mode === 'exec' ? { container: container || containers[0]?.name, command: [shell], tty: true }
            : { resource: resource.resource, ports: [`${localPort}:${remotePort}`] }),
      })
      if (!opened.sessionId) throw new Error('后端未返回 sessionId / Missing session ID')
      if (!mounted.current || generation.current !== token) { closeQuietly(call, opened.sessionId); return }
      const session = { id: opened.sessionId, invoke: call, generation: token }
      live.current = session
      if (mode === 'forward') ownedForwards.current.set(session.id, call)
      setBusy(false)
      setActive(true)
      if (mode === 'exec' && terminal.current) {
        terminal.current.focus()
        void call('pod/exec-resize', { sessionId: session.id, cols: terminal.current.cols, rows: terminal.current.rows }).catch(e => { if (live.current === session) setError(String(e)) })
      }
      const consume = (frame: Frame) => {
        if (live.current !== session) return false
        if (frame.data) terminal.current?.write(frame.data)
        if (frame.droppedBytes) terminal.current?.writeln(`\r\n[缓冲区溢出，丢弃 ${frame.droppedBytes} 字节 / Output dropped]\r\n`)
        if (frame.error) setError(frame.error)
        setStatus(frame.closed ? '会话已结束 / Session ended' : mode === 'forward' ? (frame.ready ? '转发已就绪 / Forward ready' : '等待端口就绪 / Waiting for port…') : mode === 'logs' ? '正在读取日志 / Reading logs' : '终端会话已创建 / Terminal session created')
        if (frame.closed) {
          live.current = null
          ownedForwards.current.delete(session.id)
          closeQuietly(call, session.id)
          setActive(false)
          if (mode === 'forward') void refreshForwards()
          return false
        }
        return true
      }
      if (!consume(opened)) return
      async function poll() {
        try {
          const frame = await call<Frame>('session/read', { sessionId: session.id })
          if (live.current !== session || !mounted.current) return
          if (!consume(frame)) return
          timer.current = setTimeout(poll, mode === 'forward' ? 1000 : 250)
        } catch (e) {
          if (live.current !== session || !mounted.current) return
          setError(String(e))
          stop()
        }
      }
      void poll()
      if (mode === 'forward') void refreshForwards()
    } catch (e) {
      if (!mounted.current || generation.current !== token) return
      setError(String(e)); setBusy(false); setStatus('连接失败 / Connection failed')
    }
  }

  const locked = busy || active
  return <section className="k8s-session" aria-label="资源会话 Resource session">
    <header><strong>{resource.kind} · {object.metadata?.namespace}/{object.metadata?.name}</strong><button onClick={onClose} aria-label="关闭会话面板 Close sessions">×</button></header>
    <nav aria-label="会话类型 Session type">
      {(isPod ? ['logs', 'exec', 'files', 'forward'] as Mode[] : ['forward'] as Mode[]).map(tab => <button key={tab} aria-pressed={mode === tab} onClick={() => { if (mode !== tab) { stop(); setError(''); setPendingDelete(null); setMode(tab) } }}>{tab === 'logs' ? '日志 Logs' : tab === 'exec' ? '终端 Terminal' : tab === 'files' ? '文件 Files' : '端口转发 Port forward'}</button>)}
    </nav>
    {pendingDelete && <div role="alertdialog" aria-label="确认删除文件 Confirm file deletion"><p>永久删除文件 / Permanently delete: <code>{pendingDelete}</code></p><button onClick={() => setPendingDelete(null)}>取消 Cancel</button><button disabled={locked} onClick={() => void mutateFile('delete', pendingDelete)}>确认删除 Confirm delete</button></div>}
    <div className="k8s-session-controls">
      {mode !== 'forward' && <label>容器 Container<select disabled={locked} value={container} onChange={e => setContainer(e.target.value)}>{mode === 'logs' && <option value="">全部常规容器 / All containers</option>}{mode === 'exec' && <option value="">{containers[0]?.name || '默认 / Default'}</option>}{containers.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>}
      {mode === 'logs' && <><label>行数 Tail<input type="number" min="0" max="100000" value={tail} disabled={locked} onChange={e => setTail(Number(e.target.value))} /></label><label>最近秒数 Since<input type="number" min="0" placeholder="不限 / All" value={since} disabled={locked} onChange={e => setSince(e.target.value)} /></label><label><input type="checkbox" checked={follow} disabled={locked} onChange={e => setFollow(e.target.checked)} />跟随 Follow</label><label><input type="checkbox" checked={previous} disabled={locked} onChange={e => setPrevious(e.target.checked)} />上次实例 Previous</label></>}
      {mode === 'exec' && <label>Shell<select value={shell} disabled={locked} onChange={e => setShell(e.target.value)}><option>/bin/sh</option><option>/bin/bash</option><option>/bin/ash</option><option>powershell.exe</option><option>cmd.exe</option></select></label>}{mode === 'files' && <label>目录 Path<input aria-label="文件目录 Path" value={filePath} disabled={locked} onChange={e => setFilePath(e.target.value)} placeholder="/" /></label>}{mode === 'files' && <button disabled={locked || filePath === '/'} onClick={() => { const parent=filePath.split('/').slice(0,-1).join('/') || '/'; setFilePath(parent) }}>上级目录 Parent</button>}{mode === 'files' && <><label>文件 File<input aria-label="文件路径 File path" value={fileReadPath} disabled={locked} onChange={e => setFileReadPath(e.target.value)} placeholder="/etc/os-release" /></label><button disabled={locked || !fileReadPath.startsWith('/') || fileReadPath === '/'} onClick={() => void readFile()}>读取文件 Read</button></>}{mode === 'files' && fileContent !== null && <button onClick={() => { void navigator.clipboard.writeText(fileContent).then(() => setCopyStatus('已复制 / Copied')).catch(() => setCopyStatus('复制失败 / Copy failed')) }}>复制内容 Copy</button>}{mode === 'files' && fileContent !== null && <button disabled={locked} onClick={() => setPendingDelete(fileReadPath)}>删除文件 Delete</button>}{copyStatus && <span role="status">{copyStatus}</span>}{mode === 'files' && fileContent !== null && <button onClick={() => { const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([fileContent], {type:'text/plain;charset=utf-8'})); a.download=fileReadPath.split('/').pop() || 'file'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000) }}>下载 Download</button>}
      {mode === 'forward' && <><label>本地端口 Local<input type="number" min="0" max="65535" disabled={locked} value={localPort} onChange={e => setLocalPort(Number(e.target.value))} /></label><label>远端端口 Remote<input type="number" min="1" max="65535" list="k8s-declared-ports" disabled={locked} value={remotePort} onChange={e => setRemotePort(Number(e.target.value))} /><datalist id="k8s-declared-ports">{[...new Set(declaredPorts)].map(p => <option key={p} value={p} />)}</datalist></label></>}
      {mode === 'files' && <><button disabled={locked} onClick={() => uploadInput.current?.click()}>上传文本 Upload text</button><input ref={uploadInput} type="file" aria-label="上传文本文件 Upload text file" hidden onChange={e => { const f=e.target.files?.[0]; if (f) void uploadFile(f); e.currentTarget.value='' }} /></>}<button disabled={locked || (mode === 'logs' && (!Number.isInteger(tail) || tail < 0 || (since !== '' && (!Number.isInteger(Number(since)) || Number(since) < 0)))) || (mode === 'forward' && (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535 || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535))} onClick={() => void start()}>{mode === 'logs' ? '读取日志 Read logs' : mode === 'exec' ? '连接终端 Connect' : mode === 'files' ? '浏览文件 Browse files' : '开始转发 Start'}</button>
      <button disabled={!locked} onClick={stop}>停止 Stop</button>
    </div>
    <div role="status" className="k8s-session-status">{status}</div>{mode === 'files' && <div className="k8s-file-entries" role="list">{fileEntries.map(entry => <button role="listitem" key={entry.path} onClick={() => entry.type === 'directory' ? setFilePath(entry.path) : setFileReadPath(entry.path)} title={entry.path}>{entry.type === 'directory' ? '📁 ' : '📄 '}{entry.path}</button>)}{!fileEntries.length && <span>暂无条目 / No entries</span>}</div>}
    {error && <div role="alert" className="k8s-session-error">{error}</div>}
    {mode === 'files' && <p className="k8s-session-hint">可浏览、读取和删除文件；上传限 256 KiB UTF-8 文本，同名文件会被拒绝。 / Upload UTF-8 text up to 256 KiB; existing files are not overwritten.</p>}{mode === 'exec' && <p className="k8s-session-hint">点击连接后启动容器内 Shell，使用当前连接的 pods/exec 权限。关闭面板会结束会话。 / Connect starts a container shell.</p>}
    {mode !== 'forward' ? <><div className="k8s-session-search"><input aria-label="搜索输出 Search output" placeholder="搜索输出 / Search output" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') searchAddon.current?.findNext(search) }} /><button onClick={() => searchAddon.current?.findNext(search)}>查找 Find</button><button onClick={() => terminal.current?.clear()}>清屏 Clear</button><span>最多保留 5000 行 / 5000 lines</span></div><div className="k8s-terminal" ref={terminalElement} /></> : <><p className="k8s-session-hint">仅监听 127.0.0.1；本地端口 0 自动分配。此面板创建的转发会在关闭面板时结束。 / Local port 0 selects a free port.</p><h4>当前连接的转发 / Connection forwards</h4>{!forwards.length && <p>暂无端口转发 / No forwards</p>}<ul className="k8s-forward-list">{forwards.map(f => <li key={f.sessionId}><code>{f.sessionId.slice(0, 8)}</code><span>{f.closed ? '已结束 / Closed' : f.ready ? '就绪 / Ready' : '连接中 / Connecting'}</span>{f.ports?.map(p => <code key={`${p.Local}:${p.Remote}`}>127.0.0.1:{p.Local} → {p.Remote}</code>)}{f.error && <span role="alert">{f.error}</span>}<button onClick={async () => { try { if (live.current?.id === f.sessionId) stop(); else await rpc.current('port-forward/close', { sessionId: f.sessionId }); ownedForwards.current.delete(f.sessionId); await refreshForwards() } catch (e) { setError(String(e)) } }}>关闭 Close</button></li>)}</ul></>}
  </section>
}
