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
      if (method === 'terminal/exec-write') return { written: new TextEncoder().encode(String(params.data)).length }
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function connectedTerminal() {
  const read = deferred<{closed: boolean}>()
  const writes: Array<{data: string; reply: ReturnType<typeof deferred<{written: number}>>}> = []
  const invoke = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'pod/exec-open') return {sessionId: 'terminal'}
    if (method === 'session/read') return read.promise
    if (method === 'session/close') { read.resolve({closed: true}); return {} }
    if (method === 'terminal/exec-write') {
      const reply = deferred<{written: number}>()
      writes.push({data: String(params.data), reply})
      return reply.promise
    }
    return {ok: true}
  })
  const socket = createDBXTerminalSocket(new DBXTransport(invoke, 'cluster'), {})
  const messages: string[] = []
  socket.onmessage = event => messages.push(event.data)
  const onclose = vi.fn()
  socket.onclose = onclose
  await new Promise<void>(resolve => { socket.onopen = resolve })
  const send = (data: string) => socket.send(JSON.stringify({type: 'stdin', data}))
  const acknowledge = async (index: number) => {
    writes[index].reply.resolve({written: new TextEncoder().encode(writes[index].data).length})
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return {socket, send, writes, invoke, messages, onclose, read, acknowledge}
}

describe('terminal input ordering and lifecycle', () => {
  it('waits for acknowledgement and merges queued keystrokes without reordering', async () => {
    const terminal = await connectedTerminal()
    terminal.send('c')
    terminal.send('d')
    terminal.send(' /tmp\r')
    expect(terminal.writes.map(write => write.data)).toEqual(['c'])
    await terminal.acknowledge(0)
    expect(terminal.writes.map(write => write.data)).toEqual(['c', 'd /tmp\r'])
    await terminal.acknowledge(1)
    terminal.socket.close()
  })

  it('splits large Unicode pastes at the backend byte limit without corrupting text', async () => {
    const terminal = await connectedTerminal()
    const data = '中🙂'.repeat(20000)
    terminal.send(data)
    for (let index = 0; index < terminal.writes.length; index++) {
      const chunk = terminal.writes[index].data
      expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(65536)
      expect(new TextDecoder().decode(new TextEncoder().encode(chunk))).toBe(chunk)
      await terminal.acknowledge(index)
    }
    expect(terminal.writes.map(write => write.data).join('')).toBe(data)
    terminal.socket.close()
  })

  it.each(['local', 'remote'] as const)('discards queued input after %s closure', async closure => {
    const terminal = await connectedTerminal()
    terminal.send('c')
    terminal.send('d')
    if (closure === 'local') terminal.socket.close()
    else terminal.read.resolve({closed: true})
    await new Promise(resolve => setTimeout(resolve, 0))
    await terminal.acknowledge(0)
    terminal.send('later')
    expect(terminal.writes).toHaveLength(1)
    expect(terminal.socket.readyState).toBe(3)
    expect(terminal.onclose).toHaveBeenCalledTimes(1)
  })

  it.each(['rejection', 'partial'] as const)('closes on write %s without retrying or sending queued commands', async failure => {
    const terminal = await connectedTerminal()
    terminal.send('cd')
    terminal.send('\r')
    if (failure === 'rejection') terminal.writes[0].reply.reject(new Error('write failed'))
    else terminal.writes[0].reply.resolve({written: 1})
    await new Promise(resolve => setTimeout(resolve, 0))
    terminal.send('later')
    expect(terminal.writes).toHaveLength(1)
    expect(terminal.messages.join('')).toContain('error')
    expect(JSON.parse(terminal.messages[0]).code).toBe(failure === 'partial' ? 'INPUT_INCOMPLETE' : undefined)
    expect(terminal.onclose).toHaveBeenCalledExactlyOnceWith({code: 1006})
    expect(terminal.invoke).toHaveBeenCalledWith('session/close', expect.objectContaining({sessionId: 'terminal'}))
  })

  it('bounds outstanding input by bytes including the in-flight write', async () => {
    const terminal = await connectedTerminal()
    terminal.send('x'.repeat(65536))
    terminal.send('中'.repeat(65536))
    expect(terminal.socket.readyState).toBe(1)
    terminal.send('x')
    expect(terminal.messages.join('')).toContain('queue is full')
    expect(JSON.parse(terminal.messages[0]).code).toBe('INPUT_QUEUE_FULL')
    expect(terminal.socket.readyState).toBe(3)
    await terminal.acknowledge(0)
    expect(terminal.writes).toHaveLength(1)
  })

  it('keeps independent terminals writable while another waits for acknowledgement', async () => {
    const first = await connectedTerminal()
    const second = await connectedTerminal()
    first.send('c')
    first.send('d')
    second.send('pwd\r')
    expect(second.writes.map(write => write.data)).toEqual(['pwd\r'])
    await second.acknowledge(0)
    first.socket.close()
    await first.acknowledge(0)
    second.socket.close()
  })
})
