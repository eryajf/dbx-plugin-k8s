import type { TFunction } from 'i18next'

export const DEFAULT_MONITORING_REFRESH_INTERVAL = 5 * 1000

export function monitoringTimeRangeOptions(t: TFunction) {
  return [
    { value: '15m', label: t('monitoringControls.last15Min') },
    { value: '30m', label: t('monitoringControls.last30Min') },
    { value: '1h', label: t('monitoringControls.last1Hour') },
    { value: '3h', label: t('monitoringControls.lastHours', { count: 3 }) },
    { value: '6h', label: t('monitoringControls.lastHours', { count: 6 }) },
    { value: '12h', label: t('monitoringControls.lastHours', { count: 12 }) },
    { value: '24h', label: t('monitoringControls.last24Hours') },
    { value: '2d', label: t('monitoringControls.last2Days') },
    { value: '7d', label: t('monitoringControls.last7Days') },
  ]
}
