export interface PodQueryContext {
  namespace?: string
  podName?: string
  podNames?: string[]
  container?: string
}

function escapePromQLLabelValue(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
}

function podMatchers(context?: PodQueryContext) {
  const namespace = escapePromQLLabelValue(context?.namespace || '<namespace>')
  const podName = escapePromQLLabelValue(context?.podName || '<pod>')
  const selectedPods = context?.podNames?.filter(Boolean) || []
  const podMatcher = selectedPods.length
    ? `pod=~"^(${selectedPods.map((pod) => escapePromQLLabelValue(pod).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$"`
    : `pod=~"${podName}.*"`
  const matchers = [
    `namespace="${namespace}"`,
    podMatcher,
    'container!="POD"',
    'container!=""',
  ]

  if (context?.container) {
    matchers.push(`container="${escapePromQLLabelValue(context.container)}"`)
  }

  return matchers.join(',')
}

function utilizationDenominator(
  resource: 'cpu' | 'memory',
  legacyLimitMetric: string,
  legacyRequestMetric: string,
  minimum: string,
  context?: PodQueryContext
) {
  const matchers = podMatchers(context)
  const resourceMatchers = `resource="${resource}",${matchers}`
  return `clamp_min((sum by (pod, container) (kube_pod_container_resource_limits{${resourceMatchers}}) or sum by (pod, container) (${legacyLimitMetric}{${matchers}}) or sum by (pod, container) (kube_pod_container_resource_requests{${resourceMatchers}}) or sum by (pod, container) (${legacyRequestMetric}{${matchers}})), ${minimum})`
}

export function cpuAmountQuery(context?: PodQueryContext) {
  return `sum by (pod, container) (rate(container_cpu_usage_seconds_total{${podMatchers(context)}}[1m]))`
}

export function cpuUtilizationQuery(context?: PodQueryContext) {
  const matchers = podMatchers(context)
  return `sum by (pod, container) (rate(container_cpu_usage_seconds_total{${matchers}}[1m])) / ${utilizationDenominator('cpu', 'kube_pod_container_resource_limits_cpu_cores', 'kube_pod_container_resource_requests_cpu_cores', '0.001', context)} * 100`
}

export function memoryAmountQuery(context?: PodQueryContext) {
  return `sum by (pod, container) (container_memory_working_set_bytes{${podMatchers(context)}}) / 1024 / 1024`
}

export function memoryUtilizationQuery(context?: PodQueryContext) {
  const matchers = podMatchers(context)
  return `sum by (pod, container) (container_memory_working_set_bytes{${matchers}}) / ${utilizationDenominator('memory', 'kube_pod_container_resource_limits_memory_bytes', 'kube_pod_container_resource_requests_memory_bytes', '1', context)} * 100`
}

export function networkUsageQuery(context?: PodQueryContext) {
  const matchers = podMatchers(context)
  return `sum by (pod, container) (rate(container_network_receive_bytes_total{${matchers}}[1m]))\nsum by (pod, container) (rate(container_network_transmit_bytes_total{${matchers}}[1m]))`
}

export function diskIOUsageQuery(context?: PodQueryContext) {
  const matchers = podMatchers(context)
  return `sum by (pod, container) (rate(container_fs_reads_bytes_total{${matchers}}[1m]))\nsum by (pod, container) (rate(container_fs_writes_bytes_total{${matchers}}[1m]))`
}

export function nodeNetworkUsageQuery(nodeName?: string) {
  const node = escapePromQLLabelValue(nodeName || '<node>')
  return `sum(rate(node_network_receive_bytes_total{instance="${node}",device!="lo"}[1m]))\nsum(rate(node_network_transmit_bytes_total{instance="${node}",device!="lo"}[1m]))`
}

export function nodeUtilizationQuery(nodeName?: string) {
  const node = escapePromQLLabelValue(nodeName || '<node>')
  return `sum(rate(node_cpu_seconds_total{instance="${node}",mode!="idle"}[5m])) / sum(rate(node_cpu_seconds_total{instance="${node}"}[5m])) * 100\n(1 - sum(node_memory_MemAvailable_bytes{instance="${node}"}) / sum(node_memory_MemTotal_bytes{instance="${node}"})) * 100`
}
