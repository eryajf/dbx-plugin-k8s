import { focusManager } from '@tanstack/react-query'

import { isRetryableReadError } from './request-errors'

// Three attempts at 10s each, plus at most 3.75s of backoff. This budget is
// local to resource reads; mutations and other query hooks keep their policy.
export const RESOURCE_READ_TIMEOUT_MS = 10_000
export const RESOURCE_READ_MAX_RETRIES = 2

export function resourceQueryIsVisible() {
  return (
    (typeof document === 'undefined' || document.visibilityState !== 'hidden') &&
    focusManager.isFocused()
  )
}

export function retryResourceRead(failureCount: number, error: unknown) {
  return (
    failureCount < RESOURCE_READ_MAX_RETRIES &&
    resourceQueryIsVisible() &&
    isRetryableReadError(error)
  )
}

export function resourceReadRetryDelay(attempt: number, random = Math.random()) {
  return Math.min(1000 * 2 ** attempt, 2000) * (0.75 + random * 0.5)
}

export function resourceRecoveryInterval(
  interval: number | undefined,
  error: unknown,
  consecutiveFailures: number
): number | false {
  if (!interval || interval <= 0) return false
  if (!error) return interval
  if (!isRetryableReadError(error)) return false
  return Math.min(Math.max(consecutiveFailures, 1), 3) * 10_000
}

export function canShowResourceSnapshot(data: unknown, error: unknown) {
  return data !== undefined && (!error || isRetryableReadError(error))
}
