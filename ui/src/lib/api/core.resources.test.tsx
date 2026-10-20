import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), connectionId: 'connection-a' }))
vi.mock('./shared', () => ({ fetchAPI: mocks.fetch }))
vi.mock('@/hooks/use-cluster', () => ({ useCluster: () => ({ currentCluster: mocks.connectionId }) }))

import { useResources } from './core'

const temporary = () => Object.assign(new Error('Service unavailable'), { status: 503, retryable: true })
let client: QueryClient

function wrapper({ children }: { children: React.ReactNode }) {
  return <MemoryRouter><QueryClientProvider client={client}>{children}</QueryClientProvider></MemoryRouter>
}

async function tick(ms = 1) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  focusManager.setFocused(true)
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
  mocks.fetch.mockReset()
  mocks.connectionId = 'connection-a'
})
afterEach(() => {
  client.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  focusManager.setFocused(undefined)
})

describe('useResources scoped recovery', () => {
  it('does not issue a resource read before a stable connection is available', async () => {
    mocks.connectionId = ''
    renderHook(() => useResources('pods', 'default'), { wrapper })
    await tick(10000)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('shows initial failure only after two extra attempts, with explicit connection and timeout', async () => {
    mocks.fetch.mockRejectedValue(temporary())
    const { result } = renderHook(() => useResources('pods', 'default'), { wrapper })
    await tick(3100)
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
    expect(mocks.fetch).toHaveBeenCalledWith('/pods/default', expect.objectContaining({ connectionId: 'connection-a', timeoutMs: 10000, signal: expect.any(AbortSignal) }))
    expect(result.current.data).toBeUndefined()
    expect(result.current.isError).toBe(true)
  })

  it.each([{ items: [] }, { items: [{ metadata: { name: 'old-row' } }] }])('retains successful snapshot $items and timestamp through a failed background read', async ({ items }) => {
    mocks.fetch.mockResolvedValueOnce({ items }).mockRejectedValue(temporary())
    const { result } = renderHook(() => useResources('pods', 'default'), { wrapper })
    await tick()
    const lastSuccess = result.current.dataUpdatedAt
    expect(lastSuccess).toBeGreaterThan(0)
    act(() => { void result.current.refetch() })
    await tick(3100)
    expect(result.current.isError).toBe(true)
    expect(result.current.data).toEqual(items)
    expect(result.current.dataUpdatedAt).toBe(lastSuccess)
  })

  it('isolates namespace, reduction, selectors, limit, and connection without placeholder rows', async () => {
    mocks.fetch.mockResolvedValueOnce({ items: [{ metadata: { name: 'old' } }] })
    const { result, rerender } = renderHook(({ ns, reduce, selector, limit }) => useResources('pods', ns, { reduce, labelSelector: selector, limit }), {
      wrapper, initialProps: { ns: 'default', reduce: false, selector: '', limit: 1 },
    })
    await tick()
    const originalScope = result.current.resourceQueryScope
    mocks.fetch.mockImplementation(() => new Promise(() => {}))
    for (const props of [
      { ns: 'other', reduce: false, selector: '', limit: 1 },
      { ns: 'other', reduce: true, selector: '', limit: 1 },
      { ns: 'other', reduce: true, selector: 'app=x', limit: 1 },
      { ns: 'other', reduce: true, selector: 'app=x', limit: 2 },
    ]) {
      rerender(props)
      expect(result.current.data).toBeUndefined()
      expect(result.current.resourceQueryScope).not.toBe(originalScope)
    }
    mocks.connectionId = 'connection-b'
    rerender({ ns: 'default', reduce: false, selector: '', limit: 1 })
    expect(result.current.data).toBeUndefined()
    expect(mocks.fetch).toHaveBeenLastCalledWith('/pods/default?limit=1', expect.objectContaining({ connectionId: 'connection-b' }))
    expect(client.getQueryCache().findAll({ queryKey: ['pods'] })).toHaveLength(6)
  })

  it('isolates served resource identity and sends the captured route GVR', async () => {
    mocks.fetch.mockResolvedValueOnce({ items: [{ metadata: { name: 'version-a' } }] })
    const v1 = renderHook(() => useResources('deployments', 'default', { useRouteIdentity: true }), {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/deployments?group=apps&version=v1']}><QueryClientProvider client={client}>{children}</QueryClientProvider></MemoryRouter>,
    })
    await tick()
    expect(v1.result.current.data).toHaveLength(1)
    mocks.fetch.mockImplementation(() => new Promise(() => {}))
    const v2 = renderHook(() => useResources('deployments', 'default', { useRouteIdentity: true }), {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/deployments?group=apps&version=v1beta1']}><QueryClientProvider client={client}>{children}</QueryClientProvider></MemoryRouter>,
    })
    expect(v2.result.current.data).toBeUndefined()
    expect(v2.result.current.resourceQueryScope).not.toBe(v1.result.current.resourceQueryScope)
    expect(mocks.fetch).toHaveBeenLastCalledWith('/deployments/default?group=apps&version=v1beta1', expect.objectContaining({ connectionId: 'connection-a' }))
  })

  it('does not leak the primary route GVR into supporting resource selectors', async () => {
    mocks.fetch.mockResolvedValue({ items: [] })
    renderHook(() => useResources('secrets', 'default'), {
      wrapper: ({ children }) => <MemoryRouter initialEntries={['/deployments?group=apps&version=v1']}><QueryClientProvider client={client}>{children}</QueryClientProvider></MemoryRouter>,
    })
    await tick()
    expect(mocks.fetch).toHaveBeenCalledWith('/secrets/default', expect.any(Object))
  })

  it('probes after 10/20/30s then restores the original interval after success', async () => {
    // Permanent failures within each fetch cycle exhaust their three attempts.
    mocks.fetch.mockRejectedValue(temporary())
    const { result } = renderHook(() => useResources('pods', 'default', { refreshInterval: 1000 }), { wrapper })
    await tick(3001)
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
    await tick(9998)
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
    await tick(3002)
    expect(mocks.fetch).toHaveBeenCalledTimes(6)
    await tick(19998)
    expect(mocks.fetch).toHaveBeenCalledTimes(6)
    await tick(3002)
    expect(mocks.fetch).toHaveBeenCalledTimes(9)
    mocks.fetch.mockResolvedValue({ items: [] })
    await tick(30000)
    expect(result.current.data).toEqual([])
    expect(result.current.isError).toBe(false)
    const count = mocks.fetch.mock.calls.length
    await tick(1000)
    expect(mocks.fetch).toHaveBeenCalledTimes(count + 1)
  })

  it('does not probe or refetch on focus when Off', async () => {
    mocks.fetch.mockRejectedValue(temporary())
    renderHook(() => useResources('pods', 'default', { refreshInterval: 0 }), { wrapper })
    await tick(3100)
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await tick(120000)
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
  })

  it('does not restart failed Off queries when remounted', async () => {
    mocks.fetch.mockRejectedValue(temporary())
    const first = renderHook(() => useResources('pods', 'default', { refreshInterval: 0 }), { wrapper })
    await tick(3100)
    first.unmount()
    renderHook(() => useResources('pods', 'default', { refreshInterval: 0 }), { wrapper })
    await tick(100000)
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
  })

  it.each([undefined, 0])('resumes an interrupted initial read without polling (interval %s)', async refreshInterval => {
    mocks.fetch.mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({ items: [] })
    const { result } = renderHook(() => useResources('namespaces', undefined, { refreshInterval }), { wrapper })
    await tick()
    const signal = mocks.fetch.mock.calls[0][1].signal as AbortSignal
    act(() => focusManager.setFocused(false))
    await tick(10000)
    expect(signal.aborted).toBe(true)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(result.current.fetchStatus).toBe('idle')
    expect(result.current.data).toBeUndefined()
    act(() => focusManager.setFocused(true))
    await tick()
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(result.current.data).toEqual([])
    act(() => focusManager.setFocused(false))
    act(() => focusManager.setFocused(true))
    await tick(120000)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('does not resume an interrupted initial read while disabled', async () => {
    mocks.fetch.mockImplementation(() => new Promise(() => {}))
    const { rerender } = renderHook(({ disable }) => useResources('crds', undefined, { disable }), {
      wrapper, initialProps: { disable: false },
    })
    await tick()
    act(() => focusManager.setFocused(false))
    await tick()
    rerender({ disable: true })
    act(() => focusManager.setFocused(true))
    await tick(10000)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent manual refreshes without aborting the pending request', async () => {
    mocks.fetch.mockResolvedValueOnce({ items: [] })
    const { result } = renderHook(() => useResources('pods', 'default'), { wrapper })
    await tick()
    let finish!: (data: unknown) => void
    mocks.fetch.mockImplementation((_endpoint, options) => new Promise(resolve => {
      finish = resolve
      expect(options.signal.aborted).toBe(false)
    }))
    act(() => { void result.current.refetch(); void result.current.refetch() })
    await tick()
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    const signal = mocks.fetch.mock.lastCall?.[1].signal as AbortSignal
    expect(signal.aborted).toBe(false)
    await act(async () => finish({ items: [] }))
  })

  it('cancels hidden backoff, does not poll hidden, and coordinates a single focus read', async () => {
    mocks.fetch.mockRejectedValue(temporary())
    renderHook(() => useResources('pods', 'default', { refreshInterval: 1000 }), { wrapper })
    await tick(100)
    act(() => focusManager.setFocused(false))
    await tick(10000)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    mocks.fetch.mockResolvedValue({ items: [] })
    act(() => focusManager.setFocused(true))
    await tick()
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it.each([401, 403, 404])('never automatically retries or probes permanent HTTP %i', async status => {
    mocks.fetch.mockRejectedValue(Object.assign(new Error('Request denied'), { status }))
    const { result } = renderHook(() => useResources('pods', 'default', { refreshInterval: 1000 }), { wrapper })
    await tick(100000)
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true) })
    await tick()
    expect(result.current.isError).toBe(true)
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })
})
