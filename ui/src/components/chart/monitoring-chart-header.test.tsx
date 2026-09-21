import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { MonitoringChartHeader } from './monitoring-chart-header'

describe('MonitoringChartHeader', () => {
  it('renders an accessible expand action when a chart can be enlarged', async () => {
    const onExpand = vi.fn()
    const user = userEvent.setup()

    render(
      <MonitoringChartHeader
        title="CPU Usage"
        description="CPU usage description"
        query="vector(1)"
        onExpand={onExpand}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Expand chart' }))

    expect(onExpand).toHaveBeenCalledOnce()
  })
})
