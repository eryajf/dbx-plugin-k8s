import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Namespace, ResourceQuota } from 'kubernetes-types/core/v1'
import { describe, expect, it, vi } from 'vitest'

import { NamespaceEditDialog } from './namespace-edit-dialog'

const mockInvalidateQueries = vi.fn()
const mockCreateResource = vi.fn()
const mockUpdateResource = vi.fn()

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()

  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  }
})

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()

  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: mockInvalidateQueries,
    }),
  }
})

vi.mock('@/lib/api', () => ({
  createResource: (...args: unknown[]) => mockCreateResource(...args),
  updateResource: (...args: unknown[]) => mockUpdateResource(...args),
}))

describe('NamespaceEditDialog', () => {
  it('shows all standard namespace resource quota items directly and saves multiple limits', async () => {
    const namespace = {
      metadata: {
        name: 'team-a',
      },
    } as Namespace

    const resourceQuota = {
      metadata: {
        name: 'team-a-quota',
        namespace: 'team-a',
      },
      spec: {
        hard: {
          'limits.cpu': '4',
          'requests.memory': '8Gi',
        },
      },
    } as ResourceQuota

    render(
      <NamespaceEditDialog
        open={true}
        onOpenChange={() => undefined}
        namespace={namespace}
        resourceQuota={resourceQuota}
      />
    )

    expect(
      screen.getByRole('button', {
        name: 'namespaceEditDialog.groupComputeResources',
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'namespaceEditDialog.groupStorageResources',
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'namespaceEditDialog.groupOtherResources',
      })
    ).toBeInTheDocument()

    expect(
      screen.getAllByText('resourceQuotaKey.limitsCpu').length
    ).toBeGreaterThan(0)
    expect(
      screen.getAllByText('resourceQuotaKey.requestsMemory').length
    ).toBeGreaterThan(0)
    expect(screen.getByDisplayValue('4')).toBeInTheDocument()
    expect(
      screen.getAllByText('namespaceEditDialog.unitCpuCore').length
    ).toBeGreaterThan(0)
    expect(screen.getByDisplayValue('8')).toBeInTheDocument()
    expect(
      screen.getAllByText('namespaceEditDialog.unitGi').length
    ).toBeGreaterThan(0)
    expect(screen.queryByText('resourceQuotaKey.pods')).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'namespaceEditDialog.groupOtherResources',
      })
    )
    expect(screen.getAllByText('resourceQuotaKey.pods').length).toBeGreaterThan(
      0
    )
    expect(
      screen.getAllByText('namespaceEditDialog.unitCount').length
    ).toBeGreaterThan(0)
    expect(
      screen.queryByRole('button', { name: 'namespaceEditDialog.addQuotaItem' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'namespaceEditDialog.addCustomQuotaItem',
      })
    ).toBeInTheDocument()

    fireEvent.change(
      screen.getByRole('textbox', { name: 'resourceQuotaKey.pods' }),
      { target: { value: '20' } }
    )

    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))

    await waitFor(() => {
      expect(mockUpdateResource).toHaveBeenCalledWith(
        'resourcequotas',
        'team-a-quota',
        'team-a',
        expect.objectContaining({
          spec: {
            hard: {
              pods: '20',
              'limits.cpu': '4',
              'requests.memory': '8Gi',
            },
          },
        })
      )
    })
  })

  it('creates a resource quota from the visible standard quota items', async () => {
    const namespace = {
      metadata: {
        name: 'team-a',
      },
    } as Namespace

    render(
      <NamespaceEditDialog
        open={true}
        onOpenChange={() => undefined}
        namespace={namespace}
        resourceQuota={null}
      />
    )

    fireEvent.change(
      screen.getByRole('textbox', { name: 'resourceQuotaKey.requestsCpu' }),
      { target: { value: '5' } }
    )

    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))

    await waitFor(() => {
      expect(mockCreateResource).toHaveBeenCalledWith(
        'resourcequotas',
        'team-a',
        expect.objectContaining({
          metadata: expect.objectContaining({
            name: 'team-a-quota',
          }),
          spec: {
            hard: {
              'requests.cpu': '5',
            },
          },
        })
      )
    })
  })

  it('uses a scrollable content area with fixed footer actions', () => {
    const namespace = {
      metadata: {
        name: 'team-a',
      },
    } as Namespace

    render(
      <NamespaceEditDialog
        open={true}
        onOpenChange={() => undefined}
        namespace={namespace}
        resourceQuota={null}
      />
    )

    const dialogContent = document.querySelector('[data-slot="dialog-content"]')
    expect(dialogContent).toHaveClass('h-[85vh]')
    expect(dialogContent).toHaveClass('overflow-hidden')

    const form = screen
      .getByRole('button', { name: 'common.save' })
      .closest('form')
    expect(form).toHaveClass('flex-1')
    expect(form).toHaveClass('overflow-hidden')

    const footer = screen.getByRole('button', {
      name: 'common.save',
    }).parentElement
    expect(footer).toHaveClass('shrink-0')
    expect(footer).toHaveClass('border-t')
  })

  it('shows a resource quota guide and official documentation link', () => {
    const namespace = {
      metadata: {
        name: 'team-a',
      },
    } as Namespace

    render(
      <NamespaceEditDialog
        open={true}
        onOpenChange={() => undefined}
        namespace={namespace}
        resourceQuota={null}
      />
    )

    expect(
      screen.getByText('namespaceEditDialog.resourceQuotaGuideTitle')
    ).toBeInTheDocument()
    expect(
      screen.getByText('namespaceEditDialog.resourceQuotaGuideDescription')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', {
        name: 'namespaceEditDialog.resourceQuotaGuideLink',
      })
    ).toHaveAttribute(
      'href',
      'https://kubernetes.io/zh-cn/docs/concepts/policy/resource-quotas'
    )
  })
})
