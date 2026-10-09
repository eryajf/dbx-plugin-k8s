import type { DBXTransport } from './dbx-transport'
import { TerminalInputError } from './dbx-terminal-errors'
export type SessionFrame = {sessionId: string; data?: string; closed?: boolean; error?: string; droppedBytes?: number}
export function startSessionStream(transport: DBXTransport, method: string, params: Record<string, unknown>, callbacks: {onOpen?: (id: string) => void; onData?: (data: string) => void; onError?: (error: Error) => void; onClose?: () => void}) {
  let stopped = false, id = '', closing = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined
  const closeRemote = () => { if (!id || closing) return; closing = true; void transport.rpc('session/close', {sessionId: id}).catch(() => {}) }
  const run = async () => {
    try {
      const opened = await transport.rpc<SessionFrame>(method, params)
      id = opened.sessionId
      if (!id) throw new Error('Session ID missing')
      if (stopped) return
      callbacks.onOpen?.(id)
      while (!stopped) {
        const frame = await transport.rpc<SessionFrame>('session/read', {sessionId: id})
        if (stopped) break
        if (frame.droppedBytes) callbacks.onError?.(new Error(`输出缓冲区丢失 ${frame.droppedBytes} 字节`))
        if (stopped) break
        if (frame.data) callbacks.onData?.(frame.data)
        if (frame.error) throw new Error(frame.error)
        if (frame.closed) break
        await new Promise<void>(resolve => {wake = resolve; timer = setTimeout(resolve, 250)})
      }
    } catch (error) {if (!stopped) callbacks.onError?.(error instanceof Error ? error : new Error(String(error)))}
    finally {closeRemote(); if (!stopped) {stopped = true; callbacks.onClose?.()}}
  }
  void run()
  return {close() {stopped = true; clearTimeout(timer); wake?.(); closeRemote()}, send(method: string, params: Record<string, unknown>) { if (stopped || !id) return Promise.reject(new Error('Session is not connected')); return transport.rpc(method, {...params, sessionId: id}) }}
}
export type TerminalSocket = {readyState: number; onopen: (() => void) | null; onmessage: ((event: {data: string}) => void) | null; onerror: ((error: unknown) => void) | null; onclose: ((event: {code: number}) => void) | null; send: (data: string) => void; close: () => void}
export function createDBXTerminalSocket(transport: DBXTransport, params: Record<string, unknown>): TerminalSocket {
  const type = params.type === 'node' || params.type === 'kubectl' ? params.type : 'pod'
  const openMethod = type === 'node' ? 'node/exec-open' : type === 'kubectl' ? 'kubectl/exec-open' : 'pod/exec-open'
  const openParams = type === 'node'
    ? {node: params.nodeName}
    : type === 'kubectl'
      ? {}
      : {namespace: params.namespace, name: params.name, container: params.container, command: ['sh', '-c', 'bash || sh'], tty: true}
  let closed = false
  const encoder = new TextEncoder()
  const maxWriteBytes = 64 * 1024
  const maxPendingBytes = 256 * 1024
  let pending = '', pendingBytes = 0, writing = false
  const finish = (code: number, error?: unknown) => {
    if (closed) return
    closed = true
    pending = ''
    pendingBytes = 0
    socket.readyState = 3
    stream.close()
    if (error !== undefined) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof TerminalInputError ? error.code : undefined
      socket.onmessage?.({data: JSON.stringify({type: 'error', data: message, code})})
    }
    socket.onclose?.({code})
  }
  const flushInput = async () => {
    if (writing || closed) return
    writing = true
    try {
      while (pending && !closed) {
        // Preserve Unicode characters and the backend's UTF-8 byte limit.
        let length = 0, bytes = 0
        for (const character of pending) {
          const size = encoder.encode(character).length
          if (bytes + size > maxWriteBytes) break
          length += character.length
          bytes += size
        }
        const data = pending.slice(0, length)
        pending = pending.slice(length)
        // Only one write may be in flight: the Sidecar dispatches RPCs concurrently.
        const result = await stream.send('terminal/exec-write', {data}) as {written: number}
        if (closed) return
        if (result?.written !== bytes) throw new TerminalInputError('INPUT_INCOMPLETE')
        pendingBytes -= bytes
      }
    } catch (error) {
      // A failed RPC may already have written data. Never retry it automatically.
      finish(1006, error)
    } finally {
      writing = false
    }
  }
  const socket: TerminalSocket = {readyState: 0, onopen: null, onmessage: null, onerror: null, onclose: null, send(data) {
    if (closed || socket.readyState !== 1) return
    try {
      const message = JSON.parse(data)
      if (message.type === 'ping') return
      if (message.type === 'resize') {
        void stream.send('terminal/exec-resize', {cols: message.cols, rows: message.rows}).catch(error => finish(1006, error))
        return
      }
      if (message.type !== 'stdin' || typeof message.data !== 'string') throw new TerminalInputError('INPUT_INVALID')
      const bytes = encoder.encode(message.data).length
      if (pendingBytes + bytes > maxPendingBytes) throw new TerminalInputError('INPUT_QUEUE_FULL')
      pending += message.data
      pendingBytes += bytes
      void flushInput()
    } catch (error) {
      finish(1006, error)
    }
  }, close() {
    finish(1000)
  }}
  const stream = startSessionStream(transport, openMethod, openParams, {
    onOpen: () => {if (closed) return; socket.readyState = 1; socket.onopen?.()},
    onData: data => {if (!closed) socket.onmessage?.({data: JSON.stringify({type: 'stdout', data})})},
    onError: error => finish(1006, error),
    onClose: () => finish(1000)
  })
  return socket
}
