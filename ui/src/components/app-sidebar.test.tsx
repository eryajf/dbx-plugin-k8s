import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { AppSidebar } from './app-sidebar'
import { SidebarProvider } from './ui/sidebar'

const useSidebarConfigMock = vi.fn()
const useDesktopUpdateMock = vi.fn()
const useClusterMock = vi.fn(() => ({clusters:[{name:'K84'}], currentCluster:'id'}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, fallback?: string | { defaultValue?: string }) =>
        typeof fallback === 'string'
          ? fallback
          : (fallback?.defaultValue ?? key),
    }),
  }
})

vi.mock('@/contexts/sidebar-config-context', () => ({
  useSidebarConfig: () => useSidebarConfigMock(),
}))

vi.mock('@/hooks/use-desktop-update', () => ({ useDesktopUpdate: () => useDesktopUpdateMock() }))
vi.mock('@/hooks/use-cluster', () => ({ useCluster: () => useClusterMock() }))

vi.mock('./cluster-selector', () => ({
  ClusterSelector: () => <div>cluster-selector</div>,
}))

vi.mock('./navigation-controls', () => ({
  NavigationControls: () => <div>navigation-controls</div>,
}))

function LocationDisplay() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname + location.search}</div>
}

function renderSidebar() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SidebarProvider>
        <AppSidebar variant="inset" />
        <LocationDisplay />
      </SidebarProvider>
    </MemoryRouter>
  )
}

function renderCollapsedSidebar() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SidebarProvider defaultOpen={false}>
        <AppSidebar variant="inset" />
      </SidebarProvider>
    </MemoryRouter>
  )
}

describe('AppSidebar', () => {
  it('does not show an update badge', () => {
    useSidebarConfigMock.mockReturnValue({ isLoading:false, config:{groups:[],pinnedItems:[],hiddenItems:[]}, getIconComponent:()=> 'div' })
    renderSidebar()
    expect(screen.queryByLabelText('New version available')).not.toBeInTheDocument()
  })

  it('does not show the badge when no actionable update exists', () => {
    useSidebarConfigMock.mockReturnValue({
      isLoading: false,
      config: {
        groups: [],
        pinnedItems: [],
        hiddenItems: [],
      },
      getIconComponent: () => 'div',
    })
    useDesktopUpdateMock.mockReturnValue({
      result: {
        comparison: 'up_to_date',
        ignored: false,
      },
    })

    renderSidebar()

    expect(
      screen.queryByRole('link', { name: 'New version available' })
    ).not.toBeInTheDocument()
  })

  it('keeps an icon sidebar when collapsed', () => {
    useSidebarConfigMock.mockReturnValue({
      isLoading: false,
      config: {
        groups: [
          {
            id: 'sidebar-groups-cluster',
            order: 0,
            visible: true,
            collapsed: false,
            nameKey: 'sidebar.groups.cluster',
            items: [
              {
                id: 'sidebar-groups-cluster--favorites',
                titleKey: 'nav.favorites',
                url: '/favorites',
                icon: 'IconStar',
                order: 0,
              },
            ],
          },
          {
            id: 'sidebar-groups-security',
            order: 1,
            visible: true,
            collapsed: true,
            nameKey: 'sidebar.groups.security',
            items: [
              {
                id: 'sidebar-groups-security--serviceaccounts',
                titleKey: 'nav.serviceaccounts',
                url: '/serviceaccounts',
                icon: 'IconUser',
                order: 0,
              },
            ],
          },
        ],
        pinnedItems: [],
        hiddenItems: [],
      },
      getIconComponent: () => 'div',
    })
    useDesktopUpdateMock.mockReturnValue({
      result: {
        comparison: 'up_to_date',
        ignored: false,
      },
    })

    const { container } = renderCollapsedSidebar()

    expect(container.querySelector('[data-collapsible="icon"]')).toBeTruthy()
    expect(screen.getByRole('link', { name: /kite logo/i })).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'nav.favorites' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'nav.serviceaccounts' })
    ).toBeInTheDocument()
  })
})
