import { describe, expect, it, vi } from 'vitest'

import { DBXTransport, getDBXTransport } from './dbx-transport'
import { createDBXTerminalSocket } from './dbx-session-stream'

describe('createDBXTerminalSocket', () => {
  it.each([
    ['pod', 'pod/exec-open', { namespace: 'ops', name: 'web', container: 'app' }],
    ['node', 'node/exec-open', { node: 'node-a' }],
    ['kubectl', 'kubectl/exec-open', {}],
  ])('opens a %s session and uses generic input RPCs', async (type, openMethod, expected) => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const invoke = vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params])
      if (method === openMethod) return { sessionId: 'session-1' }
      if (method === 'session/read') return { sessionId: 'session-1', data: 'ready\n', closed: true }
      return { ok: true }
    })
    const socket = createDBXTerminalSocket(new DBXTransport(invoke, 'cluster-a'), {
      type,
      namespace: 'ops',
      name: 'web',
      container: 'app',
      nodeName: 'node-a',
    })
    const messages: string[] = []
    socket.onmessage = (event) => messages.push(event.data)
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve()
    })
    socket.send(JSON.stringify({ type: 'stdin', data: 'id\n' }))
    socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(calls[0]?.[0]).toBe(openMethod)
    expect(calls[0]?.[1]).toMatchObject(expected)
    expect(calls.some(([method]) => method === 'terminal/exec-write')).toBe(true)
    expect(calls.some(([method]) => method === 'terminal/exec-resize')).toBe(true)
    expect(messages.join('')).toContain('ready')
    expect(calls.every(([, params]) => params.connectionId === 'cluster-a')).toBe(true)
  })

  it('reports an open failure and closes the socket', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('permission denied')
    })
    const socket = createDBXTerminalSocket(new DBXTransport(invoke, 'cluster-a'), { type: 'kubectl' })
    const messages: string[] = []
    let closeCode: number | undefined
    socket.onmessage = (event) => messages.push(event.data)
    socket.onclose = (event) => { closeCode = event.code }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(messages.join('')).toContain('permission denied')
    expect(closeCode).toBe(1006)
    expect(socket.readyState).toBe(3)
  })

  it('pins an existing session transport to its connection after a switch', async () => {
    const invoke = vi.fn(async () => ({ ok: true }))
    ;(globalThis as typeof globalThis & { dbxPlugin?: unknown }).dbxPlugin = {
      context: { connectionId: 'cluster-b' },
      invoke,
    }
    try {
      const transport = getDBXTransport('cluster-a')
      expect(transport?.connectionId).toBe('cluster-a')
      await transport?.rpc('terminal/exec-write', { sessionId: 'session-1', data: 'pwd\n' })
      expect(invoke).toHaveBeenCalledWith('terminal/exec-write', expect.objectContaining({ connectionId: 'cluster-a' }))
    } finally {
      delete (globalThis as typeof globalThis & { dbxPlugin?: unknown }).dbxPlugin
    }
  })
})
