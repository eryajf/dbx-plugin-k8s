import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_MONITORING_REFRESH_INTERVAL,
  monitoringTimeRangeOptions,
} from './monitoring-options'

describe('monitoring options', () => {
  it('offers three, six, and twelve hour ranges after one hour', () => {
    const t = vi.fn((key: string, options?: { count?: number }) =>
      options?.count ? `${key}:${options.count}` : key
    )

    expect(monitoringTimeRangeOptions(t)).toEqual([
      { value: '15m', label: 'monitoringControls.last15Min' },
      { value: '30m', label: 'monitoringControls.last30Min' },
      { value: '1h', label: 'monitoringControls.last1Hour' },
      { value: '3h', label: 'monitoringControls.lastHours:3' },
      { value: '6h', label: 'monitoringControls.lastHours:6' },
      { value: '12h', label: 'monitoringControls.lastHours:12' },
      { value: '24h', label: 'monitoringControls.last24Hours' },
      { value: '2d', label: 'monitoringControls.last2Days' },
      { value: '7d', label: 'monitoringControls.last7Days' },
    ])
  })

  it('defaults monitoring refreshes to five seconds', () => {
    expect(DEFAULT_MONITORING_REFRESH_INTERVAL).toBe(5_000)
  })
})
