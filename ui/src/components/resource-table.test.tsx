import '@/i18n'

import { createColumnHelper } from '@tanstack/react-table'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import i18n from 'i18next'
import { Deployment } from 'kubernetes-types/apps/v1'
import { StrictMode, cloneElement, useState } from 'react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ResourceTable } from './resource-table'

const deleteResourceMock = vi.fn()
const useFeatureMock = vi.fn()
const useResourcesMock = vi.fn()
const useClusterInfoMock = vi.fn()
const useFavoritesMock = vi.fn()
const toggleFavoriteMock = vi.fn()
let resourceData: Array<{
  apiVersion?: string
  metadata: {
    name: string
    namespace: string
    uid: string
    creationTimestamp?: string
  }
}> = [
  {
    metadata: {
      name: 'demo',
      namespace: 'default',
      uid: 'deploy-1',
    },
  },
]
let currentClusterMock: string | null = 'test-cluster'
let updateClusterMock: ((cluster: string | null) => void) | undefined

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')

  return {
    ...actual,
    deleteResource: (...args: unknown[]) => deleteResourceMock(...args),
    useClusterInfo: (...args: unknown[]) => {
      useClusterInfoMock(...args)
      return {
        data: { namespace: 'ops' },
        isLoading: false,
        isError: false,
        error: null,
      }
    },
    useResources: (...args: unknown[]) => {
      useResourcesMock(...args)
      return {
        isLoading: false,
        data: resourceData,
        isError: false,
        error: null,
        refetch: vi.fn(),
      }
    },
    useResourcesWatch: () => ({
      data: undefined,
      isLoading: false,
      error: null,
      isConnected: false,
      refetch: vi.fn(),
    }),
  }
})

vi.mock('@/hooks/use-license', () => ({
  useFeature: (feature: string) => useFeatureMock(feature),
}))

vi.mock('@/hooks/use-cluster', () => ({
  useCluster: () => ({ currentCluster: currentClusterMock }),
}))

vi.mock('@/hooks/use-favorites', () => ({
  useFavorites: () => useFavoritesMock(),
}))

function ClusterHarness({ children }: { children: ReactElement }) {
  const [cluster, setCluster] = useState<string | null>(currentClusterMock)
  currentClusterMock = cluster
  updateClusterMock = setCluster
  return (
    <>
      <span data-testid="active-cluster">{cluster}</span>
      {cloneElement(children)}
    </>
  )
}

function renderTable(
  resourceName = 'Deployments',
  resourceType: string = 'deployments',
  strict = false
) {
  const columnHelper = createColumnHelper<Deployment>()
  const table = (
    <ClusterHarness>
      <ResourceTable
        resourceName={resourceName}
        resourceType={resourceType as 'deployments'}
        clusterScope={true}
        columns={[
          columnHelper.accessor('metadata.name', {
            header: 'Name',
            cell: ({ row }) => row.original.metadata?.name,
          }),
        ]}
      />
    </ClusterHarness>
  )
  return render(strict ? <StrictMode>{table}</StrictMode> : table)
}

