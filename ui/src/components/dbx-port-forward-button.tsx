import { useEffect, useRef, useState } from 'react'
import { Cable } from 'lucide-react'
import { getDBXTransport } from '@/lib/dbx-transport'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogHeader, DialogFooter } from './ui/dialog'
type Frame = {sessionId: string; ready?: boolean; closed?: boolean; error?: string; ports?: Array<{Local:number; Remote:number}>}
export function DBXPortForwardButton({resource, namespace, name}: {resource:'pods'|'services'|'deployments'; namespace:string; name:string}) {
  const [open,setOpen] = useState(false), [local,setLocal] = useState('0'), [remote,setRemote] = useState('8080')
  const [frame,setFrame] = useState<Frame | null>(null), [error,setError] = useState(''), [busy,setBusy] = useState(false)
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])
  const close = () => {stop.current?.(); stop.current = null; setFrame(null); setBusy(false)}
  const start = async () => {
    const transport = getDBXTransport(); if (!transport) return
    if (!/^\d+$/.test(local) || !/^\d+$/.test(remote) || +local > 65535 || +remote < 1 || +remote > 65535) {setError('请输入有效端口，本地端口可填 0 自动分配');return}
    close(); setError(''); setBusy(true)
    let active = true, sessionId = '', closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {active = false; clearTimeout(timer); if (sessionId && !closed) {closed = true; void transport.rpc('port-forward/close',{sessionId}).catch(() => {})}}
    stop.current = cleanup
    try {
      const opened = await transport.rpc<Frame>('port-forward/open',{resource,namespace,name,ports:[`${local}:${remote}`]})
      sessionId = opened.sessionId
      if (!active) {cleanup();return}
      if (!sessionId) throw new Error('转发未返回会话 ID')
      const poll = async (next?: Frame) => {
        try {
          const value = next || await transport.rpc<Frame>('session/read',{sessionId})
          if (!active) return
          setFrame(value); setBusy(!value.ready)
          if (value.error || value.closed) throw new Error(value.error || '端口转发已结束')
          timer = setTimeout(() => {void poll()}, 1000)
        } catch (reason) {if (active) {setError(String(reason));setBusy(false)} cleanup()}
      }
      await poll(opened)
    } catch (reason) {if (active) {setError(String(reason));setBusy(false)} cleanup()}
  }
  return <><Button variant="outline" size="sm" onClick={() => setOpen(true)}><Cable className="size-4"/>端口转发</Button>
    <Dialog open={open} onOpenChange={value => {setOpen(value); if (!value) close()}}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>端口转发</DialogTitle><DialogDescription>{namespace}/{name} · 仅监听 127.0.0.1，关闭面板将停止转发。</DialogDescription></DialogHeader>
      <div className="grid grid-cols-2 gap-4"><Label>本地端口<Input inputMode="numeric" value={local} disabled={!!frame} onChange={e => setLocal(e.target.value)}/></Label><Label>远端端口<Input inputMode="numeric" value={remote} disabled={!!frame} onChange={e => setRemote(e.target.value)}/></Label></div>
      {frame?.ports?.map(port => <p key={port.Local} className="font-mono text-sm">127.0.0.1:{port.Local} → {port.Remote}</p>)}
      {busy && <p role="status">正在连接…</p>}{error && <p role="alert" className="text-destructive text-sm">{error}</p>}
      <DialogFooter>{frame ? <Button variant="destructive" onClick={close}>停止转发</Button> : <Button disabled={busy} onClick={() => {void start()}}>开始转发</Button>}</DialogFooter>
    </DialogContent></Dialog></>
}
