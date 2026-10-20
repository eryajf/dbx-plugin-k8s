import type { DBXInvoke } from './dbx-transport'
import { normalizeRequestError } from './request-errors'

export interface DBXRequestOptions {
  timeoutMs?: number
  signal?: AbortSignal | null
}

const pendingReads = new Map<string, Promise<unknown>>()
const abortError = () => new DOMException('Request canceled', 'AbortError')
const timeoutError = () => Object.assign(new Error('Resource read timed out'), {
  code: 'timeout', retryable: true,
})

export function waitForRequest<T>(promise: Promise<T>, signal?: AbortSignal | null, timeoutMs?: number): Promise<T> {
  if (!signal && timeoutMs === undefined) return promise
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); reject(abortError()) }
    if (timeoutMs !== undefined) timer = setTimeout(() => {
      cleanup()
      reject(timeoutError())
    }, Math.max(1, Math.min(60_000, timeoutMs)))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    promise.then(value => {
      cleanup()
      if (signal?.aborted) reject(abortError())
      else resolve(value)
    }, error => {
      cleanup()
      reject(signal?.aborted ? abortError() : error)
    })
  })
}

export function scopedDBXInvoke(invoke: DBXInvoke, options: DBXRequestOptions = {}): DBXInvoke {
  const budget = options.timeoutMs === undefined ? undefined
    : Math.max(1, Math.min(60_000, options.timeoutMs))
  const deadline = budget === undefined ? undefined : Date.now() + budget
  return async (method, params) => {
    if (options.signal?.aborted) throw abortError()
    const remaining = deadline === undefined ? undefined : Math.max(0, deadline - Date.now())
    if (remaining === 0) throw timeoutError()
    // Only lists opt into bounded/coalesced reads. Mutations are never replayed.
    const boundedList = method === 'resource/list' && remaining !== undefined
    const rpcParams = boundedList ? { ...params, requestTimeoutMs: remaining } : params
    const key = boundedList ? JSON.stringify([method, params, budget]) : undefined
    let request = key ? pendingReads.get(key) : undefined
    if (!request) {
      const pending = remaining === undefined
        ? invoke(method, rpcParams)
        : invoke(method, rpcParams, { timeoutMs: remaining })
      request = remaining === undefined ? pending : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(timeoutError()), remaining)
        pending.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
      })
      request = request.catch(error => { throw normalizeRequestError(error) })
      if (key) {
        const tracked = request.finally(() => { if (pendingReads.get(key) === tracked) pendingReads.delete(key) })
        pendingReads.set(key, tracked)
        request = tracked
      }
    }
    // Canceling an observer cannot cancel the host RPC. Keep its in-flight read
    // available to a returning observer rather than spawning a duplicate.
    // Resource resolution shares its discovery promise across observers. One
    // observer must not reject that promise for all other resource readers.
    return method === 'kube/discover' ? request : waitForRequest(request, options.signal)
  }
}