describe('ResourceTable batch delete confirmation', () => {
  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & {
        ResizeObserver: new (callback: ResizeObserverCallback) => ResizeObserver
      }
    ).ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as new (callback: ResizeObserverCallback) => ResizeObserver
    localStorage.setItem('current-cluster', 'test-cluster')
    localStorage.removeItem('test-clusterselectedNamespace')
    deleteResourceMock.mockReset()
    useResourcesMock.mockReset()
    resourceData = [
      {
        metadata: {
          name: 'demo',
          namespace: 'default',
          uid: 'deploy-1',
        },
      },
    ]
    useClusterInfoMock.mockReset()
    deleteResourceMock.mockResolvedValue(undefined)
    useFeatureMock.mockReset()
    useFeatureMock.mockReturnValue(true)
    currentClusterMock = 'test-cluster'
    updateClusterMock = undefined
    toggleFavoriteMock.mockReset()
    useFavoritesMock.mockReset()
    useFavoritesMock.mockReturnValue({
      isFavorite: () => false,
      isError: false,
      isLoading: false,
      isMutating: false,
      toggleFavorite: toggleFavoriteMock,
    })
  })

  it('requires the global confirmation keyword before deleting selected rows', async () => {
    void i18n.changeLanguage('zh')

    const columnHelper = createColumnHelper<Deployment>()

    render(
      <ResourceTable
        resourceName="Deployments"
        resourceType="deployments"
        clusterScope={true}
        columns={[
          columnHelper.accessor('metadata.name', {
            header: 'Name',
            cell: ({ row }) => row.original.metadata?.name,
          }),
        ]}
      />
    )

    fireEvent.click(screen.getByLabelText('选择行'))
    fireEvent.click(screen.getByRole('button', { name: '删除 (1)' }))

    const confirmButton = screen.getByRole('button', { name: '删除' })
    expect(confirmButton).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/输入/), {
      target: { value: 'demo' },
    })
    expect(confirmButton).toBeDisabled()

    fireEvent.change(screen.getByLabelText(/输入/), {
      target: { value: '确认删除' },
    })
    expect(confirmButton).not.toBeDisabled()

    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(deleteResourceMock).toHaveBeenCalledWith(
        'deployments',
        'demo',
        undefined
      )
    })
  })

  it('opens a row context menu and triggers the selected action', async () => {
    const onInspect = vi.fn()
    const columnHelper = createColumnHelper<Deployment>()

    render(
      <ResourceTable
        resourceName="Deployments"
        resourceType="deployments"
        clusterScope={true}
        columns={[
          columnHelper.accessor('metadata.name', {
            header: 'Name',
            cell: ({ row }) => row.original.metadata?.name,
          }),
        ]}
        getRowContextMenuItems={(item) => [
          {
            key: 'inspect',
            label: 'Inspect resource',
            onSelect: () => onInspect(item.metadata?.name),
          },
        ]}
      />
    )

    fireEvent.contextMenu(screen.getByText('demo'))

    const menuItem = await screen.findByText('Inspect resource')
    fireEvent.click(menuItem)

    expect(onInspect).toHaveBeenCalledWith('demo')
  })

  it('renders an actions column menu that uses the same row actions', async () => {
    const onInspect = vi.fn()
    const columnHelper = createColumnHelper<Deployment>()

    render(
      <ResourceTable
        resourceName="Deployments"
        resourceType="deployments"
        clusterScope={true}
        columns={[
          columnHelper.accessor('metadata.name', {
            header: 'Name',
            cell: ({ row }) => row.original.metadata?.name,
          }),
        ]}
        getRowContextMenuItems={(item) => [
          {
            key: 'inspect',
            label: 'Inspect resource',
            onSelect: () => onInspect(item.metadata?.name),
          },
        ]}
      />
    )

    fireEvent.pointerEnter(
      screen.getAllByRole('button', { name: /Actions|操作/i })[0]
    )

    const menuItem = await screen.findByText('Inspect resource')
    fireEvent.click(menuItem)

    expect(onInspect).toHaveBeenCalledWith('demo')
  })

  it.each([
    ['while favorites are loading', { isLoading: true }],
    ['when loading favorites failed', { isError: true }],
    ['while a favorite mutation is pending', { isMutating: true }],
  ])('disables the favorite action %s', async (_label, state) => {
    void i18n.changeLanguage('en')
    useFavoritesMock.mockReturnValue({
      isFavorite: () => false,
      isError: false,
      isLoading: false,
      isMutating: false,
      toggleFavorite: toggleFavoriteMock,
      ...state,
    })

    const columnHelper = createColumnHelper<Deployment>()

    render(
      <ResourceTable
        resourceName="Deployments"
        resourceType="deployments"
        clusterScope={true}
        columns={[
          columnHelper.accessor('metadata.name', {
            header: 'Name',
          }),
        ]}
      />
    )

    fireEvent.pointerEnter(
      screen.getAllByRole('button', { name: /Actions|操作/i })[0]
    )

    const favoriteItem = await screen.findByRole('menuitem', {
      name: 'Add to favorites',
    })
    expect(favoriteItem).toHaveAttribute('aria-disabled', 'true')
    expect(favoriteItem).toHaveAttribute('data-disabled', '')
    fireEvent.click(favoriteItem)
    expect(toggleFavoriteMock).not.toHaveBeenCalled()
  })

  it('passes the row API version when adding a favorite', async () => {
    resourceData = [
      {
        apiVersion: 'autoscaling/v2',
        metadata: {
          name: 'my-hpa',
          namespace: 'default',
          uid: 'hpa-1',
        },
      },
    ]
    useFavoritesMock.mockReturnValue({
      isFavorite: () => false,
      isError: false,
      isLoading: false,
      isMutating: false,
      toggleFavorite: toggleFavoriteMock,
    })

    const columnHelper = createColumnHelper<Deployment>()

    render(
      <ResourceTable
        resourceName="HorizontalPodAutoscalers"
        resourceType="horizontalpodautoscalers"
        clusterScope={true}
        columns={[
          columnHelper.accessor('metadata.name', {
            header: 'Name',
          }),
        ]}
      />
    )

    fireEvent.pointerEnter(
      screen.getAllByRole('button', { name: /Actions|操作/i })[0]
    )
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Add to favorites' })
    )

    expect(toggleFavoriteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'my-hpa',
        namespace: 'default',
        resourceType: 'horizontalpodautoscalers',
        group: 'autoscaling',
        version: 'v2',
      })
    )
  })

  it('opens the actions menu on hover and closes after leaving trigger and menu', async () => {
    const columnHelper = createColumnHelper<Deployment>()

    render(
      <ResourceTable
        resourceName="Deployments"
        resourceType="deployments"
        clusterScope={true}
        columns={[
          columnHelper.accessor('metadata.name', {
            header: 'Name',
            cell: ({ row }) => row.original.metadata?.name,
          }),
        ]}
        getRowContextMenuItems={() => [
          {
            key: 'inspect',
            label: 'Inspect resource',
            onSelect: vi.fn(),
          },
        ]}
      />
    )

    const trigger = screen.getAllByRole('button', { name: /Actions|操作/i })[0]
    fireEvent.pointerEnter(trigger)

    const menuItem = await screen.findByText('Inspect resource')
    expect(menuItem).toBeInTheDocument()

    fireEvent.pointerLeave(trigger)
    fireEvent.pointerLeave(menuItem)

    await waitFor(() => {
      expect(screen.queryByText('Inspect resource')).not.toBeInTheDocument()
    })
  })

  it('disables batch delete for Community edition', () => {
    useFeatureMock.mockImplementation((feature: string) => {
      if (feature === 'resource.batchActions') {
        return false
      }
      return true
    })
    void i18n.changeLanguage('en')

    const columnHelper = createColumnHelper<Deployment>()

    render(
      <ResourceTable
        resourceName="Deployments"
        resourceType="deployments"
        clusterScope={true}
        columns={[
          columnHelper.accessor('metadata.name', {
            header: 'Name',
            cell: ({ row }) => row.original.metadata?.name,
          }),
        ]}
      />
    )

    expect(screen.getByRole('checkbox', { name: 'Select All (1)' })).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Select row'))

    const batchDeleteButton = screen.getByRole('button', {
      name: 'Requires Kite Desktop Pro',
    })
    expect(batchDeleteButton).toBeDisabled()
    expect(batchDeleteButton).toHaveAttribute(
      'title',
      'Requires Kite Desktop Pro'
    )
  })

  it('uses the connected cluster default namespace when no selection is saved', async () => {
    void i18n.changeLanguage('en')

    const columnHelper = createColumnHelper<Deployment>()

    render(
      <ResourceTable
        resourceName="Deployments"
        resourceType="deployments"
        columns={[
          columnHelper.accessor('metadata.name', {
            header: 'Name',
            cell: ({ row }) => row.original.metadata?.name,
          }),
        ]}
      />
    )

    await waitFor(() => {
      expect(useResourcesMock).toHaveBeenCalledWith(
        'deployments',
        'ops',
        expect.objectContaining({ disable: false })
      )
    })
    expect(screen.getByText('ops')).toBeInTheDocument()
  })

  it('applies initial sorting before the user changes table sorting', () => {
    resourceData = [
      {
        metadata: {
          name: 'older',
          namespace: 'default',
          uid: 'deploy-older',
          creationTimestamp: '2026-05-01T00:00:00Z',
        },
      },
      {
        metadata: {
          name: 'newer',
          namespace: 'default',
          uid: 'deploy-newer',
          creationTimestamp: '2026-05-02T00:00:00Z',
        },
      },
    ]

    const columnHelper = createColumnHelper<Deployment>()

    render(
      <ResourceTable
        resourceName="Deployments"
        resourceType="deployments"
        clusterScope={true}
        initialSorting={[{ id: 'created', desc: true }]}
        columns={[
          columnHelper.accessor('metadata.name', {
            header: 'Name',
          }),
          columnHelper.accessor('metadata.creationTimestamp', {
            id: 'created',
            header: 'Created',
          }),
        ]}
      />
    )

    const rows = screen.getAllByRole('row').slice(1)
    expect(
      rows.map((row) => within(row).getAllByRole('cell')[1]?.textContent)
    ).toEqual(['newer', 'older'])
  })

  it('keeps a saved namespace ahead of the connected cluster default', async () => {
    localStorage.setItem('test-clusterselectedNamespace', 'qa')

    const columnHelper = createColumnHelper<Deployment>()

    render(
      <ResourceTable
        resourceName="Deployments"
        resourceType="deployments"
        columns={[
          columnHelper.accessor('metadata.name', {
            header: 'Name',
            cell: ({ row }) => row.original.metadata?.name,
          }),
        ]}
      />
    )

    await waitFor(() => {
      expect(useResourcesMock).toHaveBeenCalledWith(
        'deployments',
        'qa',
        expect.objectContaining({ disable: false })
      )
    })
    expect(screen.getByText('qa')).toBeInTheDocument()
  })

  it('loads search state from the connected cluster instead of stale local storage', async () => {
    localStorage.setItem('current-cluster', 'stale-cluster')
    sessionStorage.setItem(
      'stale-cluster-Deployments-searchQuery',
      'stale'
    )
    sessionStorage.setItem('test-cluster-Deployments-searchQuery', 'demo')
    resourceData = [
      {
        metadata: { name: 'demo', namespace: 'default', uid: 'deploy-1' },
      },
      {
        metadata: { name: 'stale', namespace: 'default', uid: 'deploy-2' },
      },
    ]

    renderTable('Deployments', 'deployments', true)

    const input = await waitFor(() =>
      screen.getByPlaceholderText('Search resources...')
    )
    await waitFor(() => expect(input).toHaveValue('demo'))
    expect(screen.getByText('demo')).toBeInTheDocument()
    expect(screen.queryByText('stale')).not.toBeInTheDocument()
    expect(sessionStorage.getItem('stale-cluster-Deployments-searchQuery')).toBe(
      'stale'
    )
    expect(sessionStorage.getItem('test-cluster-Deployments-searchQuery')).toBe(
      'demo'
    )
  })

  it('keeps search state isolated while switching the same table A to B to A', async () => {
    sessionStorage.setItem('test-cluster-Deployments-searchQuery', 'demo')
    sessionStorage.setItem('cluster-b-Deployments-searchQuery', 'worker')
    resourceData = [
      {
        metadata: { name: 'demo', namespace: 'default', uid: 'deploy-1' },
      },
      {
        metadata: { name: 'worker', namespace: 'default', uid: 'deploy-2' },
      },
    ]

    renderTable()
    const input = screen.getByPlaceholderText('Search resources...')
    await waitFor(() => expect(input).toHaveValue('demo'))
    expect(screen.getByText('demo')).toBeInTheDocument()
    expect(screen.queryByText('worker')).not.toBeInTheDocument()

    await act(async () => {
      updateClusterMock?.('cluster-b')
    })
    expect(screen.getByTestId('active-cluster')).toHaveTextContent('cluster-b')
    await waitFor(() => expect(input).toHaveValue('worker'))
    expect(screen.getByText('worker')).toBeInTheDocument()
    expect(screen.queryByText('demo')).not.toBeInTheDocument()

    await act(async () => {
      updateClusterMock?.('test-cluster')
    })
    expect(screen.getByTestId('active-cluster')).toHaveTextContent('test-cluster')
    await waitFor(() => expect(input).toHaveValue('demo'))
    expect(screen.getByText('demo')).toBeInTheDocument()
    expect(screen.queryByText('worker')).not.toBeInTheDocument()
    expect(sessionStorage.getItem('test-cluster-Deployments-searchQuery')).toBe(
      'demo'
    )
    expect(sessionStorage.getItem('cluster-b-Deployments-searchQuery')).toBe(
      'worker'
    )
  })

  it('clears and persists a new search on the active cluster key', async () => {
    sessionStorage.setItem('test-cluster-Deployments-searchQuery', 'demo')
    resourceData = [
      {
        metadata: { name: 'demo', namespace: 'default', uid: 'deploy-1' },
      },
      {
        metadata: { name: 'worker', namespace: 'default', uid: 'deploy-2' },
      },
    ]

    renderTable()
    const input = screen.getByPlaceholderText('Search resources...')
    await waitFor(() => expect(input).toHaveValue('demo'))

    fireEvent.change(input, { target: { value: '' } })
    await waitFor(() => expect(input).toHaveValue(''))
    expect(sessionStorage.getItem('test-cluster-Deployments-searchQuery')).toBe(
      null
    )
    expect(screen.getByText('worker')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'work' } })
    await waitFor(() => expect(input).toHaveValue('work'))
    expect(screen.getByText('worker')).toBeInTheDocument()
    expect(screen.queryByText('demo')).not.toBeInTheDocument()
    expect(sessionStorage.getItem('test-cluster-Deployments-searchQuery')).toBe(
      'work'
    )
  })

  it('does not persist a query under a null cluster before context is ready', async () => {
    currentClusterMock = null
    localStorage.setItem('current-cluster', 'stale-cluster')
    sessionStorage.setItem('stale-cluster-Deployments-searchQuery', 'stale')

    renderTable()
    const input = screen.getByPlaceholderText('Search resources...')
    expect(input).toHaveValue('')

    fireEvent.change(input, { target: { value: 'typed' } })
    await waitFor(() => expect(input).toHaveValue('typed'))
    expect(sessionStorage.getItem('null-Deployments-searchQuery')).toBe(null)
    expect(sessionStorage.getItem('-Deployments-searchQuery')).toBe(null)
    expect(sessionStorage.getItem('stale-cluster-Deployments-searchQuery')).toBe(
      'stale'
    )

    sessionStorage.setItem('test-cluster-Deployments-searchQuery', 'demo')
    await act(async () => {
      updateClusterMock?.('test-cluster')
    })
    expect(screen.getByTestId('active-cluster')).toHaveTextContent('test-cluster')
    await waitFor(() => expect(input).toHaveValue('demo'))
    expect(sessionStorage.getItem('null-Deployments-searchQuery')).toBe(null)
    expect(sessionStorage.getItem('-Deployments-searchQuery')).toBe(null)
  })
})
