import type { ReactElement, ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FavoritesPage } from './favorites'

type FavoriteItem = {
  id: string
  name: string
  namespace?: string
  resourceType: string
  createdAt: string
}

let currentClusterMock = 'cluster-a'
let favoritesMock: FavoriteItem[] = []
const openSearchMock = vi.fn()
const removeFromFavoritesMock = vi.fn()
const navigateMock = vi.fn()

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>('react-router-dom')

  return {
    ...actual,
    useNavigate: () => navigateMock,
  }
})

vi.mock('@/hooks/use-cluster', () => ({
  useCluster: () => ({
    currentCluster: currentClusterMock,
  }),
}))

vi.mock('@/hooks/use-favorites', () => ({
  useFavorites: () => ({
    favorites: favoritesMock,
    isLoading: false,
    refreshFavorites: vi.fn(),
    removeFromFavorites: removeFromFavoritesMock,
  }),
}))

vi.mock('@/components/global-search-provider', () => ({
  useGlobalSearch: () => ({
    openSearch: openSearchMock,
  }),
}))

vi.mock('@/components/no-cluster-state', () => ({
  NoClusterState: () => <div>no cluster state</div>,
}))

function SelectMock({
  value,
  onValueChange,
  children,
}: {
  value: string
  onValueChange?: (value: string) => void
  children: ReactNode
}) {
  const options: Array<{ value: string; label: string }> = []

  const walk = (node: ReactNode): ReactNode => {
    if (!node) {
      return node
    }

    if (Array.isArray(node)) {
      node.forEach((child) => walk(child))
      return node
    }

    if (
      typeof node === 'object' &&
      'props' in node &&
      node.props &&
      typeof node.props === 'object'
    ) {
      const element = node as ReactElement<{
        value?: string
        children?: ReactNode
      }>

      if (typeof element.props.value === 'string') {
        const label =
          typeof element.props.children === 'string'
            ? element.props.children
            : String(element.props.value)
        options.push({ value: element.props.value, label })
      }

      walk(element.props.children)
    }

    return node
  }

  walk(children)

  return (
    <select
      value={value}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

vi.mock('@/components/ui/select', () => ({
  Select: SelectMock,
  SelectTrigger: ({ children }: { children: ReactNode }) => children,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()

  const translations: Record<string, string> = {
    'favorites.title': 'Favorites',
    'favorites.currentCluster': 'Current cluster: {{name}}',
    'favorites.searchPlaceholder': 'Search favorite resources...',
    'favorites.searchAriaLabel': 'Search favorite resources',
    'favorites.allTypes': 'All types',
    'favorites.allNamespaces': 'All namespaces',
    'favorites.typeFilterAriaLabel': 'Filter favorites by resource type',
    'favorites.namespaceFilterAriaLabel': 'Filter favorites by namespace',
    'favorites.count': 'Showing {{count}} of {{total}} favorites',
    'favorites.remove': 'Remove favorite',
    'favorites.emptyTitle': 'No favorites in the current cluster yet',
    'favorites.emptyDescription':
      'Use the resource search star button to save common resources here',
    'favorites.openSearch': 'Open resource search',
    'favorites.emptyFilteredTitle': 'No favorites match the current filters',
    'favorites.emptyFilteredDescription':
      'Try adjusting the keyword, resource type, or namespace filters',
    'favorites.clearFilters': 'Clear filters',
    'common.refresh': 'Refresh',
    'common.loading': 'Loading...',
    'nav.pods': 'Pods',
    'nav.services': 'Services',
    'nav.deployments': 'Deployments',
  }

  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, string | number>) => {
        const template = translations[key] || key
        if (!options) {
          return template
        }

        return Object.entries(options).reduce((result, [name, value]) => {
          return result.replace(`{{${name}}}`, String(value))
        }, template)
      },
    }),
  }
})

function renderPage() {
  return render(
    <MemoryRouter>
      <FavoritesPage />
    </MemoryRouter>
  )
}

describe('FavoritesPage', () => {
  beforeEach(() => {
    currentClusterMock = 'cluster-a'
    favoritesMock = [
      {
        id: 'pods::default::api',
        name: 'api',
        namespace: 'default',
        resourceType: 'pods',
        createdAt: '2026-04-18T10:00:00.000Z',
      },
      {
        id: 'services::infra::gateway',
        name: 'gateway',
        namespace: 'infra',
        resourceType: 'services',
        createdAt: '2026-04-18T09:00:00.000Z',
      },
      {
        id: 'deployments::prod::web',
        name: 'web',
        namespace: 'prod',
        resourceType: 'deployments',
        createdAt: '2026-04-18T08:00:00.000Z',
      },
    ]
    openSearchMock.mockReset()
    removeFromFavoritesMock.mockReset()
    removeFromFavoritesMock.mockResolvedValue(undefined)
    navigateMock.mockReset()
  })

  it('renders current cluster favorites and filters them by search query', async () => {
    const user = userEvent.setup()
    renderPage()

    expect(screen.getByText('Current cluster: cluster-a')).toBeInTheDocument()
    expect(screen.getByText('api')).toBeInTheDocument()
    expect(screen.getByText('gateway')).toBeInTheDocument()

    await user.type(
      screen.getByRole('textbox', { name: 'Search favorite resources' }),
      'gate'
    )

    expect(screen.queryByText('api')).not.toBeInTheDocument()
    expect(screen.getByText('gateway')).toBeInTheDocument()
  })

  it('filters favorites by resource type and namespace', async () => {
    const user = userEvent.setup()
    renderPage()

    const selects = screen.getAllByRole('combobox')
    await user.selectOptions(selects[0], 'services')

    expect(screen.queryByText('api')).not.toBeInTheDocument()
    expect(screen.getByText('gateway')).toBeInTheDocument()
    expect(screen.queryByText('web')).not.toBeInTheDocument()

    await user.selectOptions(selects[1], 'infra')
    expect(screen.getByText('gateway')).toBeInTheDocument()
  })

  it('removes a favorite from the current list immediately', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(
      screen.getAllByRole('button', { name: 'Remove favorite' })[0]
    )

    await waitFor(() =>
      expect(removeFromFavoritesMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'api' })
      )
    )
    expect(screen.queryByText('api')).not.toBeInTheDocument()
  })

  it('shows empty state actions when there are no favorites', async () => {
    const user = userEvent.setup()
    favoritesMock = []
    renderPage()

    expect(
      screen.getByText('No favorites in the current cluster yet')
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Open resource search' })
    )

    expect(openSearchMock).toHaveBeenCalledWith('all')
  })

  it('switches content when the current cluster changes', () => {
    const view = renderPage()

    expect(screen.getByText('Current cluster: cluster-a')).toBeInTheDocument()

    currentClusterMock = 'cluster-b'
    favoritesMock = [
      {
        id: 'pods::qa::worker',
        name: 'worker',
        namespace: 'qa',
        resourceType: 'pods',
        createdAt: '2026-04-18T11:00:00.000Z',
      },
    ]

    view.rerender(
      <MemoryRouter>
        <FavoritesPage />
      </MemoryRouter>
    )

    expect(screen.getByText('Current cluster: cluster-b')).toBeInTheDocument()
    expect(screen.getByText('worker')).toBeInTheDocument()
    expect(screen.queryByText('gateway')).not.toBeInTheDocument()
  })

  it('falls back to the no-cluster state when no cluster is selected', () => {
    currentClusterMock = ''
    renderPage()

    expect(screen.getByText('no cluster state')).toBeInTheDocument()
  })
})
