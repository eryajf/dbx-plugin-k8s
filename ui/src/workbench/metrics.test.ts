import { describe, expect, it } from 'vitest'
import { metricValue } from './metrics'

describe('metricValue', () => {
  it('normalizes CPU units to millicores', () => {
    expect(metricValue('500m', 'cpu')).toBe(500)
    expect(metricValue('100000000n', 'cpu')).toBe(100)
    expect(metricValue('2', 'cpu')).toBe(2000)
  })
  it('normalizes binary memory units to GiB', () => {
    expect(metricValue('512Mi', 'memory')).toBeCloseTo(0.5)
    expect(metricValue('2Gi', 'memory')).toBe(2)
  })
  it('returns zero for malformed values', () => expect(metricValue('unknown', 'memory')).toBe(0))
})
