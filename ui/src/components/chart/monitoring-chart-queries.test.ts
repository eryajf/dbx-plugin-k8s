import { describe, expect, it } from 'vitest'

import {
  cpuUtilizationQuery,
  diskIOUsageQuery,
  memoryUtilizationQuery,
  networkUsageQuery,
} from './monitoring-chart-queries'

const context = {
  namespace: 'logging',
  podName: 'vls-victoria-logs-single-server-0',
  container: 'victoria-logs',
}

describe('monitoring chart queries', () => {
  it('fills the active resource context into pod queries', () => {
    const query = networkUsageQuery(context)

    expect(query).toContain('namespace="logging"')
    expect(query).toContain('pod=~"vls-victoria-logs-single-server-0.*"')
    expect(query).toContain('container="victoria-logs"')
    expect(query).not.toContain('<namespace>')
    expect(query).not.toContain('<pod>')
  })

  it('keeps disk queries scoped to the active resource context', () => {
    const query = diskIOUsageQuery(context)

    expect(query).toContain('container_fs_reads_bytes_total')
    expect(query).toContain('container_fs_writes_bytes_total')
    expect(query).toContain('namespace="logging"')
  })

  it('supports current and legacy resource limit metrics', () => {
    const cpuQuery = cpuUtilizationQuery(context)
    const memoryQuery = memoryUtilizationQuery(context)

    expect(cpuQuery).toContain('kube_pod_container_resource_limits')
    expect(cpuQuery).toContain('kube_pod_container_resource_limits_cpu_cores')
    expect(cpuQuery).toContain('kube_pod_container_resource_requests_cpu_cores')
    expect(memoryQuery).toContain('kube_pod_container_resource_limits_memory_bytes')
    expect(memoryQuery).toContain('kube_pod_container_resource_requests_memory_bytes')
    expect(cpuQuery).toContain('sum by (pod, container)')
  })

  it('uses exact Pod names when comparing selected replicas', () => {
    const query = networkUsageQuery({
      namespace: 'logging',
      podName: 'ignored-prefix',
      podNames: ['api-7c8cc44d68-abc12', 'api-7c8cc44d68-def34'],
    })

    expect(query).toContain('pod=~"^(api-7c8cc44d68-abc12|api-7c8cc44d68-def34)$"')
  })
})
