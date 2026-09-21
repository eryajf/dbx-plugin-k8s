import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MonitoringChartFullscreen } from './monitoring-chart-fullscreen'

describe('MonitoringChartFullscreen', () => {
  it('uses a near-fullscreen dialog for an expanded chart', () => {
    render(
      <MonitoringChartFullscreen
        open
        onOpenChange={vi.fn()}
        title="CPU Usage"
      >
        <div>expanded chart</div>
      </MonitoringChartFullscreen>
    )

    expect(screen.getByRole('dialog')).toHaveClass('h-[calc(100dvh-1rem)]')
    expect(screen.getByRole('heading', { name: 'CPU Usage' })).toBeVisible()
    expect(screen.getByText('expanded chart')).toBeVisible()
  })
})
