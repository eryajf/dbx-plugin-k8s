import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MetricsPanel, metricsRows } from './MetricsPanel'
afterEach(cleanup)
describe('metrics panel', () => {
  it('aggregates all containers in a pod and normalizes units', () => {
    expect(metricsRows([{metadata:{name:'web',namespace:'prod'},containers:[{usage:{cpu:'100m',memory:'512Mi'}},{usage:{cpu:'200m',memory:'512Mi'}}]}])).toEqual([{name:'prod/web',cpu:300,memory:1}])
  })
  it('switches from node metrics to pod metrics and resets the displayed data', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({items:[{metadata:{name:'node-a'},usage:{cpu:'100m',memory:'1Gi'}}]}).mockResolvedValue({items:[{metadata:{name:'web',namespace:'prod'},containers:[{usage:{cpu:'50m',memory:'256Mi'}}]}]})
    render(<MetricsPanel invoke={invoke} zh={false}/> )
    await screen.findByText('node-a')
    fireEvent.change(screen.getByLabelText('Metrics resource'),{target:{value:'pods'}})
    await screen.findByText('prod/web')
    expect(screen.queryByText('node-a')).toBeNull()
    expect(invoke).toHaveBeenLastCalledWith('kube/metrics',{resource:'pods'})
  })
  it('keeps last good values on refresh failure and reports stale data', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({items:[{metadata:{name:'node-a'},usage:{cpu:'100m'}}]}).mockRejectedValue(new Error('Forbidden'))
    render(<MetricsPanel invoke={invoke} zh={false}/> )
    await screen.findByText('node-a')
    fireEvent.click(screen.getByText('Refresh metrics'))
    await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Showing last successful data'))
    expect(screen.getByText('node-a')).toBeTruthy()
  })
})
