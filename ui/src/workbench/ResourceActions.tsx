import { useState } from 'react'
import type { Invoke, KubeObject, ResourceType } from './types'

type Action = { method: string; label: string }
type Props = { resource: ResourceType; object: KubeObject; invoke: Invoke; onChanged: () => void; connectionLabel: string }

export function ResourceActions({ resource, object, invoke, onChanged, connectionLabel }: Props) {
  const [action, setAction] = useState<Action | null>(null)
  const [replicas, setReplicas] = useState(String(object.spec?.replicas ?? 1))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const actions: Action[] = []
  if (resource.group === 'apps') {
    if (['deployments', 'statefulsets', 'daemonsets'].includes(resource.resource)) actions.push({ method: 'workload/restart', label: '重启工作负载' })
    if (['deployments', 'statefulsets', 'replicasets'].includes(resource.resource)) actions.push({ method: 'workload/scale', label: '调整副本' })
  }
  if (resource.group === '' && resource.resource === 'nodes') actions.push(
    { method: object.spec?.unschedulable ? 'node/uncordon' : 'node/cordon', label: object.spec?.unschedulable ? '解除封锁' : '封锁节点' },
    { method: 'node/drain', label: '驱逐工作负载' },
  )
  if (resource.group === 'batch' && resource.resource === 'cronjobs') actions.push(
    { method: 'cronjob/trigger', label: '立即触发' },
    { method: 'cronjob/suspend', label: object.spec?.suspend ? '恢复调度' : '暂停调度' },
  )
  const scaling = action?.method === 'workload/scale'
  const validReplicas = /^\d+$/.test(replicas) && Number(replicas) <= 2147483647
  async function submit() {
    if (!action || busy || (scaling && !validReplicas)) return
    setBusy(true); setError('')
    try {
      await invoke(action.method, {
        group: resource.group, version: resource.version, resource: resource.resource,
        name: object.metadata.name, namespace: object.metadata.namespace ?? '',
        ...(scaling ? { replicas: Number(replicas), resourceVersion: object.metadata.resourceVersion } : {}),
        ...(action.method === 'cronjob/suspend' ? { suspend: !object.spec?.suspend } : {}),
        ...(action.method === 'node/drain' ? { force: false, ignoreDaemonSets: true, deleteLocalData: false } : {}),
      })
      setAction(null); onChanged()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <>
    {actions.map(item => <button key={item.method} disabled={busy} onClick={() => { setError(''); setReplicas(String(object.spec?.replicas ?? 1)); setAction(item) }}>{item.label}</button>)}
    {action && <div className="kd-overlay" role="dialog" aria-modal="true" aria-label={action.label}>
      <form className="kd-confirm" onSubmit={e => { e.preventDefault(); void submit() }}>
        <h2>{action.label}</h2><p>{connectionLabel} / {object.metadata.namespace || '集群级'} / {object.metadata.name}</p>
        {scaling && <label>目标副本数<input autoFocus aria-label="目标副本数" type="number" min="0" max="2147483647" step="1" disabled={busy} value={replicas} onChange={e => setReplicas(e.target.value)}/></label>}
        {scaling && !validReplicas && <p role="alert">请输入 0 至 2147483647 的整数。</p>}
        {action.method === 'node/drain' && <p>将封锁节点并驱逐可迁移的 Pod，保留 DaemonSet；存在无控制器 Pod 或 emptyDir 数据时会停止。成功驱逐后节点仍保持封锁。</p>}
        {action.method === 'cronjob/trigger' && <p>将基于当前 CronJob 创建一次性 Job。</p>}
        {action.method === 'workload/restart' && <p>将更新 Pod 模板以触发工作负载重启。</p>}
        {error && <p role="alert" className="kd-error">{error}</p>}
        <footer><button type="button" disabled={busy} onClick={() => setAction(null)}>取消</button><button type="submit" disabled={busy || (scaling && !validReplicas)}>{busy ? '处理中…' : '确认'}</button></footer>
      </form>
    </div>}
  </>
}
