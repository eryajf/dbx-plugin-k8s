import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import type { OverviewData } from '@/types/api'
import { ClusterStatsCards } from './cluster-stats-cards'

const stats: OverviewData = {
  totalNodes: 1, readyNodes: 1, totalPods: 2, runningPods: 2,
  totalNamespaces: 1, totalServices: 1, prometheusEnabled: false,
  resource: {
    cpu: { allocatable: 1000, requested: 100, limited: 500 },
    memory: { allocatable: 1024, requested: 128, limited: 512 },
  },
}

describe('localized cluster statistics', () => {
  it('loads real statistics after the skeleton and responds to language changes', async () => {
    await i18n.changeLanguage('en')
    const { rerender } = render(<MemoryRouter><ClusterStatsCards isLoading /></MemoryRouter>)
    rerender(<MemoryRouter><ClusterStatsCards stats={stats} /></MemoryRouter>)
    expect(screen.getAllByText('All ready').length).toBeGreaterThan(0)
    await act(async () => { await i18n.changeLanguage('zh-TW') })
    expect(screen.getAllByText('全部就緒').length).toBeGreaterThan(0)
    expect(screen.queryByText('All ready')).not.toBeInTheDocument()
    rerender(<MemoryRouter><ClusterStatsCards stats={{ ...stats, readyNodes: 0 }} /></MemoryRouter>)
    expect(screen.getByText(new RegExp(i18n.t('containerInfo.notReady')))).toBeInTheDocument()
  })
})
