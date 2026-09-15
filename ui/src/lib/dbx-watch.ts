import { resolveDBXResource } from './dbx-resource-discovery'
import type { DBXInvoke } from './dbx-transport'
export type WatchEvent = {type: string; object: {metadata?: {name?: string; namespace?: string}; [key: string]: unknown}}
type Frame = {sessionId: string; data: string; closed: boolean; error?: string; droppedBytes?: number}
export function startDBXWatch(connectionId: string, resource: string, namespace: string | undefined, options: {invoke: DBXInvoke; labelSelector?: string; fieldSelector?: string}, onEvent: (event: WatchEvent) => void, onError: (error: unknown) => void): () => void {
  let stopped = false, sessionId = '', buffer = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined
  let closeStarted = false
  const close = () => { if (!sessionId || closeStarted) return; closeStarted = true; void options.invoke('resource/watch-close', {connectionId, sessionId}).catch(() => {}) }
  const run = async () => {
    try {
      const descriptor = await resolveDBXResource(connectionId, resource, options.invoke)
      if (stopped) return
      const opened = await options.invoke('resource/watch', {connectionId, ...descriptor, namespace: descriptor.namespaced ? namespace || '' : '', selector: options.labelSelector, fieldSelector: options.fieldSelector}) as Frame
      sessionId = opened.sessionId
      if (!sessionId) throw new Error('Watch did not return a session ID')
      while (!stopped) {
        const frame = await options.invoke('resource/watch-read', {connectionId, sessionId}) as Frame
        if (stopped) break
        if (frame.droppedBytes) throw new Error('资源变更缓冲区已溢出，请刷新列表重新同步')
        buffer += frame.data || ''
        const lines = buffer.split('\n'); buffer = lines.pop() || ''
        for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as WatchEvent)
        if (frame.error) throw new Error(frame.error)
        if (frame.closed) throw new Error('资源监听已断开，请重新连接')
        await new Promise<void>(resolve => {wake = resolve; timer = setTimeout(resolve, 500)})
      }
    } catch (error) { if (!stopped) onError(error) }
    finally { close() }
  }
  void run()
  return () => {stopped = true; clearTimeout(timer); wake?.(); close()}
}
