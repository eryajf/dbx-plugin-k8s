import '@/i18n'

import { createColumnHelper } from '@tanstack/react-table'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import i18n from 'i18next'
import { Deployment } from 'kubernetes-types/apps/v1'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ResourceTable } from './resource-table'

const deleteResourceMock = vi.fn()
const useFeatureMock = vi.fn()
const useResourcesMock = vi.fn()
const useClusterInfoMock = vi.fn()
let resourceData: Array<{
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
  useCluster: () => ({ currentCluster: 'test-cluster' }),
}))

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
})
