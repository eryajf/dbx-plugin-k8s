import { describe, expect, it } from 'vitest'

import { buildMonitoringSeries } from './monitoring-chart-series'

describe('buildMonitoringSeries', () => {
  it('keeps every Pod/container series on the same chart timeline', () => {
    const { points, series } = buildMonitoringSeries([
      { timestamp: '2026-09-21T09:00:00Z', value: 0.2, series: 'api-a/app' },
      { timestamp: '2026-09-21T09:00:00Z', value: 0.3, series: 'api-b/app' },
      { timestamp: '2026-09-21T09:01:00Z', value: 0.4, series: 'api-a/app' },
    ])

    expect(series.map((item) => item.label)).toEqual(['api-a/app', 'api-b/app'])
    expect(points).toHaveLength(2)
    expect(points[0]['api-a/app']).toBe(0.2)
    expect(points[0]['api-b/app']).toBe(0.3)
  })
})
