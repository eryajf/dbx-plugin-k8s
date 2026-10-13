import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Deployment } from 'kubernetes-types/apps/v1'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ContainerEditDialog } from './container-edit-dialog'

vi.mock('@radix-ui/react-dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@radix-ui/react-dialog')>()

  return {
    ...actual,
    DialogDescription: ({
      children,
      className,
    }: {
      children: React.ReactNode
      className?: string
    }) => <p className={className}>{children}</p>,
  }
})

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()

  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, string>) =>
        options?.name ? `${key}:${options.name}` : key,
    }),
  }
})

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>('react-router-dom')

  return {
    ...actual,
    useParams: () => ({ namespace: 'default' }),
  }
})

vi.mock('./editors', async () => ({
  EnvironmentEditor: () => <div>environment-editor</div>,
  ImageEditor: (await import('./editors/image-editor')).ImageEditor,
  ProbeGroupEditor: () => <div>probe-group-editor</div>,
  ResourceEditor: () => <div>resource-editor</div>,
  VolumeMountEditor: () => <div>volume-mount-editor</div>,
  VolumeSourceEditor: () => <div>volume-source-editor</div>,
}))

const deployment = {
  metadata: {
    name: 'web',
    namespace: 'default',
  },
  spec: {
    template: {
      spec: {
        containers: [
          {
            name: 'nginx-container',
            image: 'nginx:1.0',
          },
          {
            name: 'sidecar-container',
            image: 'busybox:1.0',
          },
        ],
      },
    },
  },
} as Deployment

describe('ContainerEditDialog', () => {
  let client: QueryClient
  const invoke = vi.fn()

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    invoke.mockReset()
    vi.stubGlobal('dbxPlugin', {
      context: { connectionId: 'container-dialog-regression' },
      invoke,
    })
  })

  afterEach(() => {
    client.clear()
    vi.unstubAllGlobals()
  })

  function renderDialog(
    props: React.ComponentProps<typeof ContainerEditDialog>,
  ) {
    return render(
      <QueryClientProvider client={client}>
        <ContainerEditDialog {...props} />
      </QueryClientProvider>,
    )
  }

  it('renders deployment containers as horizontal tabs', () => {
    renderDialog({
      open: true,
      onOpenChange: vi.fn(),
      mode: 'deployment',
      deployment,
      namespace: 'default',
      onSaveDeployment: vi.fn(),
    })

    const tabList = screen.getByRole('tablist', {
      name: 'containerEditor.containerSelector',
    })
    expect(tabList).toHaveAttribute('data-slot', 'tabs-list')
    expect(tabList).toHaveClass('overflow-x-auto')
    expect(
      screen.getByRole('tablist', {
        name: 'containerEditor.containerSelector',
      }),
    ).toBeInTheDocument()
    const selectedContainerTab = screen.getByRole('tab', {
      name: 'nginx-container',
    })
    expect(selectedContainerTab).toHaveAttribute('data-slot', 'tabs-trigger')
    expect(selectedContainerTab).toHaveAttribute('aria-selected', 'true')
    expect(selectedContainerTab).toHaveAttribute('data-state', 'active')
    expect(
      screen.getByRole('tab', { name: 'sidecar-container' }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('combobox')).toHaveLength(1)
    expect(screen.getByRole('combobox')).toHaveAttribute(
      'id',
      'image-pull-policy',
    )
  })

  it('saves a manually edited workload image after the real tag request fails', async () => {
    const onSaveWorkload = vi.fn().mockResolvedValue(undefined)
    const onOpenChange = vi.fn()
    renderDialog({
      open: true,
      onOpenChange,
      mode: 'deployment',
      workload: deployment,
      namespace: 'default',
      onSaveWorkload,
    })
    const input = screen.getByRole('textbox', {
      name: 'imageEditor.containerImage',
    })
    act(() => input.focus())
    await waitFor(() => {
      expect(client.getQueryState(['image-tags', 'nginx'])?.status).toBe(
        'error',
      )
    })
    expect(screen.getByText('imageEditor.noTagsAvailable')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'nginx:manual-release' } })
    fireEvent.click(
      screen.getByRole('button', { name: 'containerEditor.saveChanges' }),
    )

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(onSaveWorkload).toHaveBeenCalledTimes(1)
    expect(onSaveWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: expect.objectContaining({
          template: expect.objectContaining({
            spec: expect.objectContaining({
              containers: [
                expect.objectContaining({
                  name: 'nginx-container',
                  image: 'nginx:manual-release',
                }),
                expect.objectContaining({
                  name: 'sidecar-container',
                  image: 'busybox:1.0',
                }),
              ],
            }),
          }),
        }),
      }),
    )
    expect(deployment.spec?.template.spec?.containers[0].image).toBe(
      'nginx:1.0',
    )
    expect(invoke).not.toHaveBeenCalled()
  })

  it('cancels a manual image edit with malformed cached tags without saving', () => {
    client.setQueryData(['image-tags', 'nginx'], { items: [] })
    const onSaveWorkload = vi.fn()
    const onOpenChange = vi.fn()
    renderDialog({
      open: true,
      onOpenChange,
      mode: 'deployment',
      workload: deployment,
      namespace: 'default',
      onSaveWorkload,
    })
    const input = screen.getByRole('textbox', {
      name: 'imageEditor.containerImage',
    })
    act(() => input.focus())
    expect(screen.getByText('imageEditor.noTagsAvailable')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'nginx:discarded' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSaveWorkload).not.toHaveBeenCalled()
    expect(deployment.spec?.template.spec?.containers[0].image).toBe(
      'nginx:1.0',
    )
    expect(invoke).not.toHaveBeenCalled()
  })
})
