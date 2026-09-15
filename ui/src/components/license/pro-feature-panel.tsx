import { useTranslation } from 'react-i18next'

import { LicenseFeatureKey } from '@/lib/api/license'

interface ProFeaturePanelProps {
  feature: LicenseFeatureKey
}

export function ProFeaturePanel({ feature }: ProFeaturePanelProps) {
  const { t } = useTranslation()

  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-md border border-dashed p-6 text-center">
      <div className="text-sm font-medium">
        {t(
          'licenseManagement.features.requiresPro',
          'Requires Kite Desktop Pro'
        )}
      </div>
      <div className="mt-2 max-w-md text-xs text-muted-foreground break-words">
        {feature}
      </div>
    </div>
  )
}
