import { describe, expect, it } from 'vitest'

import { podMetricsRefetchInterval } from './observability'

describe('podMetricsRefetchInterval', () => {
  it('disables polling when monitoring refresh is turned off', () => {
    expect(podMetricsRefetchInterval(0)).toBe(false)
  })

  it('keeps explicit intervals and the default polling interval', () => {
    expect(podMetricsRefetchInterval(5_000)).toBe(5_000)
    expect(podMetricsRefetchInterval()).toBe(30_000)
  })
})
