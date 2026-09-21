import { Loader2, Maximize2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { CardAction, CardHeader, CardTitle } from '../ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

import { MonitoringChartHelp } from './monitoring-chart-help'

interface MonitoringChartHeaderProps {
  title: string
  description: string
  query: string
  loading?: boolean
  onExpand?: () => void
}

export function MonitoringChartHeader({
  title,
  description,
  query,
  loading = false,
  onExpand,
}: MonitoringChartHeaderProps) {
  const { t } = useTranslation()

  return (
    <CardHeader>
      <CardTitle className={loading ? 'flex items-center gap-2' : undefined}>
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        {title}
      </CardTitle>
      <CardAction className="flex items-center gap-1">
        <MonitoringChartHelp description={description} query={query} />
        {onExpand && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onExpand}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t('monitoring.expandChart')}
              >
                <Maximize2 className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>
              {t('monitoring.expandChart')}
            </TooltipContent>
          </Tooltip>
        )}
      </CardAction>
    </CardHeader>
  )
}
