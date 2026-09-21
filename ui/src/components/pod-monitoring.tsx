import { useMemo, useState } from 'react'
import { Container, Pod } from 'kubernetes-types/core/v1'
import { useTranslation } from 'react-i18next'

import { usePodMetrics } from '@/lib/api'
import { toSimpleContainer } from '@/lib/k8s'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ContainerSelector } from '@/components/selector/container-selector'

import CPUUsageChart from './chart/cpu-usage-chart'
import DiskIOUsageChart from './chart/disk-io-usage-chart'
import MemoryUsageChart from './chart/memory-usage-chart'
import NetworkUsageChart from './chart/network-usage-chart'
import { PodSelector } from './selector/pod-selector'
import {
  getMonitoringErrorKind,
  MonitoringStatusNotice,
} from './monitoring-status-notice'
import {
  DEFAULT_MONITORING_REFRESH_INTERVAL,
  monitoringTimeRangeOptions,
} from './monitoring-options'

interface PodMonitoringProps {
  namespace: string
  podName?: string
  defaultQueryName?: string
  pods?: Pod[]
  containers?: Container[]
  initContainers?: Container[]
  labelSelector?: string
}

export function PodMonitoring({
  namespace,
  podName,
  defaultQueryName,
  pods,
  containers: _containers = [],
  initContainers = [],
  labelSelector,
}: PodMonitoringProps) {
  const { t } = useTranslation()
  const containers = useMemo(() => {
    return toSimpleContainer(initContainers, _containers)
  }, [_containers, initContainers])
  const [selectedPods, setSelectedPods] = useState<string[]>(
    podName ? [podName] : []
  )
  const [timeRange, setTimeRange] = useState('30m')
  const [selectedContainer, setSelectedContainer] = useState<
    string | undefined
  >(undefined)
  const [refreshInterval, setRefreshInterval] = useState(
    DEFAULT_MONITORING_REFRESH_INTERVAL
  )

  const queryPodName = useMemo(() => {
    return (
      podName ||
      defaultQueryName ||
      pods?.[0]?.metadata?.generateName?.split('-').slice(0, -2).join('-') ||
      ''
    )
  }, [podName, defaultQueryName, pods])

  const effectivePodNames = useMemo(() => {
    if (selectedPods.length > 0) {
      return selectedPods
    }

    const workloadPodNames = (pods || [])
      .map((pod) => pod.metadata?.name)
      .filter((name): name is string => Boolean(name))
    if (workloadPodNames.length > 0) {
      return workloadPodNames
    }

    return podName ? [podName] : []
  }, [podName, pods, selectedPods])

  const { data, isLoading, error } = usePodMetrics(
    namespace,
    queryPodName,
    timeRange,
    {
      container: selectedContainer,
      podNames: effectivePodNames,
      refreshInterval: refreshInterval,
      labelSelector: labelSelector,
    }
  )

  const timeRangeOptions = monitoringTimeRangeOptions(t)
  const queryContext = {
    namespace,
    podName: queryPodName,
    podNames: effectivePodNames,
    container: selectedContainer,
  }

  const refreshIntervalOptions = [
    { value: 0, label: t('monitoringControls.off') },
    { value: 5 * 1000, label: t('monitoringControls.seconds', { count: 5 }) },
    { value: 10 * 1000, label: t('monitoringControls.seconds', { count: 10 }) },
    { value: 30 * 1000, label: t('monitoringControls.seconds', { count: 30 }) },
    { value: 60 * 1000, label: t('monitoringControls.seconds', { count: 60 }) },
  ]

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-col gap-4 md:flex-row md:flex-wrap">
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

        <div className="w-full space-y-2 md:w-auto">
          <Select
            value={refreshInterval.toString()}
            onValueChange={(value) => setRefreshInterval(Number(value))}
          >
            <SelectTrigger className="w-full md:w-[200px]">
              <SelectValue
                placeholder={t('monitoringControls.selectRefreshInterval')}
              />
            </SelectTrigger>
            <SelectContent>
              {refreshIntervalOptions.map((option) => (
                <SelectItem key={option.value} value={option.value.toString()}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="w-full space-y-2 md:w-auto md:min-w-[14rem] md:shrink-0">
          <ContainerSelector
            containers={containers}
            selectedContainer={selectedContainer}
            onContainerChange={setSelectedContainer}
          />
        </div>
        {pods && pods.length > 1 && (
          <div className="w-full space-y-2 md:w-auto md:min-w-[18rem] md:shrink-0">
            {/* Pod Selector */}
            <PodSelector
              pods={pods}
              showAllOption={true}
              selectedPods={selectedPods}
              onPodsChange={setSelectedPods}
            />
          </div>
        )}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="xl:col-span-2">
          <MonitoringStatusNotice error={error} />
        </div>
        {data?.fallback && (
          <div className="xl:col-span-2 rounded bg-yellow-100 text-yellow-800 px-4 py-2 text-sm border border-yellow-300">
            {t('monitoring.limitedHistory')}
          </div>
        )}
        <CPUUsageChart
          data={data?.cpu || []}
          isLoading={isLoading}
          syncId="resource-amount"
          queryContext={queryContext}
          error={getMonitoringErrorKind(error) === 'unknown' ? error : undefined}
        />
        <MemoryUsageChart
          data={data?.memory || []}
          isLoading={isLoading}
          syncId="resource-amount"
          queryContext={queryContext}
        />
        <CPUUsageChart
          data={data?.cpuUtilization || []}
          variant="percentage"
          isLoading={isLoading}
          syncId="resource-utilization"
          queryContext={queryContext}
        />
        <MemoryUsageChart
          data={data?.memoryUtilization || []}
          variant="percentage"
          isLoading={isLoading}
          syncId="resource-utilization"
          queryContext={queryContext}
        />
        <NetworkUsageChart
          networkIn={data?.networkIn || []}
          networkOut={data?.networkOut || []}
          isLoading={isLoading}
          syncId="resource-usage"
          queryContext={queryContext}
        />
        <DiskIOUsageChart
          diskRead={data?.diskRead || []}
          diskWrite={data?.diskWrite || []}
          isLoading={isLoading}
          syncId="resource-usage"
          queryContext={queryContext}
        />
      </div>
    </div>
  )
}
