import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ConfigMap } from 'kubernetes-types/core/v1'
import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfigMapDetail } from './configmap-detail'

const mockUseResource = vi.fn()
const mockUpdateResource = vi.fn()
const mockCopyTextToClipboard = vi.fn()
const mockT = (key: string) => key

const configMap: ConfigMap = {
  metadata: {
    name: 'app-config',
    namespace: 'default',
    uid: 'uid-1',
    resourceVersion: '42',
    creationTimestamp: '2026-05-09T13:52:32.000Z',
    labels: {
      app: 'demo',
    },
    annotations: {
      owner: 'platform',
    },
  },
  data: {
    'app.yaml': 'server:\n  port: 8080',
    LOG_LEVEL: 'info',
  },
}

function renderConfigMapDetail() {
  return render(
    <MemoryRouter>
      <ConfigMapDetail namespace="default" name="app-config" />
    </MemoryRouter>
  )
}

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()

  return {
    ...actual,
    useTranslation: () => ({
      t: mockT,
    }),
  }
})

vi.mock('@/lib/api', () => ({
  useResource: (...args: unknown[]) => mockUseResource(...args),
  updateResource: (...args: unknown[]) => mockUpdateResource(...args),
}))

vi.mock('@/lib/desktop', () => ({
  copyTextToClipboard: (value: string) => mockCopyTextToClipboard(value),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/components/ui/responsive-tabs', () => ({
  ResponsiveTabs: ({
    tabs,
  }: {
    tabs: { value: string; label: React.ReactNode; content: React.ReactNode }[]
  }) => {
    const [activeTab, setActiveTab] = useState(tabs[0]?.value || '')
    const currentTab = tabs.find((tab) => tab.value === activeTab)

    return (
      <div>
        <div>
          {tabs.map((tab) => (
            <button key={tab.value} onClick={() => setActiveTab(tab.value)}>
              {tab.label}
            </button>
          ))}
        </div>
        {currentTab?.content}
      </div>
    )
  },
}))

vi.mock('@/components/refresh-button', () => ({
  RefreshButton: ({ children }: { children: React.ReactNode }) => (
    <button>{children}</button>
  ),
}))

vi.mock('@/components/describe-dialog', () => ({
  DescribeDialog: () => <button>describe</button>,
}))

vi.mock('@/components/yaml-editor', () => ({
  YamlEditor: () => <div>yaml-editor</div>,
}))

vi.mock('@/components/related-resource-table', () => ({
  RelatedResourcesTable: () => <div>related-resources</div>,
}))

vi.mock('@/components/event-table', () => ({
  EventTable: () => <div>events</div>,
}))

vi.mock('@/components/resource-history-table', () => ({
  ResourceHistoryTable: () => <div>history</div>,
}))

vi.mock('@/components/resource-delete-confirmation-dialog', () => ({
  ResourceDeleteConfirmationDialog: () => null,
}))

describe('ConfigMapDetail', () => {
  beforeEach(() => {
    mockUseResource.mockReset()
    mockUpdateResource.mockReset()
    mockCopyTextToClipboard.mockReset()
    mockUpdateResource.mockResolvedValue(undefined)
    mockUseResource.mockReturnValue({
      data: configMap,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    })
  })

  it('shows ConfigMap metadata in the overview and data in its own tab', () => {
    renderConfigMapDetail()

    expect(
      screen.getByText('detail.sections.configMapInformation')
    ).toBeInTheDocument()
    expect(screen.getByText('uid-1')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('app: demo')).toBeInTheDocument()
    expect(screen.getByText('owner: platform')).toBeInTheDocument()
    expect(screen.queryByText('app.yaml')).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: /^detail\.tabs\.data/ })
    )

    expect(screen.getAllByText('app.yaml').length).toBeGreaterThan(0)
    expect(screen.getByText(/server:/)).toBeInTheDocument()
  })

  it('saves ConfigMap data through the form editor', async () => {
    renderConfigMapDetail()

    fireEvent.click(
      screen.getByRole('button', { name: /^detail\.tabs\.data/ })
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'common.edit' })[0])

    const dialog = screen.getByRole('dialog')
    const logLevelInput = within(dialog).getByDisplayValue('LOG_LEVEL')
    fireEvent.change(logLevelInput, { target: { value: 'MODE' } })

    const infoValue = within(dialog).getByDisplayValue('info')
    fireEvent.change(infoValue, { target: { value: 'production' } })

    fireEvent.click(within(dialog).getByRole('button', { name: 'common.save' }))

    expect(mockUpdateResource).not.toHaveBeenCalled()
    expect(
      screen.getByText('configMaps.confirmSaveDataTitle')
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'configMaps.confirmSaveData' })
    )

    expect(mockUpdateResource).toHaveBeenCalledWith(
      'configmaps',
      'app-config',
      'default',
      expect.objectContaining({
        data: {
          'app.yaml': 'server:\n  port: 8080',
          MODE: 'production',
        },
      })
    )
  })
})
