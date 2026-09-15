import type { DBXTransport } from './dbx-transport'
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
        if (frame.data) callbacks.onData?.(frame.data)
        if (frame.error) throw new Error(frame.error)
        if (frame.closed) break
        await new Promise<void>(resolve => {wake = resolve; timer = setTimeout(resolve, 250)})
      }
    } catch (error) {if (!stopped) callbacks.onError?.(error instanceof Error ? error : new Error(String(error)))}
    finally {closeRemote(); if (!stopped) callbacks.onClose?.()}
  }
  void run()
  return {close() {stopped = true; clearTimeout(timer); wake?.(); closeRemote()}, send(method: string, params: Record<string, unknown>) { if (stopped || !id) return Promise.reject(new Error('Session is not connected')); return transport.rpc(method, {...params, sessionId: id}) }}
}
export type TerminalSocket = {readyState: number; onopen: (() => void) | null; onmessage: ((event: {data: string}) => void) | null; onerror: ((error: unknown) => void) | null; onclose: ((event: {code: number}) => void) | null; send: (data: string) => void; close: () => void}
export function createDBXTerminalSocket(transport: DBXTransport, params: Record<string, unknown>): TerminalSocket {
  const socket: TerminalSocket = {readyState: 0, onopen: null, onmessage: null, onerror: null, onclose: null, send(data) {
    const message = JSON.parse(data)
    if (message.type === 'ping') return
    const method = message.type === 'resize' ? 'pod/exec-resize' : 'pod/exec-write'
    void stream.send(method, message.type === 'resize' ? {cols: message.cols, rows: message.rows} : {data: message.data}).catch(error => socket.onerror?.(error))
  }, close() {stream.close(); socket.readyState = 3; socket.onclose?.({code: 1000})}}
  const stream = startSessionStream(transport, 'pod/exec-open', {...params, command: ['sh'], tty: true}, {
    onOpen: () => {socket.readyState = 1; socket.onopen?.()},
    onData: data => socket.onmessage?.({data: JSON.stringify({type: 'stdout', data})}),
    onError: error => socket.onmessage?.({data: JSON.stringify({type: 'error', data: error.message})}),
    onClose: () => {socket.readyState = 3; socket.onclose?.({code: 1000})}
  })
  return socket
}
