import { UsageDataPoint } from '@/types/api'

import i18n from '@/i18n'

const SERIES_COLORS = [
  'hsl(220 70% 50%)',
  'hsl(142 70% 42%)',
  'hsl(28 82% 50%)',
  'hsl(285 65% 52%)',
  'hsl(350 70% 50%)',
  'hsl(190 75% 42%)',
]

export interface MonitoringSeries {
  key: string
  label: string
  color: string
}

export interface MonitoringChartPoint {
  timestamp: string
  time: number
  [series: string]: string | number | undefined
}

export function buildMonitoringSeries(data: UsageDataPoint[]) {
  const seriesByKey = new Map<string, MonitoringSeries>()
  const pointsByTimestamp = new Map<number, MonitoringChartPoint>()

  for (const point of data) {
    const key = point.series || 'total'
    if (!seriesByKey.has(key)) {
      seriesByKey.set(key, {
        key,
        label: point.series || i18n.t('monitoring.total'),
        color: SERIES_COLORS[seriesByKey.size % SERIES_COLORS.length],
      })
    }

    const time = new Date(point.timestamp).getTime()
    const chartPoint = pointsByTimestamp.get(time) || {
      timestamp: point.timestamp,
      time,
    }
    chartPoint[key] = Math.max(0, point.value)
    pointsByTimestamp.set(time, chartPoint)
  }

  return {
    series: Array.from(seriesByKey.values()),
    points: Array.from(pointsByTimestamp.values()).sort((a, b) => a.time - b.time),
  }
}
