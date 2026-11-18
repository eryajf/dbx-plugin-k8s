import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { ResourceCharts } from './resources-charts'

const GiB = 1024 ** 3

describe('resource charts memory units', () => {
  it('renders byte quantities as GiB, not TiB', async () => {
    await i18n.changeLanguage('en')
    render(
      <ResourceCharts
        data={{
          cpu: { allocatable: 48000, requested: 22300, limited: 52400 },
          memory: {
            allocatable: 92 * GiB,
            requested: 43 * GiB,
            limited: 101 * GiB,
          },
        }}
        isLoading={false}
        error={null}
        isError={false}
      />
    )
    expect(screen.getByText(/Total: 92\.00 GiB/)).toBeInTheDocument()
    expect(screen.getByText('43.0 GiB')).toBeInTheDocument()
    expect(screen.getByText('101.0 GiB')).toBeInTheDocument()
    expect(screen.getByText('Available: 49.0 GiB')).toBeInTheDocument()
  })
})