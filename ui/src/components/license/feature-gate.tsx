import { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { type LicenseFeatureKey } from '@/lib/api/license'
import { useFeature } from '@/hooks/use-license'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

interface FeatureGateProps {
  feature: LicenseFeatureKey
  children: ReactNode
  fallback?: ReactNode
}

export function FeatureGate({ feature, children, fallback }: FeatureGateProps) {
  const { t } = useTranslation()
  const enabled = useFeature(feature)

  if (enabled) {
    return <>{children}</>
  }

  if (fallback) {
    return <>{fallback}</>
  }

  return (
    <Alert>
      <AlertTitle>
        {t('licenseManagement.features.proFeature', 'Pro feature')}
      </AlertTitle>
      <AlertDescription>
        {t(
          'licenseManagement.features.proFeatureDescription',
          'This capability is reserved for Kite Desktop Pro.'
        )}
      </AlertDescription>
    </Alert>
  )
}
