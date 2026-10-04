import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GlobalSearch } from './global-search'

const {
  openSearchMock,
  globalSearchMock,
  toastErrorMock,
  toggleFavoriteMock,
  favoritesState,
} = vi.hoisted(() => ({
  openSearchMock: vi.fn(),
  globalSearchMock: vi.fn().mockResolvedValue({ results: [] }),
  toastErrorMock: vi.fn(),
  toggleFavoriteMock: vi.fn(),
  favoritesState: {
    isLoading: false,
    isError: false,
    isMutating: false,
  },
}))
const { trackDesktopEvent, setCurrentClusterMock } = vi.hoisted(() => ({
  trackDesktopEvent: vi.fn(),
  setCurrentClusterMock: vi.fn(),
}))
const clustersMock = [
  {
    id: 1,
    name: 'prod',
    enabled: true,
    inCluster: false,
    isDefault: false,
    createdAt: '',
    updatedAt: '',
    version: 'v1.31.0',
  },
  {
    id: 2,
    name: 'dev',
    enabled: true,
    inCluster: false,
    isDefault: true,
    createdAt: '',
    updatedAt: '',
    version: 'v1.30.0',
  },
]
const favoritesMock: [] = []

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)
Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
  value: vi.fn(),
  writable: true,
})

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}))

vi.mock('@/components/ui/command', () => ({
  Command: ({
    children,
    value,
  }: {
    children: React.ReactNode
    value?: string
  }) => (
    <div data-testid="global-search-command" data-command-value={value}>
      {children}
    </div>
  ),
  CommandEmpty: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandGroup: ({
    children,
    heading,
  }: {
    children: React.ReactNode
    heading?: React.ReactNode
  }) => (
    <section>
      {heading ? <h2>{heading}</h2> : null}
      {children}
    </section>
  ),
  CommandInput: ({
    placeholder,
    value,
    onValueChange,
  }: {
    placeholder?: string
    value?: string
    onValueChange?: (value: string) => void
  }) => (
    <input
      placeholder={placeholder}
      value={value}
      onChange={(event) => onValueChange?.(event.target.value)}
    />
  ),
  CommandItem: ({
    children,
    onSelect,
    disabled,
    value,
  }: {
    children: React.ReactNode
    onSelect?: () => void
    disabled?: boolean
    value?: string
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      data-command-item-value={value}
    >
      {children}
    </button>
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  CommandShortcut: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}))

vi.mock('@/lib/api', () => ({
  globalSearch: globalSearchMock,
}))

vi.mock('@/hooks/use-cluster', () => ({
  useCluster: () => ({
    clusters: clustersMock,
    currentCluster: 'prod',
    setCurrentCluster: setCurrentClusterMock,
    isSwitching: false,
    isLoading: false,
  }),
}))

vi.mock('@/hooks/use-favorites', () => ({
  useFavorites: () => ({
    favorites: favoritesMock,
    isFavorite: () => false,
    ...favoritesState,
    toggleFavorite: toggleFavoriteMock,
  }),
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
  },
}))

vi.mock('@/contexts/runtime-context', () => ({
  useRuntime: () => ({
    isDesktop: true,
  }),
}))

vi.mock('@/lib/analytics', () => ({
  trackDesktopEvent,
}))

vi.mock('@/contexts/sidebar-config-context', () => ({
  useSidebarConfig: () => ({
    config: null,
    getIconComponent: vi.fn(),
  }),
}))

vi.mock('@/components/appearance-provider', () => ({
  useAppearance: () => ({
    actualTheme: 'light',
    setTheme: vi.fn(),
  }),
}))

vi.mock('./global-search-provider', () => ({
  useGlobalSearch: () => ({
    openSearch: openSearchMock,
  }),
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()

  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: string, options?: { name?: string }) => {
        if (options?.name) {
          return `Switch to cluster ${options.name}`
        }
        return fallback ?? _key
      },
    }),
  }
})

