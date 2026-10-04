export interface DBXResourceDescriptor { group: string; version: string; resource: string; namespaced: boolean; kind?: string; verbs?: string[]; aliases?: string[] }
type Invoke = (method: string, params: Record<string, unknown>) => Promise<unknown>
type Discovery = { resources?: Array<DBXResourceDescriptor & { aliases?: string[] }> }
const cache = new Map<string, Promise<DBXResourceDescriptor[]>>()

// Kubernetes may expose several served versions for one built-in resource.
// Classify by the well-known API group so an unlisted built-in resource does
// not accidentally receive a custom-resource route.
const BUILTIN_API_GROUPS = new Set([
  '', 'apps', 'batch', 'networking.k8s.io', 'discovery.k8s.io',
  'rbac.authorization.k8s.io', 'storage.k8s.io', 'autoscaling', 'metrics.k8s.io',
  'gateway.networking.k8s.io', 'apiextensions.k8s.io', 'coordination.k8s.io',
  'policy', 'certificates.k8s.io', 'scheduling.k8s.io', 'flowcontrol.apiserver.k8s.io',
  'admissionregistration.k8s.io', 'authentication.k8s.io', 'authorization.k8s.io',
  'apiregistration.k8s.io', 'node.k8s.io', 'resource.k8s.io',
])

export interface DBXResourceIdentity {
  resourceType: string
  customResource: boolean
}

export function getDBXResourceIdentity(
  resource: Pick<DBXResourceDescriptor, 'group' | 'version' | 'resource'>
): DBXResourceIdentity {
  const group = resource.group.trim()
  const name = resource.resource.trim()
  const customResource = Boolean(group) && !BUILTIN_API_GROUPS.has(group)
  return {
    resourceType: customResource ? `${name}.${group}` : name,
    customResource,
  }
}

/**
 * Resolve the route identity used by a CRD page from the CRD's canonical
 * group and plural name. Optional Kubernetes API groups (for example the
 * Gateway API) are intentionally mapped to their dedicated built-in route.
 */
export function getDBXResourceIdentityForCRD(resource: {
  group: string
  plural: string
  version?: string
}): DBXResourceIdentity {
  return getDBXResourceIdentity({
    group: resource.group,
    version: resource.version || '',
    resource: resource.plural,
  })
}

export function getDBXResourcePath(
  resource: { resourceType: string; namespace?: string; name: string; customResource?: boolean; group?: string; version?: string }
): string {
  const customResource = resource.customResource ?? resource.resourceType.includes('.')
  const prefix = customResource ? `/crds/${resource.resourceType}` : `/${resource.resourceType}`
  const path = [prefix, resource.namespace, resource.name]
    .filter((segment): segment is string => Boolean(segment))
    .map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
    .join('/')
  const query = new URLSearchParams()
  if (resource.group !== undefined) query.set('group', resource.group)
  if (resource.version !== undefined) query.set('version', resource.version)
  return query.toString() ? `${path}?${query.toString()}` : path
}

export async function resolveDBXResource(
  connectionId: string,
  resource: string,
  invoke: Invoke,
  preferred?: { group?: string; version?: string }
): Promise<DBXResourceDescriptor> {
  if (!connectionId || !resource) throw new Error('connectionId and resource are required')
  let pending = cache.get(connectionId)
  if (!pending) {
    pending = invoke('kube/discover', { connectionId }).then(raw => {
      const list = (raw as Discovery)?.resources
      if (!Array.isArray(list)) throw new Error('invalid Kubernetes discovery response')
      return list
    })
    cache.set(connectionId, pending)
  }
  let resources: DBXResourceDescriptor[]
  try { resources = await pending } catch (error) { cache.delete(connectionId); throw error }
  resource = ({crds: 'customresourcedefinitions', hpa: 'horizontalpodautoscalers', pvc: 'persistentvolumeclaims', pv: 'persistentvolumes'} as Record<string,string>)[resource] || resource
  const found = resources.find(r => {
    if (preferred?.group !== undefined && preferred?.version !== undefined) {
      return r.group === preferred.group && r.version === preferred.version &&
        (r.resource === resource || `${r.resource}.${r.group}` === resource)
    }
    return (r.resource === resource || `${r.resource}.${r.group}` === resource) || r.aliases?.includes(resource) || r.kind?.toLowerCase() === resource.toLowerCase()
  })
  if (!found) throw new Error(`Kubernetes resource is not discovered: ${resource}`)
  return { group: found.group || '', version: found.version, resource: found.resource, namespaced: !!found.namespaced, kind: found.kind, verbs: found.verbs }
}
export function clearDBXResourceDiscovery(connectionId?: string): void { if (connectionId) cache.delete(connectionId); else cache.clear() }
