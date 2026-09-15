import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { usePageTitle } from '@/hooks/use-page-title'
import { ResponsiveTabs } from '@/components/ui/responsive-tabs'

import { GatewayListPage } from './gateway-list-page'
import { HTTPRouteListPage } from './httproute-list-page'
import { SimpleListPage } from './simple-list-page'

export function AdvancedNetworkingPage() {
  const { t } = useTranslation()

  usePageTitle(t('nav.advancedNetworking'))

  const tabs: Array<{
    value: string
    label: string
    content: ReactNode
  }> = [
    {
      value: 'networkpolicies',
      label: t('nav.networkpolicies'),
      content: <SimpleListPage resourceType="networkpolicies" />,
    },
    {
      value: 'gateways',
      label: t('nav.gateways'),
      content: <GatewayListPage />,
    },
    {
      value: 'httproutes',
      label: t('nav.httproutes'),
      content: <HTTPRouteListPage />,
    },
  ]

  return (
    <div className="space-y-2">
      <div className="mb-4">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-3xl">{t('nav.advancedNetworking')}</h1>
        </div>
        <p className="text-muted-foreground">
          {t(
            'advancedNetworking.description',
            'Manage network policies, gateways, and HTTP routes in one place'
          )}
        </p>
      </div>

      <ResponsiveTabs tabs={tabs} />
    </div>
  )
}
