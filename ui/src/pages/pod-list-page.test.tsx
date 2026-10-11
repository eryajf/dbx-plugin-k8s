import { type ReactNode } from 'react'
import {
  createTable,
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  type ColumnDef,
} from '@tanstack/react-table'
import { act, render, screen } from '@testing-library/react'
import type { Pod } from 'kubernetes-types/core/v1'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PodListPage } from './pod-list-page'

const mockNavigate = vi.fn()
const mockResourceTable = vi.fn(
  ({ resourceName }: { resourceName: string }) => <div>{resourceName}</div>
)
const mockOpenSession = vi.fn()

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()

  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  }
})

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>('react-router-dom')

  return {
    ...actual,
    Link: ({ children, to }: { children: ReactNode; to: string }) => (
      <a href={to}>{children}</a>
    ),
    useNavigate: () => mockNavigate,
  }
})

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/contexts/terminal-context', () => ({
  useTerminal: () => ({
    openSession: mockOpenSession,
  }),
}))

vi.mock('@/components/resource-table', () => ({
  ResourceTable: (props: { resourceName: string }) => mockResourceTable(props),
}))

vi.mock('@/components/editors/resource-metadata-dialog', () => ({
  ResourceMetadataDialog: ({
    open,
    type,
    resource,
  }: {
    open: boolean
    type: 'labels' | 'annotations'
    resource?: { metadata?: { name?: string } } | null
  }) =>
    open ? (
      <div>
        <span>{`resource-metadata-dialog-${type}`}</span>
        <span>{resource?.metadata?.name}</span>
      </div>
    ) : null,
}))

vi.mock('@/components/resource-delete-confirmation-dialog', () => ({
  ResourceDeleteConfirmationDialog: ({
    open,
    resourceName,
    resourceType,
    namespace,
  }: {
    open: boolean
    resourceName: string
    resourceType: string
    namespace?: string
  }) =>
    open ? (
      <div>
        <span>resource-delete-confirmation-dialog</span>
        <span>{`${resourceType}/${namespace}/${resourceName}`}</span>
      </div>
    ) : null,
}))

