import { describe, expect, it } from 'vitest'
import { isRetryableReadError, normalizeRequestError } from './request-errors'

describe('request error boundary', () => {
  it('keeps the RPC number separate from the business code', () => {
    const error = normalizeRequestError({ code: -32000, message: 'slow', data: { code: 'timeout', retryable: true, status: 504 } })
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ code: 'timeout', rpcCode: -32000, retryable: true, status: 504, message: 'slow' })
    expect(isRetryableReadError(error)).toBe(true)
  })
  it('accepts an error envelope without losing its message', () => {
    expect(normalizeRequestError({ error: { code: -32602, message: 'bad parameters', data: { code: 'invalid_params' } } }))
      .toMatchObject({ rpcCode: -32602, message: 'bad parameters', code: 'invalid_params' })
  })
  it.each(['unauthorized', 'forbidden', 'not_found', 'invalid_params', 'canceled', 'not_connected', 'conflict'])('does not retry %s even with an inconsistent retryable flag', code => {
    expect(isRetryableReadError({ message: 'context deadline exceeded', data: { code, retryable: true } })).toBe(false)
  })
  it.each([400, 401, 403, 404, 409, 422])('does not retry permanent HTTP status %s', status => {
    expect(isRetryableReadError({ message: 'context deadline exceeded', status, retryable: true })).toBe(false)
  })
  it.each([408, 429, 500, 502, 503, 504])('retries temporary HTTP status %s', status => {
    expect(isRetryableReadError({ status, message: 'temporary' })).toBe(true)
  })
  it.each([
    'Get "https://cluster/api/v1": context deadline exceeded',
    'dial tcp: i/o timeout',
    "Plugin 'io.dbx.k8s' request 'resource/list' timed out after 10 seconds",
  ])('recognizes exact transport failures on hosts that drop data: %s', message => {
    expect(isRetryableReadError(new Error(message))).toBe(true)
  })
  it.each(['invalid timeout parameter', 'context canceled', 'Forbidden', 'unknown error', "Plugin 'io.dbx.k8s' request 'resource/delete' timed out after 10 seconds"])('does not guess unknown error retryability: %s', message => {
    expect(isRetryableReadError(new Error(message))).toBe(false)
  })
  it('honors cancellation and an explicit nonretryable flag', () => {
    expect(isRetryableReadError(new DOMException('context deadline exceeded', 'AbortError'))).toBe(false)
    expect(isRetryableReadError({ name: 'AbortError', message: 'context deadline exceeded' })).toBe(false)
    expect(isRetryableReadError({ message: 'context deadline exceeded', retryable: false })).toBe(false)
  })
})
