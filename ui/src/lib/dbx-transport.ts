import { load, dump } from 'js-yaml'
import { dispatchDBXFiles } from './dbx-files'
import { resolveDBXResource } from './dbx-resource-discovery'
export type DBXInvoke = (method: string, params: Record<string, unknown>) => Promise<unknown>
type ObjectData = { apiVersion?: string; kind?: string; metadata?: { name?: string; namespace?: string; uid?: string; resourceVersion?: string }; [key: string]: unknown }
type Favorite = { resource: { resource: string; group: string }; object: ObjectData }

/** Explicit REST-to-RPC boundary. Unknown actions fail rather than becoming resource writes. */
export class DBXTransport {
  readonly invoke: DBXInvoke
  readonly connectionId: string
  constructor(invoke: DBXInvoke, connectionId: string) { this.invoke = invoke; this.connectionId = connectionId }
  rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.invoke(method, { ...params, connectionId: this.connectionId }) as Promise<T>
  }
  async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    return await this.dispatch(path, method, body) as T
  }
  private async dispatch(path: string, method: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, 'http://dbx.local')
    const parts = url.pathname.replace(/^\/api\/v1\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
    const query = Object.fromEntries(url.searchParams)
    const data = (body ?? {}) as Record<string, unknown>
    if (parts[0] === 'preferences') {
      if (parts[1] !== 'favorites') {
        const key = `dbx:kite:${this.connectionId}:preference:${parts[1]}`
        if (method === 'GET') return JSON.parse(localStorage.getItem(key) || (parts[1] === 'sidebar' ? '{"sidebar_preference":""}' : '{}'))
        localStorage.setItem(key, JSON.stringify(body)); return body
      }
      const asFavorite = (f: Favorite, id: number) => ({ id, clusterName: this.connectionId, resourceType: f.resource.resource === 'customresourcedefinitions' ? 'crds' : f.resource.resource, resourceName: f.object.metadata?.name, namespace: f.object.metadata?.namespace, createdAt: '', updatedAt: '' })
      if (method === 'GET') {
        const result = await this.rpc<{items: Favorite[]}>('favorite/list')
        return result.items.map(asFavorite)
      }
      const resource = await resolveDBXResource(this.connectionId, String(data.resourceType), this.invoke)
      const item = {resource, object: { apiVersion: resource.group ? `${resource.group}/${resource.version}` : resource.version, kind: resource.kind, metadata: {name: data.resourceName, namespace: data.namespace || undefined}}}
      await this.rpc('favorite/update', {item, remove: parts[2] === 'remove'})
      return asFavorite(item as Favorite, 0)
    }
    if (parts[0] === 'search') {
      const result = await this.rpc<{items: Array<{uid: string; name: string; namespace: string; resource: string}>; warnings: string[]; truncated: boolean}>('resource/search', {query: query.q || query.query, namespace: query.namespace, limit: Number(query.limit || 50)})
      return {results: result.items.map(item => ({id: item.uid, name: item.name, namespace: item.namespace, resourceType: item.resource, createdAt: ''})), total: result.items.length, warnings: result.warnings, truncated: result.truncated}
    }
    if (parts[0] === 'resources' && parts[1] === 'apply') {
      const object = load(String(data.yaml)) as ObjectData
      if (!object?.kind || !object?.apiVersion) throw new Error('YAML 必须包含 apiVersion 和 kind')
      const resource = await resolveDBXResource(this.connectionId, object.kind, this.invoke)
      const result = await this.rpc<ObjectData>('resource/apply', {...resource, name: object.metadata?.name, namespace: object.metadata?.namespace, object})
      return {message: 'Applied', kind: result.kind, name: result.metadata?.name, namespace: result.metadata?.namespace}
    }
    if (parts[0] === 'events' && parts[1] === 'resources') return this.rpc('resource/list', {group: '', version: 'v1', resource: 'events', namespace: query.namespace, fieldSelector: `involvedObject.name=${query.name}`})
    if (parts[0] === 'discover') return this.rpc('kube/discover')
    if (parts[0] === 'cluster-info') return this.rpc('kube/cluster-info')
    if (parts[0] === 'namespaces' && parts.length === 1) return this.rpc('kube/namespaces')
    if (parts[0] === 'overview') return this.overview()
    if (parts[0] === 'prometheus') {
      if (parts[1] === 'resource-usage-history') return this.rpc('prometheus/resource-usage-history', {duration: query.duration || '30m', instance: query.instance})
      if (parts[1] === 'pods' && parts[2] && parts[3] && parts[4] === 'metrics') return this.rpc('prometheus/pods-metrics', {namespace: parts[2], name: parts[3], duration: query.duration || '1h', container: query.container, labelSelector: query.labelSelector})
    }
    if (['settings', 'version', 'admin', 'templates', 'auth', 'license'].includes(parts[0])) throw new Error(`DBX 尚未提供此能力：${url.pathname}`)
    const resource = await resolveDBXResource(this.connectionId, parts[0], this.invoke)
    const namespace = resource.namespaced && parts[1] !== '_all' ? parts[1] : undefined
    const name = parts[2] || (!resource.namespaced && parts[1] !== '_all' ? parts[1] : undefined)
    const params: Record<string, unknown> = { ...resource, namespace, name, ...query, limit: query.limit ? Number(query.limit) : undefined }
    const action = parts[3]
    if (action) {
      if (action === 'files' && resource.resource === 'pods') return dispatchDBXFiles((m,p)=>this.rpc(m,p),params,parts[4],method,body)
      if (['cordon', 'uncordon', 'drain'].includes(action) && resource.resource === 'nodes') return this.rpc(`node/${action}`, {...params, ...data, ignoreDaemonSets: data.ignoreDaemonsets})
      if (['scale', 'restart', 'history', 'rollback'].includes(action)) return this.rpc(`workload/${action}`, {...params, ...data})
      if (['trigger', 'suspend'].includes(action) && resource.resource === 'cronjobs') return this.rpc(`cronjob/${action}`, {...params, ...data})
      if (action === 'describe') {
        const result = await this.rpc<{object: ObjectData; events?: unknown; warnings?: string[]}>('resource/describe', params)
        return {result: dump(result)}
      }
      if (action === 'related') {
        const result = await this.rpc<{items: Array<{resource: string; name: string; namespace: string; group: string; version: string; reason: string; direction: string}>}>('resource/related', params)
        return result.items.map(item => ({type: item.resource, name: item.name, namespace: item.namespace, apiVersion: item.group ? `${item.group}/${item.version}` : item.version, reason: item.reason, direction: item.direction === 'owns' ? 'referencedBy' : 'references'}))
      }
      if (action === 'taint' || action === 'untaint') {
        const object = await this.rpc<ObjectData>('resource/get', params)
        const spec = (object.spec || {}) as {taints?: Array<Record<string, unknown>>}
        const taints = (spec.taints || []).filter(t => !(t.key === data.key && (action === 'untaint' || t.effect === data.effect)))
        if (action === 'taint') taints.push(data)
        return this.rpc('resource/patch', {...params, patch: {metadata: {resourceVersion: object.metadata?.resourceVersion}, spec: {taints}}})
      }
      throw new Error(`DBX 尚未适配操作：${url.pathname}`)
    }
    if (method === 'GET') return this.rpc(name ? 'resource/get' : 'resource/list', params)
    if (method === 'DELETE') {
      const object = await this.rpc<ObjectData>('resource/get', params)
      return this.rpc('resource/delete', {...params, uid: object.metadata?.uid, resourceVersion: object.metadata?.resourceVersion})
    }
    if (method === 'PATCH') return this.rpc('resource/patch', {...params, patch: body})
    if (method === 'PUT') return this.rpc('resource/update', {...params, object: body})
    if (method === 'POST') return this.rpc('resource/create', {...params, object: body})
    throw new Error(`Unsupported method: ${method}`)
  }
  private async overview() {
    const [summary, services, pods] = await Promise.all([
      this.rpc<{nodes: number; readyNodes: number; pods: number; namespaces: number; prometheusEnabled?: boolean; podPhases: Record<string, number>; allocatable: Record<string, string>}>('kube/overview'),
      this.rpc<{items: unknown[]}>('resource/list', {group: '', version: 'v1', resource: 'services'}),
      this.rpc<{items: Array<{spec?: {containers?: Array<{resources?: {requests?: Record<string, string>; limits?: Record<string, string>}}>}}>}>('resource/list', {group: '', version: 'v1', resource: 'pods'})
    ])
    const quantity = (value = '0') => { const n = parseFloat(value); const suffix = value.replace(/^[+-]?[\d.]+/, ''); return n * ({n: 1e-9, u: 1e-6, m: .001, k: 1e3, M: 1e6, G: 1e9, Ki: 1024, Mi: 1024**2, Gi: 1024**3, Ti: 1024**4}[suffix] ?? 1) }
    const resource = {cpu: {allocatable: quantity(summary.allocatable.cpu), requested: 0, limited: 0}, memory: {allocatable: quantity(summary.allocatable.memory), requested: 0, limited: 0}}
    for (const pod of pods.items) for (const container of pod.spec?.containers || []) for (const key of ['cpu', 'memory'] as const) { resource[key].requested += quantity(container.resources?.requests?.[key]); resource[key].limited += quantity(container.resources?.limits?.[key]) }
    resource.cpu.allocatable *= 1000; resource.cpu.requested *= 1000; resource.cpu.limited *= 1000
    return {totalNodes: summary.nodes, readyNodes: summary.readyNodes, totalPods: summary.pods, runningPods: summary.podPhases.Running || 0, totalNamespaces: summary.namespaces, totalServices: services.items.length, prometheusEnabled: Boolean(summary.prometheusEnabled), resource}
  }
}
export function getDBXTransport(connectionId?: string): DBXTransport | null {
  const bridge = (globalThis as unknown as {dbxPlugin?: {invoke: DBXInvoke; context?: {connectionId?: string}}}).dbxPlugin
  const id = connectionId || bridge?.context?.connectionId
  return bridge && id ? new DBXTransport((method, params) => bridge.invoke(method, params), id) : null
}
