import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { SettingsPage } from './settings'

vi.mock('@/hooks/use-page-title', () => ({
  usePageTitle: vi.fn(),
}))

vi.mock('react-i18next', () => ({ initReactI18next: { type: '3rdParty', init: () => undefined }, useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key, i18n: { language: 'en', changeLanguage: vi.fn() } }) }))

vi.mock('@/components/settings/desktop-management', () => ({
  DesktopManagement: () => <div>Desktop</div>,
}))

vi.mock('@/components/settings/license-management', () => ({
  LicenseManagement: () => <div>License</div>,
}))

vi.mock('@/components/settings/about-management', () => ({
  AboutManagement: () => <div>About</div>,
}))

vi.mock('@/components/settings/general-management', () => ({
  GeneralManagement: () => <div>General</div>,
}))

vi.mock('@/components/settings/cluster-management', () => ({
  ClusterManagement: () => <div>Cluster</div>,
}))

vi.mock('@/components/settings/template-management', () => ({
  TemplateManagement: () => <div>Templates</div>,
}))

vi.mock('@/components/ui/responsive-tabs', () => ({
  ResponsiveTabs: ({
    tabs,
  }: {
    tabs: Array<{ label: string; content: React.ReactNode }>
  }) => (
    <div>
      {tabs.map((tab) => (
        <section key={tab.label}>
          <h2>{tab.label}</h2>
          {tab.content}
        </section>
      ))}
    </div>
  ),
}))

describe('SettingsPage', () => {
  it('shows appearance and navigation settings only', () => {
    render(<SettingsPage />)
    expect(screen.getByText('Appearance')).toBeInTheDocument()
    expect(screen.getByText('Navigation')).toBeInTheDocument()
    expect(screen.queryByText('License')).not.toBeInTheDocument()
    expect(screen.queryByText('Desktop')).not.toBeInTheDocument()
  })
})