describe('GlobalSearch', () => {
  beforeEach(() => {
    openSearchMock.mockClear()
    globalSearchMock.mockReset()
    globalSearchMock.mockResolvedValue({ results: [] })
    trackDesktopEvent.mockClear()
    setCurrentClusterMock.mockClear()
    toastErrorMock.mockReset()
    toggleFavoriteMock.mockReset()
    toggleFavoriteMock.mockResolvedValue(true)
    favoritesState.isLoading = false
    favoritesState.isError = false
    favoritesState.isMutating = false
  })

  it('shows quick actions in all mode and can jump into cluster mode', () => {
    render(
      <MemoryRouter>
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    fireEvent.click(screen.getByText('globalSearch.switchClusterMode'))

    expect(openSearchMock).toHaveBeenCalledWith('cluster')
    expect(trackDesktopEvent).toHaveBeenCalledWith('global_search_select', {
      mode: 'all',
      item_type: 'action',
      action_id: 'switch-cluster-mode',
    })
  })

  it('shows cluster results locally in cluster mode without calling resource search', async () => {
    render(
      <MemoryRouter>
        <GlobalSearch open mode="cluster" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    expect(
      screen.getByPlaceholderText('globalSearch.clusterPlaceholder')
    ).toBeInTheDocument()
    expect(screen.getByText('prod')).toBeInTheDocument()
    expect(screen.getByText('dev')).toBeInTheDocument()

    await waitFor(() => {
      expect(globalSearchMock).not.toHaveBeenCalled()
    })
  })

  it('filters cluster mode by cluster name only', () => {
    render(
      <MemoryRouter>
        <GlobalSearch open mode="cluster" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    fireEvent.change(
      screen.getByPlaceholderText('globalSearch.clusterPlaceholder'),
      { target: { value: 'v1.31' } }
    )

    expect(screen.queryByText('prod')).not.toBeInTheDocument()
    expect(screen.queryByText('dev')).not.toBeInTheDocument()

    fireEvent.change(
      screen.getByPlaceholderText('globalSearch.clusterPlaceholder'),
      { target: { value: 'pro' } }
    )

    expect(screen.getByText('prod')).toBeInTheDocument()
    expect(screen.queryByText('dev')).not.toBeInTheDocument()
    expect(screen.queryByText('导航')).not.toBeInTheDocument()
    expect(
      screen.queryByText('globalSearch.navigation')
    ).not.toBeInTheDocument()
  })

  it('tracks resource query and selection without sending raw query text', async () => {
    globalSearchMock.mockResolvedValueOnce({
      results: [
        {
          id: 'pod-1',
          name: 'nginx',
          namespace: 'default',
          resourceType: 'pods',
          createdAt: '',
        },
      ],
    })

    render(
      <MemoryRouter>
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    fireEvent.change(screen.getByPlaceholderText('globalSearch.placeholder'), {
      target: { value: 'ng' },
    })

    await waitFor(() => {
      expect(globalSearchMock).toHaveBeenCalledWith('ng', {
        limit: 10,
        namespace: undefined,
        signal: expect.any(AbortSignal),
      })
    })

    await waitFor(() => {
      expect(trackDesktopEvent).toHaveBeenCalledWith('global_search_query', {
        mode: 'all',
        query_length: 2,
        result_count: 1,
      })
    })

    fireEvent.click(screen.getByText('nginx'))

    expect(trackDesktopEvent).toHaveBeenCalledWith('global_search_select', {
      mode: 'all',
      item_type: 'resource',
      resource_type: 'pods',
    })

    expect(
      JSON.parse(localStorage.getItem('global-search-history-v1-prod') || '[]')
    ).toEqual([
      expect.objectContaining({
        id: 'resource:/pods/default/nginx',
        label: 'nginx',
        path: '/pods/default/nginx',
        query: 'ng',
        resourceType: 'pods',
        namespace: 'default',
      }),
    ])
  })

  it('selects the first resource result by default', async () => {
    globalSearchMock.mockResolvedValueOnce({
      results: [
        {
          id: 'pod-1',
          name: 'first-pod',
          namespace: 'default',
          resourceType: 'pods',
          createdAt: '',
        },
        {
          id: 'pod-2',
          name: 'second-pod',
          namespace: 'default',
          resourceType: 'pods',
          createdAt: '',
        },
      ],
    })

    render(
      <MemoryRouter>
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    fireEvent.change(screen.getByPlaceholderText('globalSearch.placeholder'), {
      target: { value: 'pod' },
    })

    await screen.findByText('first-pod')

    await waitFor(() => {
      const command = screen.getByTestId('global-search-command')
      const selectedValue = command.getAttribute('data-command-value')
      expect(selectedValue).toBe('first-pod default pods nav.pods')

      const firstItem = screen
        .getAllByRole('button')
        .find((button) =>
          button
            .getAttribute('data-command-item-value')
            ?.startsWith('first-pod ')
        )
      expect(firstItem?.getAttribute('data-command-item-value')).toBe(
        selectedValue
      )
    })
  })

  it('routes custom resource results through the CRD detail route', async () => {
    globalSearchMock.mockResolvedValueOnce({
      results: [
        {
          id: 'widget-1',
          name: 'widget-one',
          namespace: 'default',
          resourceType: 'widgets.example.com',
          customResource: true,
          createdAt: '',
        },
      ],
    })

    render(
      <MemoryRouter>
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    fireEvent.change(screen.getByPlaceholderText('globalSearch.placeholder'), {
      target: { value: 'widget' },
    })
    fireEvent.click(await waitFor(() => screen.getByText('widget-one')))

    expect(
      JSON.parse(localStorage.getItem('global-search-history-v1-prod') || '[]')
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/crds/widgets.example.com/default/widget-one',
        }),
      ])
    )
  })

  it('searches all namespaces and ignores stale search responses', async () => {
    let resolveFirst: ((value: { results: unknown[] }) => void) | undefined
    const firstResponse = new Promise<{ results: unknown[] }>((resolve) => {
      resolveFirst = resolve
    })
    globalSearchMock
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce({
        results: [
          {
            id: 'new-pod',
            name: 'nginx-new',
            namespace: 'default',
            resourceType: 'pods',
            createdAt: '',
          },
        ],
      })

    render(
      <MemoryRouter initialEntries={['/pods?namespace=default']}>
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    const input = screen.getByPlaceholderText('globalSearch.placeholder')
    fireEvent.change(input, { target: { value: 'ng' } })
    await waitFor(() => expect(globalSearchMock).toHaveBeenCalledTimes(1))
    expect(globalSearchMock).toHaveBeenCalledWith('ng', {
      limit: 10,
      signal: expect.any(AbortSignal),
    })

    fireEvent.change(input, { target: { value: 'nginx' } })
    await waitFor(() => expect(globalSearchMock).toHaveBeenCalledTimes(2))
    resolveFirst?.({
      results: [{ id: 'old', name: 'old', resourceType: 'pods' }],
    })

    await waitFor(() =>
      expect(screen.getByText('nginx-new')).toBeInTheDocument()
    )
    expect(screen.queryByText('old')).not.toBeInTheDocument()
  })

  it('does not inherit namespace from custom resource detail routes', async () => {
    globalSearchMock.mockResolvedValueOnce({
      results: [
        {
          id: 'widget-1',
          name: 'widget-two',
          namespace: 'default',
          resourceType: 'widgets.example.com',
          customResource: true,
          createdAt: '',
        },
      ],
    })

    render(
      <MemoryRouter
        initialEntries={['/crds/widgets.example.com/default/widget-one']}
      >
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    fireEvent.change(screen.getByPlaceholderText('globalSearch.placeholder'), {
      target: { value: 'widget' },
    })

    await waitFor(() => {
      expect(globalSearchMock).toHaveBeenCalledWith('widget', {
        limit: 10,
        signal: expect.any(AbortSignal),
      })
    })
  })

  it('clears stale results for short or blank queries and normalizes the next search', async () => {
    globalSearchMock
      .mockResolvedValueOnce({
        results: [
          {
            id: 'old-pod',
            name: 'old-pod',
            namespace: 'default',
            resourceType: 'pods',
            createdAt: '',
          },
        ],
      })
      .mockResolvedValueOnce({
        results: [
          {
            id: 'api-pod-2',
            name: 'api-pod',
            namespace: 'default',
            resourceType: 'pods',
            createdAt: '',
          },
        ],
      })
      .mockResolvedValueOnce({
        results: [
          {
            id: 'api-pod',
            name: 'api-pod',
            namespace: 'default',
            resourceType: 'pods',
            createdAt: '',
          },
        ],
      })

    render(
      <MemoryRouter>
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    const input = screen.getByPlaceholderText('globalSearch.placeholder')
    fireEvent.change(input, { target: { value: 'old' } })
    await waitFor(() => expect(screen.getByText('old-pod')).toBeInTheDocument())

    fireEvent.change(input, { target: { value: 'o' } })
    await waitFor(() => expect(screen.getByText('api-pod')).toBeInTheDocument())
    expect(screen.queryByText('old-pod')).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: '  ' } })
    expect(screen.queryByText('old-pod')).not.toBeInTheDocument()
    expect(globalSearchMock).toHaveBeenCalledTimes(2)

    fireEvent.change(input, { target: { value: '  api  ' } })
    await waitFor(() => {
      expect(globalSearchMock).toHaveBeenCalledWith('api', {
        limit: 10,
        signal: expect.any(AbortSignal),
      })
    })
    await waitFor(() => expect(screen.getByText('api-pod')).toBeInTheDocument())
  })

  it.each([
    { complete: false, syncing: false, warnings: [] },
    { complete: true, syncing: true, warnings: [] },
    { warnings: ['pods: timed out'] },
  ])('shows a status for a genuinely partial response: %o', async (state) => {
    globalSearchMock.mockResolvedValueOnce({
      results: [],
      truncated: false,
      ...state,
    })

    render(
      <MemoryRouter>
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    fireEvent.change(screen.getByPlaceholderText('globalSearch.placeholder'), {
      target: { value: 'api' },
    })

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument()
    })
  })

  it('explains an empty result while the resource index is syncing', async () => {
    globalSearchMock.mockResolvedValueOnce({
      results: [],
      complete: false,
      syncing: true,
      status: 'syncing',
      warnings: [],
    })

    render(
      <MemoryRouter>
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    fireEvent.change(screen.getByPlaceholderText('globalSearch.placeholder'), {
      target: { value: 'manager' },
    })

    await waitFor(() => {
      expect(screen.getByTestId('global-search-status')).toHaveTextContent(
        'globalSearch.indexSyncingNoResults'
      )
    })
    expect(screen.queryByText('globalSearch.noResults')).not.toBeInTheDocument()
  })

  it('does not mark complete paginated responses incomplete, including cache hits', async () => {
    globalSearchMock.mockResolvedValueOnce({
      results: [
        { id: 'pod', name: 'web-page', resourceType: 'pods', createdAt: '' },
      ],
      total: 30,
      complete: true,
      syncing: false,
      truncated: true,
      nextCursor: 'page-2',
      generation: 42,
      warnings: [],
    })
    render(
      <MemoryRouter>
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )
    const input = screen.getByPlaceholderText('globalSearch.placeholder')
    fireEvent.change(input, { target: { value: 'web' } })
    await screen.findByText('web-page')
    expect(
      screen.queryByText('globalSearch.incompleteResults')
    ).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.change(input, { target: { value: 'web' } })
    await screen.findByText('web-page')
    expect(globalSearchMock).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByText('globalSearch.incompleteResults')
    ).not.toBeInTheDocument()
  })

  it('preserves previous results on failure and during retry', async () => {
    let finishRetry!: (response: { results: unknown[] }) => void
    globalSearchMock
      .mockResolvedValueOnce({
        results: [
          {
            id: 'old',
            name: 'previous-pod',
            resourceType: 'pods',
            createdAt: '',
          },
        ],
      })
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRetry = resolve
          })
      )
    render(
      <MemoryRouter>
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )
    const input = screen.getByPlaceholderText('globalSearch.placeholder')
    fireEvent.change(input, { target: { value: 'previous' } })
    await screen.findByText('previous-pod')
    fireEvent.change(input, { target: { value: 'next' } })
    expect(screen.getByText('previous-pod')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('offline')
    expect(screen.getByText('previous-pod')).toBeInTheDocument()

    fireEvent.click(screen.getByText('common.retry'))
    expect(screen.getByText('previous-pod')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('global-search-status')).toHaveTextContent(
      'globalSearch.searching'
    )
    await act(async () =>
      finishRetry({
        results: [
          { id: 'new', name: 'next-pod', resourceType: 'pods', createdAt: '' },
        ],
      })
    )
    expect(screen.getByText('next-pod')).toBeInTheDocument()
    expect(screen.queryByText('previous-pod')).not.toBeInTheDocument()
  })

  it('cancels requests on query change, clear, and dialog close', async () => {
    globalSearchMock.mockImplementation(() => new Promise(() => {}))
    const { rerender } = render(
      <MemoryRouter>
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )
    const input = screen.getByPlaceholderText('globalSearch.placeholder')
    fireEvent.change(input, { target: { value: 'first' } })
    await waitFor(() => expect(globalSearchMock).toHaveBeenCalledTimes(1))
    const firstSignal = globalSearchMock.mock.calls[0][1].signal as AbortSignal
    fireEvent.change(input, { target: { value: 'next' } })
    expect(firstSignal.aborted).toBe(true)
    await waitFor(() => expect(globalSearchMock).toHaveBeenCalledTimes(2))
    const nextSignal = globalSearchMock.mock.calls[1][1].signal as AbortSignal
    fireEvent.change(input, { target: { value: '' } })
    expect(nextSignal.aborted).toBe(true)
    fireEvent.change(input, { target: { value: 'third' } })
    await waitFor(() => expect(globalSearchMock).toHaveBeenCalledTimes(3))
    const thirdSignal = globalSearchMock.mock.calls[2][1].signal as AbortSignal
    rerender(
      <MemoryRouter>
        <GlobalSearch open={false} mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )
    expect(thirdSignal.aborted).toBe(true)
  })

  it('clears results from the previous namespace scope', async () => {
    globalSearchMock
      .mockResolvedValueOnce({
        results: [
          {
            id: 'pod',
            name: 'first-scope-pod',
            namespace: 'first',
            resourceType: 'pods',
            createdAt: '',
          },
        ],
      })
      .mockImplementationOnce(() => new Promise(() => {}))
    render(
      <MemoryRouter>
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )
    fireEvent.change(screen.getByPlaceholderText('globalSearch.placeholder'), {
      target: { value: 'pod' },
    })
    await screen.findByText('first-scope-pod')
    fireEvent.change(screen.getByLabelText('detail.fields.namespace'), {
      target: { value: 'second' },
    })
    expect(screen.queryByText('first-scope-pod')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(globalSearchMock).toHaveBeenLastCalledWith('pod', {
        limit: 10,
        namespace: 'second',
        signal: expect.any(AbortSignal),
      })
    )
  })

  it('keeps backend errors separate from an empty result state', async () => {
    globalSearchMock
      .mockRejectedValueOnce(new Error('search unavailable'))
      .mockResolvedValueOnce({
        results: [
          {
            id: 'retry-pod',
            name: 'retry-pod',
            namespace: 'default',
            resourceType: 'pods',
            createdAt: '',
          },
        ],
      })

    render(
      <MemoryRouter>
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    fireEvent.change(screen.getByPlaceholderText('globalSearch.placeholder'), {
      target: { value: 'x' },
    })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('search unavailable')
    })
    expect(screen.queryByText('globalSearch.noResults')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('common.retry'))
    await waitFor(() =>
      expect(screen.getByText('retry-pod')).toBeInTheDocument()
    )
  })

  it.each([
    ['while favorites are loading', { isLoading: true }],
    ['when loading favorites failed', { isError: true }],
    ['while a favorite mutation is pending', { isMutating: true }],
  ])('disables result favorite toggles %s', async (_label, state) => {
    Object.assign(favoritesState, state)
    globalSearchMock.mockResolvedValueOnce({
      results: [
        {
          id: 'pod-1',
          name: 'nginx',
          namespace: 'default',
          resourceType: 'pods',
          createdAt: '',
        },
      ],
    })

    render(
      <MemoryRouter>
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    fireEvent.change(screen.getByPlaceholderText('globalSearch.placeholder'), {
      target: { value: 'ng' },
    })

    const favoriteButton = await waitFor(() =>
      screen.getByRole('button', { name: 'Add to favorites' })
    )
    expect(favoriteButton).toBeDisabled()
    expect(favoriteButton).toHaveAttribute(
      'aria-busy',
      state.isLoading || state.isMutating ? 'true' : 'false'
    )
    fireEvent.click(favoriteButton)
    expect(toggleFavoriteMock).not.toHaveBeenCalled()
  })

  it('shows an error when a result favorite toggle fails', async () => {
    globalSearchMock.mockResolvedValueOnce({
      results: [
        {
          id: 'pod-1',
          name: 'nginx',
          namespace: 'default',
          resourceType: 'pods',
          createdAt: '',
        },
      ],
    })
    toggleFavoriteMock.mockRejectedValueOnce(new Error('favorite failed'))

    render(
      <MemoryRouter>
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    fireEvent.change(screen.getByPlaceholderText('globalSearch.placeholder'), {
      target: { value: 'ng' },
    })

    const favoriteButton = await waitFor(() =>
      screen.getByRole('button', { name: 'Add to favorites' })
    )
    fireEvent.click(favoriteButton)

    await waitFor(() => {
      expect(toggleFavoriteMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'nginx' })
      )
      expect(toastErrorMock).toHaveBeenCalledWith('favorite failed')
    })
  })

  it('blocks duplicate result favorite toggles while the request is pending', async () => {
    let resolveToggle!: () => void
    toggleFavoriteMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveToggle = resolve
        })
    )
    globalSearchMock.mockResolvedValueOnce({
      results: [
        {
          id: 'pod-1',
          name: 'nginx',
          namespace: 'default',
          resourceType: 'pods',
          createdAt: '',
        },
      ],
    })

    render(
      <MemoryRouter>
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    fireEvent.change(screen.getByPlaceholderText('globalSearch.placeholder'), {
      target: { value: 'ng' },
    })

    const favoriteButton = await waitFor(() =>
      screen.getByRole('button', { name: 'Add to favorites' })
    )
    fireEvent.click(favoriteButton)

    await waitFor(() => expect(favoriteButton).toBeDisabled())
    expect(favoriteButton).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(favoriteButton)
    expect(toggleFavoriteMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveToggle()
    })
  })

  it('tracks cluster selection in cluster mode', async () => {
    render(
      <MemoryRouter>
        <GlobalSearch open mode="cluster" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    fireEvent.click(screen.getByText('dev'))

    await waitFor(() => {
      expect(setCurrentClusterMock).toHaveBeenCalledWith('dev')
    })

    expect(trackDesktopEvent).toHaveBeenCalledWith('global_search_select', {
      mode: 'cluster',
      item_type: 'cluster',
    })
  })

  it('shows the current cluster search history in reverse chronological order', () => {
    localStorage.setItem(
      'global-search-history-v1-prod',
      JSON.stringify([
        {
          id: 'resource:/pods/default/older',
          type: 'resource',
          label: 'older',
          path: '/pods/default/older',
          query: 'old',
          resourceType: 'pods',
          namespace: 'default',
          lastAccessedAt: '2026-04-24T10:00:00.000Z',
        },
        {
          id: 'resource:/pods/default/newer',
          type: 'resource',
          label: 'newer',
          path: '/pods/default/newer',
          query: 'new',
          resourceType: 'pods',
          namespace: 'default',
          lastAccessedAt: '2026-04-24T11:00:00.000Z',
        },
      ])
    )

    render(
      <MemoryRouter>
        <GlobalSearch open mode="all" onOpenChange={vi.fn()} />
      </MemoryRouter>
    )

    expect(screen.getByText('globalSearch.history')).toBeInTheDocument()

    const historyButtons = screen
      .getAllByRole('button')
      .filter(
        (button) =>
          button.textContent?.includes('older') ||
          button.textContent?.includes('newer')
      )

    expect(historyButtons).toHaveLength(2)
    expect(historyButtons[0]).toHaveTextContent('newer')
    expect(historyButtons[1]).toHaveTextContent('older')
  })
})
