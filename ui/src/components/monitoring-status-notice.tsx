import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useTranslation } from 'react-i18next'

export type MonitoringErrorKind = 'connection' | 'metrics' | 'unknown'

export function getMonitoringErrorKind(error: unknown): MonitoringErrorKind {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (
    message.includes('prometheus_not_configured') ||
    message.includes('prometheus_unreachable')
  ) {
    return 'connection'
  }
  if (message.includes('prometheus_metrics_missing')) return 'metrics'
  return 'unknown'
}

export function MonitoringStatusNotice({
  error,
  connectionUnavailable = false,
}: {
  error?: unknown
  connectionUnavailable?: boolean
}) {
  const { t } = useTranslation()
  if (!error && !connectionUnavailable) return null

  const kind = connectionUnavailable
    ? 'connection'
    : getMonitoringErrorKind(error)
  if (kind === 'unknown') return null

  return (
    <Alert variant="destructive" className="mb-4">
      <AlertTitle>
        {t(
          kind === 'connection'
            ? 'monitoring.prometheusConnectionTitle'
            : 'monitoring.prometheusMetricsTitle'
        )}
      </AlertTitle>
      <AlertDescription>
        {t(
          kind === 'connection'
            ? 'monitoring.prometheusConnectionDescription'
            : 'monitoring.prometheusMetricsDescription'
        )}
      </AlertDescription>
    </Alert>
  )
}
