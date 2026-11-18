import { Info, RotateCcw, ShieldX, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { isRBACError, translateError } from '@/lib/utils'
import { normalizeRequestError } from '@/lib/request-errors'
import {
  isResourceNotDiscoveredError,
  type ResourceNotDiscoveredError,
} from '@/lib/dbx-resource-discovery'

import { Button } from './ui/button'

interface ErrorMessageProps {
  resourceName: string
  error: Error | unknown
  fallbackKey?: string
  className?: string
  refetch: () => void
  isFetching?: boolean
}

export function ErrorMessage({
  resourceName,
  refetch,
  error,
  fallbackKey = 'common.error',
  className,
  isFetching = false,
}: ErrorMessageProps) {
  const { t } = useTranslation()

  if (!error) {
    return null
  }

  const normalized = normalizeRequestError(error)
  // An uninstalled CRD (e.g. Gateway API) is a cluster capability gap, not a
  // failure: show a neutral notice instead of a red error state.
  const notDiscovered = isResourceNotDiscoveredError(error)
  const isRBAC = !notDiscovered && (normalized.status === 401 || normalized.status === 403 ||
    isRBACError(normalized.message))
  const message = notDiscovered
    ? t('resourceTable.resourceUnavailableHint', {
        resource: (error as ResourceNotDiscoveredError).resource,
      })
    : normalized.message ? translateError(normalized, t) : t(fallbackKey)
  const title = notDiscovered
    ? t('resourceTable.resourceUnavailable')
    : isRBAC
      ? t('resourceTable.noPermission')
      : t('resourceTable.errorLoading', {
          resourceName: resourceName.toLowerCase(),
        })

  return (
    <div role={notDiscovered ? 'status' : 'alert'} className={className ?? 'h-72 flex flex-col items-center justify-center'}>
      <div className="mb-4">
        {notDiscovered ? (
          <Info className="h-16 w-16 text-sky-500" />
        ) : isRBAC ? (
          <ShieldX className="h-16 w-16 text-amber-500" />
        ) : (
          <XCircle className="h-16 w-16 text-red-500" />
        )}
      </div>
      <h3
        className={`text-lg font-medium mb-1 ${notDiscovered ? 'text-foreground' : isRBAC ? 'text-amber-600' : 'text-red-500'}`}
      >
        {title}
      </h3>
      <p className="text-muted-foreground mb-4">{message}</p>
      <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
        <RotateCcw className="h-4 w-4 mr-2" />
        {t('resourceTable.tryAgain')}
      </Button>
    </div>
  )
}
