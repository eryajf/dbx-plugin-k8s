import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useResourceUsageHistory } from '@/lib/api'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import NetworkUsageChart from './chart/network-usage-chart'
import ResourceUtilizationChart from './chart/resource-utilization'
import {
  getMonitoringErrorKind,
  MonitoringStatusNotice,
} from './monitoring-status-notice'

interface NodeMonitoringProps {
  name: string
}

export function NodeMonitoring({ name }: NodeMonitoringProps) {
  const { t } = useTranslation()
  const [timeRange, setTimeRange] = useState('1h')

  const {
    data: resourceUsage,
    isLoading: isLoadingResourceUsage,
    error: errorResourceUsage,
  } = useResourceUsageHistory(timeRange, {
    instance: name,
  })

  const timeRangeOptions = [
    { value: '15m', label: t('monitoringControls.last15Min') },
    { value: '30m', label: t('monitoringControls.last30Min') },
    { value: '1h', label: t('monitoringControls.last1Hour') },
    { value: '24h', label: t('monitoringControls.last24Hours') },
    { value: '2d', label: t('monitoringControls.last2Days') },
    { value: '7d', label: t('monitoringControls.last7Days') },
  ]

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-col gap-4 md:flex-row">
        <div className="w-full space-y-2 md:w-auto">
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger className="w-full md:w-[200px]">
              <SelectValue
                placeholder={t('monitoringControls.selectTimeRange')}
              />
            </SelectTrigger>
            <SelectContent>
              {timeRangeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Resource Usage Charts */}
      <MonitoringStatusNotice error={errorResourceUsage} />
      <ResourceUtilizationChart
        cpu={resourceUsage?.cpu || []}
        memory={resourceUsage?.memory || []}
        isLoading={isLoadingResourceUsage}
        error={
          getMonitoringErrorKind(errorResourceUsage) === 'unknown'
            ? errorResourceUsage
            : undefined
        }
      />

      {/* Network Usage Chart */}
      <NetworkUsageChart
        networkIn={resourceUsage?.networkIn || []}
        networkOut={resourceUsage?.networkOut || []}
        isLoading={isLoadingResourceUsage}
        error={
          getMonitoringErrorKind(errorResourceUsage) === 'unknown'
            ? errorResourceUsage
            : undefined
        }
      />
    </div>
  )
}
