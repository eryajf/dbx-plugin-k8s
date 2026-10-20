import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiClient } from './api-client'

describe('apiClient cluster transport', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    apiClient.setClusterProvider(() => '生产集群')
  })

  afterEach(() => {
    apiClient.setClusterProvider(() => null)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('binds the original connection and strips local request options from fetch', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ items: [] }),
    })
    await apiClient.get('/nodes', { connectionId: 'original', timeoutMs: 100 })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/nodes?x-cluster-name=original')
    const options = fetchMock.mock.calls[0][1]
    expect(options).not.toHaveProperty('connectionId')
    expect(options).not.toHaveProperty('timeoutMs')
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(options.signal.aborted).toBe(false)
  })

  it('bounds HTTP reads even when the connection stays open', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const request = apiClient.get('/nodes', { timeoutMs: 50 })
    const rejection = expect(request).rejects.toMatchObject({ code: 'timeout', retryable: true })
    await vi.advanceTimersByTimeAsync(50)
    await rejection
  })

  it('does not turn observer cancellation into a retryable timeout', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const request = apiClient.get('/nodes', { signal: controller.signal, timeoutMs: 100 })
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('classifies explicit fetch network failures as retryable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(apiClient.get('/nodes')).rejects.toMatchObject({ code: 'network', retryable: true })
  })

  it('moves the cluster name from headers to the query string', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'application/json',
      }),
      json: async () => ({ ok: true }),
    })

    await apiClient.get('/nodes')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/nodes?x-cluster-name=%E7%94%9F%E4%BA%A7%E9%9B%86%E7%BE%A4',
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
        },
      })
    )
  })
})
