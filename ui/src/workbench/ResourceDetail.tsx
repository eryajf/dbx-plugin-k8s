import { useEffect, useState } from 'react'
import { dump } from 'js-yaml'
import type { Invoke, KubeObject, ResourceType } from './types'
import { redactObject, ResourceEditor } from './ResourceEditor'
import './detail.css'
import { ResourceActions } from './ResourceActions'

type Props = { resource: ResourceType; object: KubeObject; invoke: Invoke; onClose: () => void; onChanged: () => void; connectionLabel?: string }
type Link = { group: string; version: string; resource: string; kind: string; name: string; namespace: string; reason: string; direction: string }
type Inspection = { events?: { items?: KubeObject[] }; warnings?: string[] }
type History = { resourceVersion: string; items: KubeObject[] }
function errorText(e: unknown) { return e instanceof Error ? e.message : String(e) }
function Pairs({ value }: { value?: Record<string, unknown> }) {
  return <dl className="kd-pairs">{Object.entries(value ?? {}).map(([key, entry]) => <div key={key}><dt>{key}</dt><dd>{entry === undefined || entry === null ? '—' : typeof entry === 'object' ? JSON.stringify(entry) : String(entry)}</dd></div>)}</dl>
}
export function ResourceDetail({ resource, object, invoke, onClose, onChanged, connectionLabel = '当前连接' }: Props) {
  const [tab, setTab] = useState('概要')
  const [revealed, setRevealed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [inspection, setInspection] = useState<Inspection>()
  const [related, setRelated] = useState<{ items: Link[]; warnings?: string[] }>()
  const [linked, setLinked] = useState<{ resource: ResourceType; object: KubeObject }>()
  const [history, setHistory] = useState<History>()
  const [rollbackRevision, setRollbackRevision] = useState('')
  const [copied, setCopied] = useState('')
  const params = { group: resource.group, version: resource.version, resource: resource.resource, namespace: object.metadata.namespace ?? '', name: object.metadata.name }
  useEffect(() => { setTab('概要'); setRevealed(false); setInspection(undefined); setRelated(undefined); setError(''); setLinked(undefined); setDeleting(false); setConfirm('') }, [object.metadata.uid, resource.resource, object.metadata.name])
  useEffect(() => {
    if (tab !== '事件' && tab !== '关联资源' && tab !== '历史') return
    let active = true
    setBusy(true); setError('')
    const request = tab === '事件' ? invoke<Inspection>('resource/describe', params).then(data => { if (active) setInspection(data) }) : tab === '关联资源' ? invoke<{ items: Link[]; warnings?: string[] }>('resource/related', params).then(data => { if (active) setRelated(data) }) : invoke<History>('workload/history', params).then(data => { if (active) setHistory(data) })
    request.catch(e => { if (active) setError(errorText(e)) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [tab, object.metadata.uid, object.metadata.resourceVersion, invoke])
  const safe = revealed ? object : redactObject(object)
  const podSpec = object.spec?.template?.spec ?? object.spec
  const containers = [...(podSpec?.initContainers ?? []), ...(podSpec?.containers ?? []), ...(podSpec?.ephemeralContainers ?? [])]
  const statuses = [...(object.status?.initContainerStatuses ?? []), ...(object.status?.containerStatuses ?? []), ...(object.status?.ephemeralContainerStatuses ?? [])]
  const events = [...(inspection?.events?.items ?? [])].sort((a, b) => String(b.lastTimestamp ?? b.eventTime ?? b.metadata.creationTimestamp).localeCompare(String(a.lastTimestamp ?? a.eventTime ?? a.metadata.creationTimestamp)))
  async function remove() {
    if (confirm !== object.metadata.name) return
    setBusy(true); setError('')
    try { await invoke('resource/delete', { ...params, uid: object.metadata.uid, resourceVersion: object.metadata.resourceVersion }); onChanged(); onClose() }
    catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }
  async function openLink(link: Link) {
    setBusy(true); setError('')
    try { const result = await invoke<KubeObject>('resource/get', { group: link.group, version: link.version, resource: link.resource, namespace: link.namespace, name: link.name }); setLinked({ object: result, resource: { ...link, namespaced: Boolean(link.namespace), verbs: [] } }) }
    catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }
  if (linked) return <ResourceDetail {...linked} invoke={invoke} connectionLabel={connectionLabel} onChanged={onChanged} onClose={() => setLinked(undefined)}/>
  return <section className="kd-detail" aria-label={`${resource.kind} ${object.metadata.name}`}>
    <header><div><small>{resource.kind} · {object.metadata.namespace || '集群级'}</small><h2>{object.metadata.name}</h2></div><div className="kd-actions"><button disabled={busy} onClick={() => setEditing(true)}>编辑 YAML</button><ResourceActions resource={resource} object={object} invoke={invoke} onChanged={onChanged} connectionLabel={connectionLabel}/><button disabled={busy} className="kd-danger" onClick={() => setDeleting(true)}>删除</button><button onClick={onClose}>返回列表</button></div></header>
    <nav className="kd-tabs" aria-label="资源详情标签">{['概要', 'YAML', 'JSON', '事件', '关联资源', ...(resource.resource === 'deployments' ? ['历史'] : [])].map(name => <button key={name} aria-current={tab === name ? 'page' : undefined} onClick={() => setTab(name)}>{name}</button>)}</nav>
    {resource.resource === 'secrets' && <div className="kd-notice">Secret 内容{revealed ? '已显示，仅保留在当前会话' : '默认隐藏'}。<button onClick={() => setRevealed(!revealed)}>{revealed ? '隐藏内容' : '显示内容'}</button></div>}
    {error && <p className="kd-error" role="alert">{error}</p>}
    {tab === '概要' && <div className="kd-sections">
      <article><h3>基本信息</h3><Pairs value={{ '集群': connectionLabel, '名称': object.metadata.name, '命名空间': object.metadata.namespace ?? '集群级', 'API': object.apiVersion, 'UID': object.metadata.uid, '资源版本': object.metadata.resourceVersion, '创建时间': object.metadata.creationTimestamp, '状态': object.status?.phase, '节点': podSpec?.nodeName, 'Pod IP': object.status?.podIP }}/></article>
      <article><h3>标签</h3><Pairs value={safe.metadata.labels}/>{!Object.keys(safe.metadata.labels ?? {}).length && <p>无标签</p>}<h3>注解</h3><Pairs value={safe.metadata.annotations}/></article>
      {object.status?.conditions && <article className="kd-wide"><h3>状态条件</h3><table><thead><tr><th>条件</th><th>状态</th><th>原因</th><th>消息</th><th>变更时间</th></tr></thead><tbody>{object.status.conditions.map((condition: Record<string, string>, i: number) => <tr key={i}><td>{condition.type}</td><td>{condition.status}</td><td>{condition.reason}</td><td>{condition.message}</td><td>{condition.lastTransitionTime}</td></tr>)}</tbody></table></article>}
      {containers.length > 0 && <article className="kd-wide"><h3>容器</h3><table><thead><tr><th>名称</th><th>镜像</th><th>Ready</th><th>重启</th><th>状态</th><th>探针配置</th></tr></thead><tbody>{containers.map((container: Record<string, any>) => { const status = statuses.find((s: Record<string, any>) => s.name === container.name); return <tr key={container.name}><td>{container.name}</td><td>{container.image}</td><td>{status ? String(status.ready) : '—'}</td><td>{status?.restartCount ?? '—'}</td><td>{status ? JSON.stringify(status.state) : '—'}</td><td>{['readinessProbe', 'livenessProbe', 'startupProbe'].filter(p => container[p]).join(', ') || '未配置'}</td></tr> })}</tbody></table></article>}
      {(safe.data || safe.stringData) && <article className="kd-wide"><h3>数据</h3><Pairs value={{ ...safe.data, ...safe.stringData }}/></article>}
      {object.spec && !containers.length && <article className="kd-wide"><h3>资源配置</h3><pre>{dump(safe.spec, { lineWidth: 100 })}</pre></article>}
      {object.metadata.ownerReferences?.length ? <article><h3>所有者</h3><Pairs value={Object.fromEntries(object.metadata.ownerReferences.map(ref => [`${ref.kind}/${ref.name}`, ref.uid]))}/></article> : null}
      <details className="kd-wide"><summary>ManagedFields</summary><pre>{JSON.stringify(object.metadata.managedFields ?? [], null, 2)}</pre></details>
    </div>}
    {tab === 'YAML' && <><div className="kd-document-actions"><button onClick={async () => { try { await navigator.clipboard.writeText(dump(safe, { noRefs: true, lineWidth: 120 })); setCopied('YAML'); setTimeout(() => setCopied(''), 1500) } catch (e) { setError(errorText(e)) } }}>复制 YAML</button>{copied === 'YAML' && <span role="status">已复制</span>}</div><pre className="kd-document">{dump(safe, { noRefs: true, lineWidth: 120 })}</pre></>}
    {tab === 'JSON' && <><div className="kd-document-actions"><button onClick={async () => { try { await navigator.clipboard.writeText(JSON.stringify(safe, null, 2)); setCopied('JSON'); setTimeout(() => setCopied(''), 1500) } catch (e) { setError(errorText(e)) } }}>复制 JSON</button>{copied === 'JSON' && <span role="status">已复制</span>}</div><pre className="kd-document">{JSON.stringify(safe, null, 2)}</pre></>}
    {tab === '事件' && <div>{busy && <p>正在读取事件…</p>}{inspection?.warnings?.map(w => <p className="kd-notice" key={w}>{w}</p>)}{!busy && !events.length && <p>没有可显示的事件。</p>}<ol className="kd-timeline">{events.map((event, i) => <li key={event.metadata.uid ?? i}><strong>{event.type} · {event.reason}</strong><time>{event.lastTimestamp ?? event.eventTime ?? event.metadata.creationTimestamp}</time><p>{event.message}</p><small>次数：{event.count ?? 1} · 来源：{event.source?.component ?? event.reportingController ?? '—'}</small></li>)}</ol></div>}
    {tab === '关联资源' && <div>{busy && <p>正在解析资源关系…</p>}{related?.warnings?.map(w => <p className="kd-notice" key={w}>{w}</p>)}{!busy && !related?.items.length && <p>没有发现关联资源。</p>}<div className="kd-links">{related?.items.map(link => <button key={`${link.group}/${link.resource}/${link.namespace}/${link.name}`} disabled={busy} onClick={() => openLink(link)}><small>{link.direction} · {link.reason}</small><strong>{link.kind} / {link.name}</strong><span>{link.namespace || '集群级'}</span></button>)}</div></div>}
    {tab === '历史' && <div>{busy && <p>正在读取发布历史…</p>}{!busy && !history?.items.length && <p>没有可用的发布历史。</p>}<div className="kd-links">{history?.items.map(item => <article key={item.metadata.uid}><h3>修订 {item.metadata.annotations?.['deployment.kubernetes.io/revision'] || '—'}</h3><p>{item.metadata.annotations?.['kubernetes.io/change-cause'] || '无变更说明'}</p><button disabled={busy || !item.metadata.annotations?.['deployment.kubernetes.io/revision']} onClick={async () => { if (!window.confirm(`回滚到修订 ${item.metadata.annotations?.['deployment.kubernetes.io/revision']}？`)) return; setBusy(true); try { await invoke('workload/rollback', { ...params, revision: item.metadata.annotations?.['deployment.kubernetes.io/revision'], resourceVersion: history.resourceVersion }); setRollbackRevision(item.metadata.annotations?.['deployment.kubernetes.io/revision'] || ''); onChanged() } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }}>回滚</button></article>)}</div>{rollbackRevision && <p role="status">已提交回滚到修订 {rollbackRevision}</p>}</div>}
    {editing && <ResourceEditor resource={resource} object={object} namespace={object.metadata.namespace ?? ''} invoke={invoke} connectionLabel={connectionLabel} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged() }}/ >}
    {deleting && <div className="kd-overlay" role="dialog" aria-modal="true" aria-label="确认删除资源"><section className="kd-confirm"><h2>删除 {resource.kind}</h2><Pairs value={{ '集群': connectionLabel, '命名空间': object.metadata.namespace || '集群级', '名称': object.metadata.name, 'UID': object.metadata.uid }}/><p>删除可能同时清理其从属资源。请输入资源名称确认。</p><input aria-label="输入资源名称确认删除" value={confirm} onChange={e => setConfirm(e.target.value)}/>{error && <p className="kd-error">{error}</p>}<footer><button disabled={busy} onClick={() => { setDeleting(false); setConfirm('') }}>取消</button><button className="kd-danger" disabled={busy || confirm !== object.metadata.name || !object.metadata.uid || !object.metadata.resourceVersion} onClick={remove}>确认删除</button></footer></section></div>}
  </section>
}
