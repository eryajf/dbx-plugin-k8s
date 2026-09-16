import { useTranslation } from 'react-i18next'
import { useMemo } from 'react'
import { ConfigMap } from 'kubernetes-types/core/v1'

import { useResources } from '@/lib/api'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function ConfigMapSelector({
  selectedConfigMap,
  onConfigMapChange,
  namespace,
  placeholder,
  className,
}: {
  selectedConfigMap?: string
  onConfigMapChange: (configMap: string) => void
  namespace?: string
  placeholder?: string
  className?: string
}) {
  const { t } = useTranslation()

  const { data, isLoading } = useResources('configmaps', namespace)

  const sortedConfigMaps = useMemo(() => {
    return data?.slice().sort((a, b) => {
      const nameA = a.metadata?.name?.toLowerCase() || ''
      const nameB = b.metadata?.name?.toLowerCase() || ''
      return nameA.localeCompare(nameB)
    })
  }, [data])

  return (
    <Select value={selectedConfigMap} onValueChange={onConfigMapChange}>
      <SelectTrigger className={className}>
        <SelectValue placeholder={placeholder ?? t('environmentEditor.selectConfigMap')} />
      </SelectTrigger>
      <SelectContent>
        {isLoading && (
          <SelectItem disabled value="_loading">
            {t('common.loading')}
          </SelectItem>
        )}
        {sortedConfigMaps?.map((configMap: ConfigMap) => (
          <SelectItem
            key={configMap.metadata!.name}
            value={configMap.metadata!.name!}
          >
            {configMap.metadata!.name}
          </SelectItem>
        ))}
        {!isLoading && (!sortedConfigMaps || sortedConfigMaps.length === 0) && (
          <SelectItem disabled value="_empty">
            {t('selector.noResults')}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  )
}
