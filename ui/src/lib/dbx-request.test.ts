import { afterEach, describe, expect, it, vi } from 'vitest'
import { DBXTransport, getDBXTransport } from './dbx-transport'

const deferred = () => {
  let resolve!: (value: unknown) => void
  const promise = new Promise(resolveValue => { resolve = resolveValue })
  return { promise, resolve }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('bounded DBX resource reads', () => {
  it('forwards an explicit connection and deadline to both host and backend', async () => {
    const invoke = vi.fn().mockResolvedValue({ items: [] })
    vi.stubGlobal('dbxPlugin', { context: { connectionId: 'new' }, invoke })
    await getDBXTransport('original')!.request('/nodes', 'GET', undefined, { timeoutMs: 10_000 })
    expect(invoke).toHaveBeenCalledWith('resource/list', expect.objectContaining({ connectionId: 'original', requestTimeoutMs: expect.any(Number) }), { timeoutMs: expect.any(Number) })
    expect(invoke.mock.calls[0][1].requestTimeoutMs).toBeLessThanOrEqual(10_000)
  })
  it('does not spawn a second RPC when an aborted observer returns', async () => {
    const pending = deferred()
    const invoke = vi.fn().mockReturnValue(pending.promise)
    const transport = new DBXTransport(invoke, 'dedup')
    const controller = new AbortController()
    const first = transport.request('/nodes', 'GET', undefined, { timeoutMs: 1000, signal: controller.signal })
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    controller.abort()
    await rejected
    const second = transport.request('/nodes', 'GET', undefined, { timeoutMs: 1000 })
    pending.resolve({ items: [] })
    await expect(second).resolves.toEqual({ items: [] })
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('does not poison shared discovery when its first resource observer is canceled', async () => {
    const discovery = deferred()
    const invoke = vi.fn((method: string) => method === 'kube/discover'
      ? discovery.promise : Promise.resolve({ items: [] }))
    const transport = new DBXTransport(invoke, 'shared-discovery-cancellation')
    const controller = new AbortController()
    const first = transport.request('/deployments/default', 'GET', undefined, { timeoutMs: 1000, signal: controller.signal })
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    const second = transport.request('/deployments/default', 'GET', undefined, { timeoutMs: 1000 })
    controller.abort()
    await rejected
    discovery.resolve({ resources: [{ group: 'apps', version: 'v1', resource: 'deployments', namespaced: true }] })
    await expect(second).resolves.toEqual({ items: [] })
    expect(invoke.mock.calls.filter(([method]) => method === 'kube/discover')).toHaveLength(1)
    expect(invoke.mock.calls.filter(([method]) => method === 'resource/list')).toHaveLength(1)
  })
  it('does not reuse in-flight data from another connection', async () => {
    const pending = deferred()
    const invoke = vi.fn().mockReturnValue(pending.promise)
    const first = new DBXTransport(invoke, 'isolation-a').request('/nodes', 'GET', undefined, { timeoutMs: 1000 })
    const second = new DBXTransport(invoke, 'isolation-b').request('/nodes', 'GET', undefined, { timeoutMs: 1000 })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    pending.resolve({ items: [] })
    await Promise.all([first, second])
  })
  it('bounds a reader waiting on discovery started without its own deadline', async () => {
    vi.useFakeTimers()
    const discovery = deferred()
    const invoke = vi.fn().mockReturnValue(discovery.promise)
    const transport = new DBXTransport(invoke, 'shared-discovery-deadline')
    const original = transport.request('/deployments/default', 'GET')
    const bounded = transport.request('/deployments/default', 'GET', undefined, { timeoutMs: 50 })
    const rejected = expect(bounded).rejects.toMatchObject({ code: 'timeout', retryable: true })
    await vi.advanceTimersByTimeAsync(50)
    await rejected
    discovery.resolve({ resources: [] })
    await expect(original).rejects.toThrow('not discovered')
  })
  it('enforces a local deadline even if the host does not answer', async () => {
    vi.useFakeTimers()
    const invoke = vi.fn(() => new Promise(() => {}))
    const request = new DBXTransport(invoke, 'timeout').request('/nodes', 'GET', undefined, { timeoutMs: 1000 })
    const rejected = expect(request).rejects.toMatchObject({ code: 'timeout', retryable: true })
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
  })
  it('does not dispatch a canceled read or replay writes', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('context deadline exceeded'))
    const controller = new AbortController(); controller.abort()
    const transport = new DBXTransport(invoke, 'write-policy')
    await expect(transport.request('/nodes', 'GET', undefined, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(invoke).not.toHaveBeenCalled()
    await expect(transport.request('/nodes/node', 'PATCH', { spec: {} }, { timeoutMs: 1000 })).rejects.toThrow('context deadline exceeded')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0][1]).not.toHaveProperty('requestTimeoutMs')
  })
  it('preserves structured RPC errors from newer hosts', async () => {
    const invoke = vi.fn().mockRejectedValue({ code: -32000, message: 'denied', data: { code: 'forbidden', retryable: false, status: 403 } })
    await expect(new DBXTransport(invoke, 'error').request('/nodes', 'GET', undefined, { timeoutMs: 1000 })).rejects.toMatchObject({ rpcCode: -32000, code: 'forbidden', status: 403, retryable: false })
  })
})
