import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '@/i18n'
import { languages } from '@/i18n/locale'
import { DBXTransport, getDBXTransport } from './dbx-transport'
import { createDBXTerminalSocket, startSessionStream, type SessionFrame } from './dbx-session-stream'

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

describe('session warnings and closure', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps truncated output, subsequent reads, input and resize usable', async () => {
    const nextRead = deferred<SessionFrame>()
    let reads = 0
    const invoke = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'pod/exec-open') return {sessionId: 'terminal'}
      if (method === 'session/read') {
        if (++reads === 1) return {sessionId: 'terminal', droppedBytes: 128, data: 'retained output'}
        return nextRead.promise
      }
      if (method === 'terminal/exec-write') return {written: new TextEncoder().encode(String(params.data)).length}
      return {ok: true}
    })
    const socket = createDBXTerminalSocket(new DBXTransport(invoke, 'cluster'), {})
    const messages: unknown[] = []
    const onclose = vi.fn()
    socket.onmessage = event => messages.push(JSON.parse(event.data))
    socket.onclose = onclose
    await vi.advanceTimersByTimeAsync(0)

    expect(messages).toEqual([
      {type: 'warning', data: i18n.t('terminalContent.outputTruncated', {bytes: 128})},
      {type: 'stdout', data: 'retained output'},
    ])
    expect(socket.readyState).toBe(1)
    expect(onclose).not.toHaveBeenCalled()
    expect(invoke.mock.calls.filter(([method]) => method === 'session/close')).toHaveLength(0)

    socket.send(JSON.stringify({type: 'stdin', data: 'pwd\r'}))
    socket.send(JSON.stringify({type: 'resize', cols: 100, rows: 30}))
    await vi.advanceTimersByTimeAsync(250)
    expect(invoke).toHaveBeenCalledWith('terminal/exec-write', expect.objectContaining({sessionId: 'terminal', data: 'pwd\r'}))
    expect(invoke).toHaveBeenCalledWith('terminal/exec-resize', expect.objectContaining({sessionId: 'terminal', cols: 100, rows: 30}))
    expect(reads).toBe(2)
    nextRead.resolve({sessionId: 'terminal', data: 'next output', closed: true})
    await vi.advanceTimersByTimeAsync(0)
    expect(messages[messages.length - 1]).toEqual({type: 'stdout', data: 'next output'})
    expect(onclose).toHaveBeenCalledExactlyOnceWith({code: 1000})
    expect(invoke.mock.calls.filter(([method]) => method === 'session/close')).toHaveLength(0)
  })

  it('emits a cleanup warning and final output before closing a closed frame normally', async () => {
    const invoke = vi.fn(async (method: string) => method === 'pod/exec-open'
      ? {sessionId: 'terminal'}
      : {sessionId: 'terminal', warning: 'cleanup failed: permission denied', data: 'final output', closed: true})
    const socket = createDBXTerminalSocket(new DBXTransport(invoke, 'cluster'), {})
    const events: unknown[] = []
    socket.onmessage = event => events.push(JSON.parse(event.data))
    socket.onclose = event => events.push(event)
    await vi.advanceTimersByTimeAsync(0)
    expect(events).toEqual([
      {type: 'warning', data: 'cleanup failed: permission denied'},
      {type: 'stdout', data: 'final output'},
      {code: 1000},
    ])
    expect(socket.readyState).toBe(3)
    expect(invoke.mock.calls.filter(([method]) => method === 'session/close')).toHaveLength(0)
  })

  it.each(['frame', 'rejection'] as const)('still closes on fatal read %s after a warning', async failure => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'pod/exec-open') return {sessionId: 'terminal'}
      if (method === 'session/read') {
        if (failure === 'rejection') throw new Error('fatal read error')
        return {sessionId: 'terminal', droppedBytes: 64, data: 'last output', error: 'fatal read error'}
      }
      return {ok: true}
    })
    const socket = createDBXTerminalSocket(new DBXTransport(invoke, 'cluster'), {})
    const messages: Array<{type: string; data: string}> = []
    const onclose = vi.fn()
    socket.onmessage = event => messages.push(JSON.parse(event.data))
    socket.onclose = onclose
    await vi.advanceTimersByTimeAsync(0)
    if (failure === 'frame') expect(messages.map(message => message.type)).toEqual(['warning', 'stdout', 'error'])
    expect(messages[messages.length - 1]).toEqual({type: 'error', data: 'fatal read error'})
    expect(socket.readyState).toBe(3)
    expect(onclose).toHaveBeenCalledExactlyOnceWith({code: 1006})
    socket.send(JSON.stringify({type: 'stdin', data: 'later'}))
    socket.send(JSON.stringify({type: 'resize', cols: 80, rows: 24}))
    await vi.advanceTimersByTimeAsync(1000)
    expect(invoke.mock.calls.map(([method]) => method)).toEqual(['pod/exec-open', 'session/read', 'session/close'])
  })

  it.each(['local', 'fatal'] as const)('reports cleanup RPC failure after %s close without reviving the socket', async closure => {
    const read = deferred<SessionFrame>()
    const cleanup = deferred<unknown>()
    const invoke = vi.fn(async (method: string) => {
      if (method === 'pod/exec-open') return {sessionId: 'terminal'}
      if (method === 'session/read') return read.promise
      if (method === 'session/close') return cleanup.promise
      return {ok: true}
    })
    const socket = createDBXTerminalSocket(new DBXTransport(invoke, 'cluster'), {})
    const messages: unknown[] = []
    const onclose = vi.fn(), onopen = vi.fn()
    socket.onmessage = event => messages.push(JSON.parse(event.data))
    socket.onclose = onclose
    socket.onopen = onopen
    await vi.advanceTimersByTimeAsync(0)
    if (closure === 'local') socket.close()
    else read.reject(new Error('fatal read error'))
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.readyState).toBe(3)
    cleanup.reject(new Error('cleanup failed: permission denied'))
    await vi.advanceTimersByTimeAsync(0)
    expect(messages[messages.length - 1]).toEqual({type: 'warning', data: 'cleanup failed: permission denied'})
    expect(onclose).toHaveBeenCalledExactlyOnceWith({code: closure === 'local' ? 1000 : 1006})
    expect(onopen).toHaveBeenCalledOnce()
    expect(socket.readyState).toBe(3)
    socket.send(JSON.stringify({type: 'stdin', data: 'later'}))
    socket.close()
    read.resolve({sessionId: 'terminal', closed: true})
    await vi.advanceTimersByTimeAsync(1000)
    expect(invoke.mock.calls.map(([method]) => method)).toEqual(['pod/exec-open', 'session/read', 'session/close'])
  })

  it('does not close again when the backend has already removed a closed session', async () => {
    const invoke = vi.fn(async (method: string) => {
      if (method === 'pod/exec-open') return {sessionId: 'terminal'}
      if (method === 'session/close') throw new Error('session not found')
      return {sessionId: 'terminal', closed: true, error: 'terminal exited'}
    })
    const socket = createDBXTerminalSocket(new DBXTransport(invoke, 'cluster'), {})
    const messages: unknown[] = []
    socket.onmessage = event => messages.push(JSON.parse(event.data))
    await vi.advanceTimersByTimeAsync(0)
    socket.close()
    expect(messages).toEqual([{type: 'error', data: 'terminal exited'}])
    expect(invoke.mock.calls.map(([method]) => method)).toEqual(['pod/exec-open', 'session/read'])
  })

  it('passes warnings to stream callbacks without requiring a warning handler', async () => {
    for (const handleWarnings of [true, false]) {
      const invoke = vi.fn(async (method: string) => method === 'pod/logs-open'
        ? {sessionId: 'logs'}
        : {sessionId: 'logs', droppedBytes: 16, warning: 'cleanup warning', data: 'tail', closed: true})
      const onWarning = vi.fn(), onData = vi.fn(), onError = vi.fn(), onClose = vi.fn()
      startSessionStream(new DBXTransport(invoke, 'cluster'), 'pod/logs-open', {}, {
        onWarning: handleWarnings ? onWarning : undefined, onData, onError, onClose,
      })
      await vi.advanceTimersByTimeAsync(0)
      if (handleWarnings) expect(onWarning.mock.calls).toEqual([
        [i18n.t('terminalContent.outputTruncated', {bytes: 16})], ['cleanup warning'],
      ])
      expect(onData).toHaveBeenCalledExactlyOnceWith('tail')
      expect(onError).not.toHaveBeenCalled()
      expect(onClose).toHaveBeenCalledOnce()
    }
  })

  it.each(['stream', 'socket'] as const)('cleans a late session ID after %s.close without reopening or reading', async kind => {
    const opened = deferred<SessionFrame>()
    const invoke = vi.fn(async (method: string) => method === 'pod/exec-open' ? opened.promise : {ok: true})
    const transport = new DBXTransport(invoke, 'cluster')
    const onOpen = vi.fn(), onData = vi.fn(), onWarning = vi.fn(), onError = vi.fn(), onClose = vi.fn()
    const session = kind === 'stream'
      ? startSessionStream(transport, 'pod/exec-open', {}, {onOpen, onData, onWarning, onError, onClose})
      : createDBXTerminalSocket(transport, {})
    if ('readyState' in session) {
      session.onopen = onOpen
      session.onmessage = onData
      session.onclose = onClose
    }
    session.close()
    session.close()
    opened.resolve({sessionId: 'late-session'})
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke.mock.calls.map(([method]) => method)).toEqual(['pod/exec-open', 'session/close'])
    expect(invoke).toHaveBeenCalledWith('session/close', {sessionId: 'late-session', connectionId: 'cluster'})
    expect(onOpen).not.toHaveBeenCalled()
    expect(onData).not.toHaveBeenCalled()
    expect(onWarning).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(kind === 'socket' ? 1 : 0)
  })

  it.each([false, true])('only delivers a final cleanup warning after local close (closed=%s)', async closed => {
    const read = deferred<SessionFrame>()
    const invoke = vi.fn(async (method: string) => {
      if (method === 'pod/exec-open') return {sessionId: 'terminal'}
      if (method === 'session/read') return read.promise
      return {ok: true}
    })
    const socket = createDBXTerminalSocket(new DBXTransport(invoke, 'cluster'), {})
    const onmessage = vi.fn(), onclose = vi.fn()
    socket.onmessage = onmessage
    socket.onclose = onclose
    await vi.advanceTimersByTimeAsync(0)
    socket.close()
    read.resolve({sessionId: 'terminal', droppedBytes: 32, warning: 'late warning', data: 'late output', error: 'late error', closed})
    await vi.advanceTimersByTimeAsync(0)
    if (closed) expect(onmessage).toHaveBeenCalledExactlyOnceWith({data: JSON.stringify({type: 'warning', data: 'late warning'})})
    else expect(onmessage).not.toHaveBeenCalled()
    expect(socket.readyState).toBe(3)
    expect(onclose).toHaveBeenCalledExactlyOnceWith({code: 1000})
    expect(invoke.mock.calls.filter(([method]) => method === 'session/close')).toHaveLength(1)
  })

  it.each(['close-first', 'read-first', 'close-success'] as const)('keeps delayed final cleanup warnings and deduplicates cleanup failures (%s)', async order => {
    const read = deferred<SessionFrame>(), cleanup = deferred<unknown>()
    let removed = false
    const warning = 'Temporary terminal resources could not be cleaned up: forbidden'
    const invoke = vi.fn(async (method: string) => {
      if (method === 'pod/exec-open') return {sessionId: 'terminal'}
      if (method === 'session/read') {removed = true; return read.promise}
      if (method === 'session/close') {expect(removed).toBe(true); return cleanup.promise}
      return {ok: true}
    })
    const socket = createDBXTerminalSocket(new DBXTransport(invoke, 'cluster'), {})
    const messages: unknown[] = [], onclose = vi.fn(), onopen = vi.fn()
    socket.onmessage = event => messages.push(JSON.parse(event.data))
    socket.onclose = onclose
    socket.onopen = onopen
    await vi.advanceTimersByTimeAsync(0)
    socket.close()
    if (order === 'close-first') cleanup.reject(new Error(warning))
    if (order === 'close-success') cleanup.resolve({closed: true})
    await vi.advanceTimersByTimeAsync(0)
    read.resolve({sessionId: 'terminal', closed: true, warning, data: 'late output', error: 'late error'})
    await vi.advanceTimersByTimeAsync(0)
    if (order === 'read-first') cleanup.reject(new Error(warning))
    await vi.advanceTimersByTimeAsync(1000)
    expect(messages).toEqual([{type: 'warning', data: warning}])
    expect(onopen).toHaveBeenCalledOnce()
    expect(onclose).toHaveBeenCalledExactlyOnceWith({code: 1000})
    expect(socket.readyState).toBe(3)
    expect(invoke.mock.calls.map(([method]) => method)).toEqual(['pod/exec-open', 'session/read', 'session/close'])
  })

  it.each(languages.map(language => language.code))('localizes output truncation with byte interpolation in %s', locale => {
    const text = i18n.getFixedT(locale)('terminalContent.outputTruncated', {bytes: 128})
    expect(i18n.getResource(locale, 'translation', 'terminalContent.outputTruncated')).toBeTruthy()
    expect(text).toContain('128')
    expect(text).not.toContain('{{')
    expect(text).not.toBe('terminalContent.outputTruncated')
    if (locale !== 'en') expect(text).not.toBe(i18n.getFixedT('en')('terminalContent.outputTruncated', {bytes: 128}))
  })
})

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
