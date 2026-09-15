import type { ResourceQuota } from 'kubernetes-types/core/v1'

export type NamespaceResourceQuotaEntry = {
  key: string
  value: string
  isCustomKey: boolean
}

export type NamespaceResourceQuotaUnitOption = {
  value: string
  labelKey: string
}

type NamespaceResourceQuotaValueKind = 'count' | 'cpu' | 'memory' | 'custom'

const CPU_QUOTA_KEYS = new Set(['requests.cpu', 'limits.cpu'])
const MEMORY_QUOTA_KEYS = new Set([
  'requests.memory',
  'limits.memory',
  'requests.storage',
  'requests.ephemeral-storage',
  'limits.ephemeral-storage',
])

const CPU_UNIT_OPTIONS: NamespaceResourceQuotaUnitOption[] = [
  { value: 'core', labelKey: 'namespaceEditDialog.unitCpuCore' },
  { value: 'm', labelKey: 'namespaceEditDialog.unitCpuMilliCore' },
]

const MEMORY_UNIT_OPTIONS: NamespaceResourceQuotaUnitOption[] = [
  { value: 'Ki', labelKey: 'namespaceEditDialog.unitKi' },
  { value: 'Mi', labelKey: 'namespaceEditDialog.unitMi' },
  { value: 'Gi', labelKey: 'namespaceEditDialog.unitGi' },
  { value: 'Ti', labelKey: 'namespaceEditDialog.unitTi' },
  { value: 'Pi', labelKey: 'namespaceEditDialog.unitPi' },
  { value: 'Ei', labelKey: 'namespaceEditDialog.unitEi' },
  { value: 'k', labelKey: 'namespaceEditDialog.unitK' },
  { value: 'M', labelKey: 'namespaceEditDialog.unitM' },
  { value: 'G', labelKey: 'namespaceEditDialog.unitG' },
  { value: 'T', labelKey: 'namespaceEditDialog.unitT' },
  { value: 'P', labelKey: 'namespaceEditDialog.unitP' },
  { value: 'E', labelKey: 'namespaceEditDialog.unitE' },
]

const COUNT_UNIT_OPTIONS: NamespaceResourceQuotaUnitOption[] = [
  { value: 'count', labelKey: 'namespaceEditDialog.unitCount' },
]

export const NAMESPACE_RESOURCE_QUOTA_KEY_OPTIONS = [
  { value: 'pods', labelKey: 'resourceQuotaKey.pods' },
  { value: 'services', labelKey: 'resourceQuotaKey.services' },
  {
    value: 'services.nodeports',
    labelKey: 'resourceQuotaKey.servicesNodePorts',
  },
  {
    value: 'services.loadbalancers',
    labelKey: 'resourceQuotaKey.servicesLoadBalancers',
  },
  { value: 'secrets', labelKey: 'resourceQuotaKey.secrets' },
  { value: 'configmaps', labelKey: 'resourceQuotaKey.configMaps' },
  {
    value: 'persistentvolumeclaims',
    labelKey: 'resourceQuotaKey.persistentVolumeClaims',
  },
  { value: 'requests.cpu', labelKey: 'resourceQuotaKey.requestsCpu' },
  { value: 'requests.memory', labelKey: 'resourceQuotaKey.requestsMemory' },
  {
    value: 'requests.storage',
    labelKey: 'resourceQuotaKey.requestsStorage',
  },
  {
    value: 'requests.ephemeral-storage',
    labelKey: 'resourceQuotaKey.requestsEphemeralStorage',
  },
  { value: 'limits.cpu', labelKey: 'resourceQuotaKey.limitsCpu' },
  { value: 'limits.memory', labelKey: 'resourceQuotaKey.limitsMemory' },
  {
    value: 'limits.ephemeral-storage',
    labelKey: 'resourceQuotaKey.limitsEphemeralStorage',
  },
  {
    value: 'count/deployments.apps',
    labelKey: 'resourceQuotaKey.countDeployments',
  },
  {
    value: 'count/statefulsets.apps',
    labelKey: 'resourceQuotaKey.countStatefulSets',
  },
  {
    value: 'count/daemonsets.apps',
    labelKey: 'resourceQuotaKey.countDaemonSets',
  },
  {
    value: 'count/replicasets.apps',
    labelKey: 'resourceQuotaKey.countReplicaSets',
  },
  { value: 'count/jobs.batch', labelKey: 'resourceQuotaKey.countJobs' },
  {
    value: 'count/cronjobs.batch',
    labelKey: 'resourceQuotaKey.countCronJobs',
  },
] as const

export type NamespaceResourceQuotaOption =
  (typeof NAMESPACE_RESOURCE_QUOTA_KEY_OPTIONS)[number]

export type NamespaceResourceQuotaGroupKey = 'compute' | 'storage' | 'other'

