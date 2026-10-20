import { focusManager } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'

import {
  canShowResourceSnapshot,
  resourceReadRetryDelay,
  resourceRecoveryInterval,
  retryResourceRead,
} from './resource-query-recovery'

const temporary = Object.assign(new Error('Service unavailable'), { status: 503, retryable: true })

afterEach(() => focusManager.setFocused(undefined))

describe('resource read recovery policy', () => {
  it('bounds retries and exponential jitter within the 33.75s active attempt budget', () => {
    expect(retryResourceRead(0, temporary)).toBe(true)
    expect(retryResourceRead(1, temporary)).toBe(true)
    expect(retryResourceRead(2, temporary)).toBe(false)
    expect(resourceReadRetryDelay(0, 0)).toBe(750)
    expect(resourceReadRetryDelay(1, 1)).toBe(2500)
  })

  it('does not add retries while hidden', () => {
    focusManager.setFocused(false)
    expect(retryResourceRead(0, temporary)).toBe(false)
  })

  it('recovers at 10/20/30 seconds and restores the selected interval after success', () => {
    expect([1, 2, 3, 9].map(n => resourceRecoveryInterval(1000, temporary, n))).toEqual([10000, 20000, 30000, 30000])
    expect(resourceRecoveryInterval(1000, null, 9)).toBe(1000)
    expect(resourceRecoveryInterval(0, temporary, 1)).toBe(false)
  })

  it.each([
    Object.assign(new Error('Unauthorized'), { status: 401 }),
    Object.assign(new Error('Forbidden'), { status: 403 }),
    new Error('Unknown request failure'),
  ])('never retries, probes or displays old rows for permanent/unknown error %s', error => {
    expect(retryResourceRead(0, error)).toBe(false)
    expect(resourceRecoveryInterval(5000, error, 1)).toBe(false)
    expect(canShowResourceSnapshot([], error)).toBe(false)
  })

  it('treats an empty successful list as a snapshot, but not an initial failure', () => {
    expect(canShowResourceSnapshot([], temporary)).toBe(true)
    expect(canShowResourceSnapshot([{ metadata: { name: 'old' } }], temporary)).toBe(true)
    expect(canShowResourceSnapshot(undefined, temporary)).toBe(false)
  })
})
