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
import { monitoringTimeRangeOptions } from './monitoring-options'

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

  const timeRangeOptions = monitoringTimeRangeOptions(t)

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
        nodeName={name}
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
        scope="node"
        nodeName={name}
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
