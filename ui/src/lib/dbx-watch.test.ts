import { describe, it, expect, vi } from 'vitest'
import { startDBXWatch } from './dbx-watch'

describe('DBX watch', () => {
  it('parses split newline events and closes its session', async () => {
    vi.useFakeTimers()
    let reads = 0
    const invoke = vi.fn(async (method: string) => {
      if (method === 'resource/watch') return { sessionId: 's' }
      if (method === 'resource/watch-read') return {
        data: reads++ === 0 ? '{"type":"ADDED","object":' : '{"metadata":{"name":"pod"}}}\n',
        closed: false,
      }
      return { closed: true }
    })
    const onEvent = vi.fn()
    const onError = vi.fn()
    const stop = startDBXWatch('c', 'pods', 'default', { invoke }, onEvent, onError)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(onEvent).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(500)
      expect(onEvent).toHaveBeenCalledWith({ type: 'ADDED', object: { metadata: { name: 'pod' } } })
      expect(onError).not.toHaveBeenCalled()
      stop()
      expect(invoke).toHaveBeenCalledWith('resource/watch-close', { connectionId: 'c', sessionId: 's' })
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it('does not open a session when stopped before resolution', async () => {
    const invoke = vi.fn()
    const stop = startDBXWatch('c', 'pods', 'default', { invoke }, vi.fn(), vi.fn())
    stop()
    await Promise.resolve()
    expect(invoke).not.toHaveBeenCalled()
  })
})
