export interface RequestError extends Error {
  code?: string
  rpcCode?: number
  retryable?: boolean
  status?: number
}

type ErrorFields = Record<string, unknown>
const fields = (value: unknown): ErrorFields =>
  value !== null && typeof value === 'object' ? value as ErrorFields : {}

export function normalizeRequestError(value: unknown): RequestError {
  const outer = fields(value)
  const envelope = fields(outer.error)
  const source = typeof envelope.message === 'string' ? envelope : outer
  const data = fields(source.data)
  const message = typeof source.message === 'string' ? source.message
    : typeof value === 'string' ? value : 'Request failed'
  const error = (value instanceof Error ? value : new Error(message)) as RequestError
  if (!(value instanceof Error)) error.name = typeof source.name === 'string' ? source.name : 'RequestError'
  const code = typeof data.code === 'string' ? data.code
    : typeof source.code === 'string' ? source.code : undefined
  if (code !== undefined) error.code = code
  const rpcCode = typeof source.code === 'number' ? source.code : source.rpcCode
  if (typeof rpcCode === 'number') error.rpcCode = rpcCode
  const status = typeof data.status === 'number' ? data.status : source.status
  if (typeof status === 'number') error.status = status
  const retryable = typeof data.retryable === 'boolean' ? data.retryable : source.retryable
  if (typeof retryable === 'boolean') error.retryable = retryable
  return error
}

export function isRetryableReadError(value: unknown): boolean {
  const error = normalizeRequestError(value)
  if (error.name === 'AbortError' ||
      ['unauthorized', 'forbidden', 'not_found', 'invalid_params', 'canceled', 'not_connected', 'conflict'].includes(error.code || '') ||
      [400, 401, 403, 404, 409, 422].includes(error.status || 0)) return false
  if (error.retryable === false) return false
  if (['timeout', 'network', 'unavailable'].includes(error.code || '') ||
      [408, 429, 500, 502, 503, 504].includes(error.status || 0)) return true
  // Older hosts may drop RPC error.data. Match only transport failures, not
  // arbitrary errors or ambiguous text containing the word "timeout".
  return /context deadline exceeded|\bTLS handshake timeout\b|\bi\/o timeout\b|\bnet\/http: timeout\b|\bconnection (?:reset by peer|refused)\b|\bnetwork is unreachable\b|\bno route to host\b/.test(error.message) ||
    /^Plugin '[^']+' request '(?:resource\/list|kube\/discover)' timed out after \d+ seconds$/.test(error.message)
}
