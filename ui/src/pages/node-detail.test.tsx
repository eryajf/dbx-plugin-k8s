import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Node } from 'kubernetes-types/core/v1'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { NodeDetail } from './node-detail'

const mockUseResource = vi.fn()
const mockUseResources = vi.fn()
const mockOpenSession = vi.fn()
const mockUseFeature = vi.fn()

const node: Node = {
  metadata: {
    name: 'worker-1',
    uid: 'node-uid',
    creationTimestamp: '2026-01-01T00:00:00.000Z',
  },
  spec: {},
  status: {
    conditions: [{ type: 'Ready', status: 'True' }],
    addresses: [{ type: 'InternalIP', address: '10.0.0.10' }],
  },
}

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/lib/api', () => ({
  cordonNode: vi.fn(),
  drainNode: vi.fn(),
  taintNode: vi.fn(),
  uncordonNode: vi.fn(),
  untaintNode: vi.fn(),
  updateResource: vi.fn(),
  useResource: (...args: unknown[]) => mockUseResource(...args),
  useResources: (...args: unknown[]) => mockUseResources(...args),
}))

vi.mock('@/lib/analytics', () => ({
  trackResourceAction: vi.fn(),
}))

vi.mock('@/contexts/terminal-context', () => ({
  useTerminal: () => ({
    openSession: mockOpenSession,
  }),
}))

vi.mock('@/hooks/use-license', () => ({
  useFeature: (feature: string) => mockUseFeature(feature),
}))

vi.mock('@/components/refresh-button', () => ({
  RefreshButton: ({ children }: { children: React.ReactNode }) => (
    <button>{children}</button>
  ),
}))

vi.mock('@/components/describe-dialog', () => ({
  DescribeDialog: () => <button>describe</button>,
}))

vi.mock('@/components/error-message', () => ({
  ErrorMessage: () => <div>error</div>,
}))

vi.mock('@/components/event-table', () => ({
  EventTable: () => <div>events</div>,
}))

vi.mock('@/components/lables-anno', () => ({
  LabelsAnno: () => <div>labels</div>,
}))

vi.mock('@/components/metrics-cell', () => ({
  MetricCell: () => <div>metric</div>,
}))

vi.mock('@/components/node-drain-option-row', () => ({
  NodeDrainOptionRow: () => <div>drain-option</div>,
}))

vi.mock('@/components/node-image-table', () => ({
  NodeImageTable: () => <div>images</div>,
}))

vi.mock('@/components/node-monitoring', () => ({
  NodeMonitoring: () => <div>monitoring</div>,
}))

vi.mock('@/components/pod-table', () => ({
  PodTable: () => <div>pods</div>,
}))

vi.mock('@/components/resource-favorite-button', () => ({
  ResourceFavoriteButton: () => <button>favorite</button>,
}))

vi.mock('@/components/yaml-editor', () => ({
  YamlEditor: () => <div>yaml-editor</div>,
}))

vi.mock('@/components/ui/responsive-tabs', () => ({
  ResponsiveTabs: ({
    tabs,
  }: {
    tabs: { content: React.ReactNode }[]
  }) => <div>{tabs[0]?.content}</div>,
}))

describe('NodeDetail terminal action', () => {
  beforeEach(() => {
    mockUseResource.mockReset()
    mockUseResources.mockReset()
    mockOpenSession.mockReset()
    mockUseFeature.mockReset()

    mockUseResource.mockReturnValue({
      data: node,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    })
    mockUseResources.mockReturnValue({
      data: [],
      isLoading: false,
      refetch: vi.fn(),
    })
    mockUseFeature.mockReturnValue(true)
  })

  it('opens the current node terminal from the detail header', async () => {
    const user = userEvent.setup()

    render(<NodeDetail name="worker-1" />)

    const button = screen.getByRole('button', { name: 'Open terminal' })
    expect(button).not.toBeDisabled()

    await user.click(button)

    expect(mockUseFeature).toHaveBeenCalledWith('terminal.node')
    expect(mockOpenSession).toHaveBeenCalledWith({
      type: 'node',
      nodeName: 'worker-1',
      title: 'worker-1',
      source: 'node/worker-1',
      entry: 'resource-action',
    })
  })

  it('disables the terminal action when the feature is unavailable', async () => {
    const user = userEvent.setup()
    mockUseFeature.mockReturnValue(false)

    render(<NodeDetail name="worker-1" />)

    const button = screen.getByRole('button', { name: 'Open terminal' })
    expect(button).toBeDisabled()

    await user.click(button)

    expect(mockOpenSession).not.toHaveBeenCalled()
  })
})
