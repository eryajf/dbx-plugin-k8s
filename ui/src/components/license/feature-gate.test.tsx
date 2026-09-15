import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { FeatureGate } from './feature-gate'

const mockUseFeature = vi.fn()

vi.mock('@/hooks/use-license', () => ({
  useFeature: (feature: string) => mockUseFeature(feature),
}))

describe('FeatureGate', () => {
  it('renders a safe fallback when capability information is unavailable', () => {
    mockUseFeature.mockReturnValue(undefined)
    render(<FeatureGate feature="ai.agent" fallback={<div>Upgrade prompt</div>}><div>Secret content</div></FeatureGate>)
    expect(screen.getByText('Upgrade prompt')).toBeInTheDocument()
    expect(screen.queryByText('Secret content')).not.toBeInTheDocument()
  })
  it('renders children when the feature is enabled', () => {
    mockUseFeature.mockReturnValue(true)

    render(
      <FeatureGate feature="ai.agent">
        <div>Enabled content</div>
      </FeatureGate>
    )

    expect(screen.getByText('Enabled content')).toBeInTheDocument()
  })

  it('renders fallback when the feature is disabled', () => {
    mockUseFeature.mockReturnValue(false)

    render(
      <FeatureGate feature="ai.agent" fallback={<div>Upgrade prompt</div>}>
        <div>Enabled content</div>
      </FeatureGate>
    )

    expect(screen.getByText('Upgrade prompt')).toBeInTheDocument()
    expect(screen.queryByText('Enabled content')).not.toBeInTheDocument()
  })
})
