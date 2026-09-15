// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResourceActions } from './ResourceActions'
import type { ResourceType } from './types'
afterEach(cleanup)
function setup(resource: string, group = 'apps', spec: Record<string, unknown> = {}) {
  const invoke = vi.fn().mockResolvedValue({})
  const changed = vi.fn()
  const type: ResourceType = { resource, group, version: 'v1', kind: resource, namespaced: group !== '', verbs: ['get', 'patch'] }
  render(<ResourceActions resource={type} object={{ metadata: { name: 'web', namespace: 'default', resourceVersion: '7' }, spec }} invoke={invoke} onChanged={changed} connectionLabel="test-cluster"/>)
  return { invoke, changed }
}
describe('resource operation flows', () => {
  it('does not offer scale for DaemonSets or unrelated custom resources', () => {
    setup('daemonsets')
    expect(screen.queryByText('调整副本')).toBeNull()
    expect(screen.getByText('重启工作负载')).toBeTruthy()
    cleanup(); setup('deployments', 'custom.example')
    expect(screen.queryByText('重启工作负载')).toBeNull()
  })
  it('scales ReplicaSets with zero replicas and the observed resource version', async () => {
    const { invoke, changed } = setup('replicasets', 'apps', { replicas: 3 })
    fireEvent.click(screen.getByText('调整副本'))
    fireEvent.change(screen.getByLabelText('目标副本数'), { target: { value: '0' } })
    fireEvent.click(screen.getByText('确认'))
    await waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(invoke).toHaveBeenCalledWith('workload/scale', expect.objectContaining({ replicas: 0, resourceVersion: '7', namespace: 'default', name: 'web' }))
  })
  it('blocks fractional and overflowing replica counts', () => {
    const { invoke } = setup('deployments')
    fireEvent.click(screen.getByText('调整副本'))
    for (const value of ['-1', '1.5', '2147483648', '']) {
      fireEvent.change(screen.getByLabelText('目标副本数'), { target: { value } })
      expect((screen.getByText('确认') as HTMLButtonElement).disabled).toBe(true)
      fireEvent.submit(screen.getByText('确认').closest('form')!)
    }
    expect(invoke).not.toHaveBeenCalled()
  })
  it('does not trigger CronJobs when cancelled and retains server errors', async () => {
    const { invoke, changed } = setup('cronjobs', 'batch')
    fireEvent.click(screen.getByText('立即触发')); fireEvent.click(screen.getByText('取消'))
    expect(invoke).not.toHaveBeenCalled()
    invoke.mockRejectedValueOnce(new Error('Forbidden'))
    fireEvent.click(screen.getByText('立即触发')); fireEvent.click(screen.getByText('确认'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Forbidden'))
    expect(changed).not.toHaveBeenCalled()
  })
  it('sends the next CronJob suspension state', async () => {
    const { invoke } = setup('cronjobs', 'batch', { suspend: true })
    fireEvent.click(screen.getByText('恢复调度')); fireEvent.click(screen.getByText('确认'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('cronjob/suspend', expect.objectContaining({ suspend: false })))
  })
  it('retains drain defaults that protect unmanaged pods and local data', async () => {
    const { invoke } = setup('nodes', '')
    fireEvent.click(screen.getByText('驱逐工作负载')); fireEvent.click(screen.getByText('确认'))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('node/drain', expect.objectContaining({ force: false, ignoreDaemonSets: true, deleteLocalData: false })))
  })
})