export const NAMESPACE_RESOURCE_QUOTA_GROUPS: Array<{
  key: NamespaceResourceQuotaGroupKey
  labelKey: string
  optionValues: string[]
}> = [
  {
    key: 'compute',
    labelKey: 'namespaceEditDialog.groupComputeResources',
    optionValues: [
      'requests.cpu',
      'requests.memory',
      'limits.cpu',
      'limits.memory',
      'requests.ephemeral-storage',
      'limits.ephemeral-storage',
    ],
  },
  {
    key: 'storage',
    labelKey: 'namespaceEditDialog.groupStorageResources',
    optionValues: ['persistentvolumeclaims', 'requests.storage'],
  },
  {
    key: 'other',
    labelKey: 'namespaceEditDialog.groupOtherResources',
    optionValues: [
      'pods',
      'services',
      'services.nodeports',
      'services.loadbalancers',
      'secrets',
      'configmaps',
      'count/deployments.apps',
      'count/statefulsets.apps',
      'count/daemonsets.apps',
      'count/replicasets.apps',
      'count/jobs.batch',
      'count/cronjobs.batch',
    ],
  },
]

const KNOWN_QUOTA_KEYS: ReadonlySet<string> = new Set(
  NAMESPACE_RESOURCE_QUOTA_KEY_OPTIONS.map((option) => option.value)
)

function getQuotaValueKind(key: string): NamespaceResourceQuotaValueKind {
  if (CPU_QUOTA_KEYS.has(key)) {
    return 'cpu'
  }

  if (MEMORY_QUOTA_KEYS.has(key)) {
    return 'memory'
  }

  if (KNOWN_QUOTA_KEYS.has(key)) {
    return 'count'
  }

  return 'custom'
}

export function getQuotaUnitOptions(
  key: string
): NamespaceResourceQuotaUnitOption[] {
  const kind = getQuotaValueKind(key)

  if (kind === 'cpu') {
    return CPU_UNIT_OPTIONS
  }

  if (kind === 'memory') {
    return MEMORY_UNIT_OPTIONS
  }

  if (kind === 'count') {
    return COUNT_UNIT_OPTIONS
  }

  return []
}

export function getDefaultQuotaUnit(key: string): string {
  const kind = getQuotaValueKind(key)

  if (kind === 'cpu') {
    return 'core'
  }

  if (kind === 'memory') {
    return 'Gi'
  }

  if (kind === 'count') {
    return 'count'
  }

  return ''
}

export function parseQuotaValue(
  key: string,
  value: string
): { amount: string; unit: string } {
  const trimmedValue = value.trim()
  const kind = getQuotaValueKind(key)

  if (!trimmedValue) {
    return {
      amount: '',
      unit: getDefaultQuotaUnit(key),
    }
  }

  if (kind === 'count') {
    return {
      amount: trimmedValue,
      unit: 'count',
    }
  }

  if (kind === 'cpu') {
    const match = trimmedValue.match(/^([0-9]*\.?[0-9]+)(m)?$/)
    if (match) {
      return {
        amount: match[1],
        unit: match[2] || 'core',
      }
    }
  }

  if (kind === 'memory') {
    const match = trimmedValue.match(
      /^([0-9]*\.?[0-9]+)(Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/
    )
    if (match) {
      return {
        amount: match[1],
        unit: match[2] || getDefaultQuotaUnit(key),
      }
    }
  }

  return {
    amount: trimmedValue,
    unit: getDefaultQuotaUnit(key),
  }
}

export function composeQuotaValue(
  key: string,
  amount: string,
  unit: string
): string {
  const trimmedAmount = amount.trim()
  if (!trimmedAmount) {
    return ''
  }

  const kind = getQuotaValueKind(key)

  if (kind === 'count') {
    return trimmedAmount
  }

  if (kind === 'cpu') {
    return unit === 'm' ? `${trimmedAmount}m` : trimmedAmount
  }

  if (kind === 'memory') {
    return `${trimmedAmount}${unit || getDefaultQuotaUnit(key)}`
  }

  return trimmedAmount
}

export function createEmptyQuotaEntry(): NamespaceResourceQuotaEntry {
  return {
    key: NAMESPACE_RESOURCE_QUOTA_KEY_OPTIONS[0].value,
    value: '',
    isCustomKey: false,
  }
}

export function createStandardQuotaEntries(
  hard: Record<string, string> = {}
): NamespaceResourceQuotaEntry[] {
  return NAMESPACE_RESOURCE_QUOTA_KEY_OPTIONS.map((option) => ({
    key: option.value,
    value: hard[option.value] || '',
    isCustomKey: false,
  }))
}

export function resourceQuotaToEntries(
  resourceQuota: ResourceQuota | null | undefined
): NamespaceResourceQuotaEntry[] {
  const hard = resourceQuota?.spec?.hard || resourceQuota?.status?.hard || {}
  const customEntries = Object.entries(hard)
    .sort(([left], [right]) => left.localeCompare(right))
    .filter(([key]) => !KNOWN_QUOTA_KEYS.has(key))
    .map(([key, value]) => ({
      key,
      value: String(value),
      isCustomKey: true,
    }))

  return [...createStandardQuotaEntries(hard), ...customEntries]
}

export function quotaEntriesToHardRecord(
  entries: NamespaceResourceQuotaEntry[]
): Record<string, string> {
  return entries.reduce<Record<string, string>>((result, entry) => {
    const key = entry.key.trim()
    const value = entry.value.trim()
    if (!key || !value) {
      return result
    }

    result[key] = value
    return result
  }, {})
}
