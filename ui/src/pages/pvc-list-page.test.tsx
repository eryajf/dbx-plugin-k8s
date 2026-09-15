import { type ReactNode } from 'react'
import { createColumnHelper, flexRender } from '@tanstack/react-table'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { PersistentVolumeClaim } from 'kubernetes-types/core/v1'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { formatDate, formatRelativeTimeStrict } from '@/lib/utils'

import { PVCListPage } from './pvc-list-page'

const mockNavigate = vi.fn()
const mockCopyTextToClipboard = vi.fn()
const mockInvalidateQueries = vi.fn()
const mockResourceTable = vi.fn(
  ({
    onCreateClick,
    resourceName,
    showCreateButton,
  }: {
    onCreateClick?: () => void
    resourceName: string
    showCreateButton?: boolean
  }) => (
    <div>
      <span>{resourceName}</span>
      <span>{showCreateButton ? 'create-enabled' : 'create-disabled'}</span>
      <button onClick={onCreateClick}>open-create</button>
    </div>
  )
)

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

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>(
    '@tanstack/react-query'
  )

  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: mockInvalidateQueries,
    }),
  }
})

vi.mock('@/lib/desktop', () => ({
  copyTextToClipboard: (value: string) => mockCopyTextToClipboard(value),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
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

vi.mock('@/components/editors/storage-create-dialogs', () => ({
  PVCCreateDialog: ({
    open,
    onSuccess,
  }: {
    open: boolean
    onSuccess: (pvc: PersistentVolumeClaim, namespace: string) => void
  }) =>
    open ? (
      <div>
        <span>pvc-create-dialog</span>
        <button
          onClick={() =>
            onSuccess(
              {
                metadata: {
                  name: 'data-web-0',
                },
              } as PersistentVolumeClaim,
              'default'
            )
          }
        >
          finish-create
        </button>
      </div>
    ) : null,
}))

vi.mock('@/components/editors/storage-edit-dialogs', () => ({
  PVCResizeDialog: ({ open }: { open: boolean }) =>
    open ? <div>pvc-resize-dialog</div> : null,
}))

describe('PVCListPage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T13:53:27.000Z'))
    mockNavigate.mockReset()
    mockCopyTextToClipboard.mockReset()
    mockInvalidateQueries.mockReset()
    mockResourceTable.mockClear()
  })

  it('opens pvc create dialog and navigates to the created resource', async () => {
    render(<PVCListPage />)

    expect(screen.getByText('create-enabled')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'open-create' }))
    expect(screen.getByText('pvc-create-dialog')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'finish-create' }))
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ['persistentvolumeclaims'],
    })
    await Promise.resolve()
    expect(mockNavigate).toHaveBeenCalledWith(
      '/persistentvolumeclaims/default/data-web-0'
    )
  })

  it('renders pvc creation time with relative age', () => {
    render(<PVCListPage />)

    const resourceTableProps = mockResourceTable.mock.calls[0]?.[0] as {
      columns: ReturnType<typeof createColumnHelper<PersistentVolumeClaim>>[]
    }
    const createdAt = '2026-05-09T13:53:27.000Z'
    const createdColumn = resourceTableProps.columns.at(-1)

    const renderedCell = render(
      <div>
        {flexRender(createdColumn!.cell!, {
          getValue: () => createdAt,
        })}
      </div>
    )

    expect(renderedCell.container).toHaveTextContent(
      `${formatDate(createdAt)} (${formatRelativeTimeStrict(createdAt)})`
    )
  })

  it('provides unified row actions for pvc resources', async () => {
    render(<PVCListPage />)

    const resourceTableProps = mockResourceTable.mock.calls[0]?.[0] as {
      getRowContextMenuItems: (pvc: PersistentVolumeClaim) => {
        key: string
        onSelect?: () => void | Promise<void>
      }[]
    }

    const pvc = {
      metadata: {
        name: 'data-web-0',
        namespace: 'default',
      },
      spec: {
        volumeName: 'pv-data-web-0',
        storageClassName: 'fast-ssd',
      },
    } as PersistentVolumeClaim

    const items = resourceTableProps.getRowContextMenuItems(pvc)

    expect(items.map((item) => item.key)).toEqual([
      'view-yaml',
      'resize-pvc',
      'primary-actions-separator',
      'copy-name',
      'copy-namespace',
      'copy-volume',
      'copy-storage-class',
      'metadata-actions-separator',
      'manage-labels',
      'manage-annotations',
    ])

    await items[0].onSelect?.()
    expect(mockNavigate).toHaveBeenCalledWith(
      '/persistentvolumeclaims/default/data-web-0?tab=yaml'
    )

    await act(async () => {
      await items[1].onSelect?.()
    })
    expect(screen.getByText('pvc-resize-dialog')).toBeInTheDocument()

    await items[3].onSelect?.()
    expect(mockCopyTextToClipboard).toHaveBeenCalledWith('data-web-0')

    await items[4].onSelect?.()
    expect(mockCopyTextToClipboard).toHaveBeenCalledWith('default')

    await items[5].onSelect?.()
    expect(mockCopyTextToClipboard).toHaveBeenCalledWith('pv-data-web-0')

    await items[6].onSelect?.()
    expect(mockCopyTextToClipboard).toHaveBeenCalledWith('fast-ssd')

    await act(async () => {
      await items[8].onSelect?.()
    })
    expect(
      screen.getByText('resource-metadata-dialog-labels')
    ).toBeInTheDocument()

    await act(async () => {
      await items[9].onSelect?.()
    })
    expect(
      screen.getByText('resource-metadata-dialog-annotations')
    ).toBeInTheDocument()
  })
})
