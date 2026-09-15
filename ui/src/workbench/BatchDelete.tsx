import { useEffect, useRef, useState } from 'react'
import type { Invoke, KubeObject, ResourceType } from './types'

type Props = {
  resource: ResourceType; objects: KubeObject[]; invoke: Invoke
  connectionLabel: string; zh: boolean; onDeleted: (uids: string[]) => void
}
type Result = { object: KubeObject; error?: string }
export function BatchDelete({ resource, objects, invoke, connectionLabel, zh, onDeleted }: Props) {
  const [targets, setTargets] = useState<KubeObject[] | null>(null)
  const [results, setResults] = useState<Result[] | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const t = (cn: string, en: string) => zh ? cn : en
  async function submit() {
    if (running.current || !targets?.length) return
    running.current = true; setBusy(true)
    const output: Result[] = []
    const deleted: string[] = []
    for (const object of targets) {
      // Stop sending further mutations if this resource page/connection closed.
      if (!alive.current) break
      try {
        if (!object.metadata.uid || !object.metadata.resourceVersion) throw new Error(t('资源标识不完整，请刷新后重试', 'Missing resource identity; refresh and retry'))
        await invoke('resource/delete', {
          group: resource.group, version: resource.version, resource: resource.resource,
          namespace: object.metadata.namespace || '', name: object.metadata.name,
          uid: object.metadata.uid, resourceVersion: object.metadata.resourceVersion,
        })
        deleted.push(object.metadata.uid); output.push({ object })
      } catch (e) { output.push({ object, error: e instanceof Error ? e.message : String(e) }) }
    }
    running.current = false
    if (!alive.current) return
    setBusy(false); setResults(output); onDeleted(deleted)
  }
  if (!resource.verbs.includes('delete')) return null
  return <>
    <button disabled={!objects.length || busy} onClick={() => {
      setTargets(objects.map(o => ({ ...o, metadata: { ...o.metadata } }))); setResults(null)
    }}>{t('删除所选', 'Delete selected')} ({objects.length})</button>
    {targets && <div className="wb-modal-backdrop"><section className="wb-search" role="alertdialog" aria-modal="true" aria-label={t('批量删除资源', 'Delete selected resources')}>
      <h2>{t('批量删除资源', 'Delete selected resources')}</h2>
      <p>{connectionLabel} / {resource.kind} · {targets.length}</p>
      <p>{t('删除会影响这些资源及其依赖工作负载。请核对集群、命名空间和名称。', 'Deletion affects these resources and dependent workloads. Check the cluster, namespaces and names.')}</p>
      <ul>{(results || targets.map(object => ({ object } as Result))).map(({ object, error }) => <li key={object.metadata.uid}>
        <code>{object.metadata.namespace || 'cluster'}/{object.metadata.name}</code>
        {results && <span>{error ? ` — ${error}` : t(' — 删除请求已接受', ' — Deletion accepted')}</span>}
      </li>)}</ul>
      {busy && <p role="status">{t('正在逐项删除…', 'Deleting resources…')}</p>}
      {results && <p role="status">{t('成功', 'Accepted')}: {results.filter(r => !r.error).length} · {t('失败', 'Failed')}: {results.filter(r => r.error).length}</p>}
      <button disabled={busy} onClick={() => setTargets(null)}>{results ? t('关闭', 'Close') : t('取消', 'Cancel')}</button>
      {!results && <button disabled={busy} onClick={() => void submit()}>{t('确认删除', 'Confirm deletion')}</button>}
    </section></div>}
  </>
}
