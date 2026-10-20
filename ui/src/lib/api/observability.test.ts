import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import i18n from '@/i18n'
import { podMetricsRefetchInterval, useLogsWebSocket } from './observability'

afterEach(() => {cleanup(); Reflect.deleteProperty(globalThis, 'dbxPlugin')})

describe('useLogsWebSocket DBX warnings', () => {
  it('exposes truncation as nonfatal state, keeps streaming, and resets on a new target without accepting old cleanup warnings', async () => {
    let resolveOldRead!: (frame: unknown) => void
    let reads = 0
    const oldRead = new Promise(resolve => {resolveOldRead = resolve})
    const onNewLog = vi.fn()
    const invoke = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'pod/logs-open') return {sessionId: params.name}
      if (method === 'session/read') {
        if (params.sessionId !== 'pod-a') return new Promise(() => {})
        if (++reads === 1) return {sessionId: 'pod-a', droppedBytes: 1048576, data: 'retained tail\n'}
        return oldRead
      }
      return {closed: true}
    })
    Object.assign(globalThis, {dbxPlugin: {context: {connectionId: 'cluster'}, invoke}})
    const hook = renderHook(({pod}) => useLogsWebSocket('ns', pod, {enabled: true, onNewLog}), {initialProps: {pod: 'pod-a'}})
    await waitFor(() => expect(hook.result.current.warning).toBe(i18n.t('terminalContent.outputTruncated', {bytes: 1048576})))
    expect(onNewLog).toHaveBeenCalledExactlyOnceWith('retained tail\n')
    expect(hook.result.current).toMatchObject({error: null, isConnected: true, isLoading: false})
    await waitFor(() => expect(reads).toBe(2))
    hook.rerender({pod: 'pod-b'})
    await waitFor(() => expect(hook.result.current).toMatchObject({warning: null, error: null, isConnected: true}))
    await act(async () => {resolveOldRead({sessionId: 'pod-a', closed: true, warning: 'old cleanup warning', data: 'late data'})})
    expect(hook.result.current.warning).toBeNull()
    expect(onNewLog).toHaveBeenCalledTimes(1)
  })
})

describe('podMetricsRefetchInterval', () => {
  it('disables polling when monitoring refresh is turned off', () => {
    expect(podMetricsRefetchInterval(0)).toBe(false)
  })

  it('keeps explicit intervals and the default polling interval', () => {
    expect(podMetricsRefetchInterval(5_000)).toBe(5_000)
    expect(podMetricsRefetchInterval()).toBe(30_000)
  })
})
