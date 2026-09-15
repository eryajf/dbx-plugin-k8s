import { lazy, Suspense, useRef, useState } from 'react'
import { dump, load } from 'js-yaml'
import type { Invoke, KubeObject, ResourceType } from './types'
import './detail.css'

const Monaco = lazy(async () => {
  const [{ default: Editor, loader }, monaco, { default: Worker }] = await Promise.all([
    import('@monaco-editor/react'), import('monaco-editor'),
    import('monaco-editor/esm/vs/editor/editor.worker?worker'),
  ])
  ;(globalThis as typeof globalThis & { MonacoEnvironment?: unknown }).MonacoEnvironment = { getWorker: () => new Worker() }
  loader.config({ monaco })
  return { default: Editor }
})

export function redactObject(object: KubeObject): KubeObject {
  const copy = structuredClone(object)
  if (object.kind === 'Secret') {
    for (const field of ['data', 'stringData']) {
      if (copy[field]) copy[field] = Object.fromEntries(Object.keys(copy[field]).map(key => [key, '••••••']))
    }
    // kubectl's last-applied annotation can contain the entire Secret.
    if (copy.metadata.annotations) copy.metadata.annotations = Object.fromEntries(Object.keys(copy.metadata.annotations).map(key => [key, '••••••']))
  }
  return copy
}

type Props = { resource: ResourceType; object?: KubeObject; namespace: string; invoke: Invoke; onClose: () => void; onSaved: () => void; connectionLabel?: string }
export function ResourceEditor({ resource, object, namespace, invoke, onClose, onSaved, connectionLabel = '当前连接' }: Props) {
  const initial = structuredClone(object ?? { apiVersion: resource.group ? `${resource.group}/${resource.version}` : resource.version, kind: resource.kind, metadata: { name: '', ...(resource.namespaced ? { namespace } : {}) } })
  delete initial.status
  delete initial.metadata.managedFields
  const [text, setText] = useState(() => dump(initial, { noRefs: true, lineWidth: 120 }))
  const [revealed, setRevealed] = useState(resource.resource !== 'secrets')
  const [simple, setSimple] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ source: string; result: string; params: Record<string, unknown> }>()
  const revision = useRef(0)
  const change = (value: string) => { revision.current++; setText(value); setPreview(undefined); setError('') }
  async function validate() {
    setBusy(true); setError(''); setPreview(undefined)
    const rev = revision.current
    try {
      const parsed = load(text) as KubeObject
      if (!parsed || typeof parsed !== 'object' || !parsed.metadata?.name) throw new Error('请填写 metadata.name，并提供一个 YAML 资源。')
      if (object && parsed.metadata.resourceVersion !== object.metadata.resourceVersion) throw new Error('请保留原始 resourceVersion；冲突时关闭编辑器并刷新资源。')
      const params = { group: resource.group, version: resource.version, resource: resource.resource, namespace: resource.namespaced ? parsed.metadata.namespace ?? namespace : '', name: object?.metadata.name ?? parsed.metadata.name, yaml: text }
      const result = await invoke<KubeObject>(object ? 'resource/update' : 'resource/create', { ...params, dryRun: true })
      if (rev === revision.current) setPreview({ source: text, params, result: dump(result, { noRefs: true, lineWidth: 120 }) })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function save() {
    if (!preview || preview.source !== text) return
    setBusy(true); setError('')
    try { await invoke(object ? 'resource/update' : 'resource/create', { ...preview.params, dryRun: false }); onSaved() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setPreview(undefined) }
    finally { setBusy(false) }
  }
  return <div className="kd-overlay" role="dialog" aria-modal="true" aria-label="资源 YAML 编辑器">
    <section className="kd-editor"><header><h2>{object ? '编辑' : '创建'} {resource.kind}</h2><button onClick={onClose} disabled={busy}>关闭</button></header>
      <p>集群：{connectionLabel} · 命名空间：{resource.namespaced ? namespace || '请在 YAML 中指定' : '集群级'} · 资源：{object?.metadata.name ?? '新资源'}</p>
      {!revealed ? <div className="kd-notice">Secret 内容默认隐藏，仅在本次编辑会话展示。<button onClick={() => setRevealed(true)}>显示并编辑 Secret</button></div> : <>
        <div className="kd-actions"><button onClick={() => setSimple(!simple)}>{simple ? 'Monaco 编辑器' : '纯文本编辑器'}</button><span>先执行服务端预检，确认预览后保存；修改内容会使预检失效。</span></div>
        {simple ? <textarea className="kd-yaml" aria-label="YAML" value={text} onChange={e => change(e.target.value)} disabled={busy}/> : <Suspense fallback={<p>正在加载本地编辑器…</p>}><Monaco height="380px" language="yaml" theme="vs-dark" value={text} onChange={value => change(value ?? '')} options={{ readOnly: busy, minimap: { enabled: false }, automaticLayout: true, fontSize: 13 }}/></Suspense>}
        {preview && <div className="kd-preview"><h3>服务端预检结果（尚未保存）</h3><pre>{preview.result}</pre></div>}
        <footer><button onClick={validate} disabled={busy}>服务端预检 Dry-run</button><button className="kd-primary" onClick={save} disabled={busy || !preview || preview.source !== text}>{busy ? '处理中…' : '确认保存'}</button></footer>
      </>}
      {error && <p className="kd-error" role="alert">{error}</p>}
    </section>
  </div>
}
