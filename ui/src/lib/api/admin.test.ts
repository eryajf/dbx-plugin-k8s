import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { testClusterConnection } from './admin'

describe('testClusterConnection', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  it('aborts the request and returns a readable timeout error', async () => {
    globalThis.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        })
    ) as typeof fetch

    const request = testClusterConnection({
      name: 'demo',
      config: 'apiVersion: v1',
    })
    const expectation = expect(request).rejects.toThrow(
      'Connection test timed out after 15 seconds.'
    )

    await vi.advanceTimersByTimeAsync(15_000)
    await expectation
  })
})