describe('PodListPage', () => {
  beforeEach(() => {
    mockNavigate.mockReset()
    mockResourceTable.mockClear()
    mockOpenSession.mockClear()
  })

  it('facets and filters by the status shown in the cell, not the Pod phase', () => {
    render(<PodListPage />)
    const { columns } = mockResourceTable.mock.calls[0][0] as unknown as {
      columns: ColumnDef<Pod>[]
    }
    const data = ['ImagePullBackOff', 'CrashLoopBackOff'].map(
      (reason) =>
        ({
          metadata: { name: reason },
          spec: { containers: [{ name: 'app' }] },
          status: {
            phase: 'Running',
            containerStatuses: [
              {
                name: 'app',
                ready: false,
                restartCount: 0,
                image: 'app',
                imageID: '',
                state: { waiting: { reason } },
              },
            ],
          },
        }) as Pod
    )
    const table = createTable({
      data,
      columns: columns.map((column) => ({
        ...column,
        filterFn: (row, id, values: string[]) =>
          values.includes(String(row.getValue(id))),
      })),
      state: { columnFilters: [{ id: 'status', value: ['ImagePullBackOff'] }] },
      onStateChange: () => {},
      renderFallbackValue: null,
      getCoreRowModel: getCoreRowModel(),
      getFilteredRowModel: getFilteredRowModel(),
      getFacetedRowModel: getFacetedRowModel(),
      getFacetedUniqueValues: getFacetedUniqueValues(),
    })
    expect([
      ...table.getColumn('status')!.getFacetedUniqueValues().entries(),
    ]).toEqual([
      ['ImagePullBackOff', 1],
      ['CrashLoopBackOff', 1],
    ])
    expect(
      table.getFilteredRowModel().rows.map((row) => row.original.metadata?.name)
    ).toEqual(['ImagePullBackOff'])
    const cell = table
      .getFilteredRowModel()
      .rows[0].getAllCells()
      .find((cell) => cell.column.id === 'status')!
    const Cell = cell.column.columnDef.cell as (context: unknown) => ReactNode
    render(<>{Cell(cell.getContext())}</>)
    expect(screen.getByText('ImagePullBackOff')).toBeInTheDocument()
  })

  it('keeps the restart accessor stable as time passes without another restart', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-11T00:00:30Z'))
      render(<PodListPage />)
      const { columns } = mockResourceTable.mock.calls[0][0] as unknown as {
        columns: ColumnDef<Pod>[]
      }
      const column = columns.find((column) => column.id === 'restarts')!
      const pod = {
        spec: { containers: [{ name: 'app' }] },
        status: {
          phase: 'Running',
          containerStatuses: [
            {
              name: 'app',
              ready: true,
              restartCount: 1,
              state: { running: {} },
              lastState: { terminated: { finishedAt: '2026-10-11T00:00:00Z' } },
            },
          ],
        },
      } as Pod
      if (!('accessorFn' in column)) throw new Error('missing restart accessor')
      expect(column.accessorFn!(pod, 0)).toBe(1)
      vi.setSystemTime(new Date('2026-10-11T00:01:35Z'))
      expect(column.accessorFn!(pod, 0)).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('provides unified row actions for pods', async () => {
    render(<PodListPage />)

    const resourceTableProps = mockResourceTable.mock.calls[0]?.[0] as {
      getRowContextMenuItems: (pod: Pod) => {
        key: string
        disabled?: boolean | ((item: unknown) => boolean)
        onSelect?: () => void | Promise<void>
      }[]
    }

    const pod = {
      metadata: {
        name: 'api-0',
        namespace: 'default',
      },
      status: {
        podIP: '10.42.0.18',
      },
    } as Pod

    const items = resourceTableProps.getRowContextMenuItems(pod)

    expect(items.map((item) => item.key)).toEqual([
      'view-yaml',
      'open-terminal',
      'view-logs',
      'metadata-actions-separator',
      'manage-labels',
      'manage-annotations',
      'delete-pod',
    ])

    await items[0].onSelect?.()
    expect(mockNavigate).toHaveBeenCalledWith('/pods/default/api-0?tab=yaml')

    await items[1].onSelect?.()
    expect(mockOpenSession).toHaveBeenCalledWith({
      type: 'pod',
      namespace: 'default',
      podName: 'api-0',
      containers: undefined,
      initContainers: undefined,
      source: 'pod/api-0',
      entry: 'pod-list',
    })

    await items[2].onSelect?.()
    expect(mockNavigate).toHaveBeenCalledWith('/pods/default/api-0?tab=logs')

    await act(async () => {
      await items[4].onSelect?.()
    })
    expect(
      screen.getByText('resource-metadata-dialog-labels')
    ).toBeInTheDocument()

    await act(async () => {
      await items[5].onSelect?.()
    })
    expect(
      screen.getByText('resource-metadata-dialog-annotations')
    ).toBeInTheDocument()

    await act(async () => {
      await items[6].onSelect?.()
    })
    expect(
      screen.getByText('resource-delete-confirmation-dialog')
    ).toBeInTheDocument()
    expect(screen.getByText('pods/default/api-0')).toBeInTheDocument()
  })

  it('adds metadata, image, resource limit, and full timestamp columns', () => {
    render(<PodListPage />)

    const resourceTableProps = mockResourceTable.mock.calls[0]?.[0] as {
      initialSorting: { id: string; desc: boolean }[]
      columns: ColumnDef<Pod>[]
      searchQueryFilter: (pod: Pod, query: string) => boolean
    }

    expect(resourceTableProps.initialSorting).toEqual([
      { id: 'creationTimestamp', desc: true },
    ])

    expect(resourceTableProps.columns.map((column) => column.id)).toEqual(
      expect.arrayContaining([
        'labels',
        'annotations',
        'containers-and-images',
        'resource-limits',
        'creationTimestamp',
      ])
    )

    const pod = {
      metadata: {
        name: 'api-0',
        namespace: 'default',
        labels: {
          app: 'checkout',
        },
        annotations: {
          owner: 'platform',
        },
      },
      spec: {
        containers: [
          {
            name: 'api',
            image: 'ghcr.io/acme/checkout-api:v1.2.3',
          },
        ],
      },
      status: {
        podIP: '10.42.0.18',
      },
    } as Pod

    expect(resourceTableProps.searchQueryFilter(pod, 'checkout')).toBe(true)
    expect(resourceTableProps.searchQueryFilter(pod, 'platform')).toBe(true)
    expect(resourceTableProps.searchQueryFilter(pod, 'checkout-api')).toBe(true)
    expect(resourceTableProps.searchQueryFilter(pod, 'not-found')).toBe(false)
  })
})
