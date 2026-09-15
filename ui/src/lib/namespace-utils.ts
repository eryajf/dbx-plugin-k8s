import type { Namespace, ResourceQuota } from 'kubernetes-types/core/v1'

type MetadataItems = Record<string, string>

export type NamespaceQuotaSummary = {
  cpuLimit: string
  memoryLimit: string
}

export type MetadataSummary = {
  primaryItems: string[]
  overflowCount: number
}

function normalizeMetadataItems(items?: MetadataItems | null) {
  return Object.entries(items || {}).sort(([left], [right]) =>
    left.localeCompare(right)
  )
}

export function formatMetadataSummaryItems(
  items?: MetadataItems | null,
  visibleCount = 1
): MetadataSummary {
  const entries = normalizeMetadataItems(items)
  return {
    primaryItems: entries
      .slice(0, visibleCount)
      .map(([key, value]) => `${key}=${value}`),
    overflowCount: Math.max(0, entries.length - visibleCount),
  }
}

export function getNamespaceQuotaSummary(
  quota?: ResourceQuota | null
): NamespaceQuotaSummary {
  const hard = quota?.status?.hard || quota?.spec?.hard || {}

  return {
    cpuLimit: String(hard?.['limits.cpu'] || ''),
    memoryLimit: String(hard?.['limits.memory'] || ''),
  }
}

export function getResourceQuotasForNamespace(
  namespace: Namespace,
  quotas: ResourceQuota[]
) {
  const namespaceName = namespace.metadata?.name
  if (!namespaceName) {
    return []
  }

  return quotas.filter((quota) => quota.metadata?.namespace === namespaceName)
}

export function findPrimaryResourceQuota(
  namespace: Namespace,
  quotas: ResourceQuota[]
) {
  const namespaceQuotas = getResourceQuotasForNamespace(namespace, quotas)

  if (namespaceQuotas.length !== 1) {
    return null
  }

  return namespaceQuotas[0]
}
