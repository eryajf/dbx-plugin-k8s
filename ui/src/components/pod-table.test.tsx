import '@/i18n'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import type { PodWithMetrics } from '@/types/api'
import { PodTable } from './pod-table'

vi.mock('./describe-dialog', () => ({ DescribeDialog: () => null }))
vi.mock('./open-pod-terminal-button', () => ({ OpenPodTerminalButton: () => null }))

describe('PodTable', () => {
  it('preserves the image tooltip and table scroll element when pod data refreshes', async () => {
    const pod = {
      metadata: { uid: 'pod-1', name: 'demo', namespace: 'default', creationTimestamp: '2026-01-01T00:00:00Z' },
      spec: { containers: [{ name: 'app', image: 'registry.example/app:v1' }] },
      status: { phase: 'Running' },
    } as PodWithMetrics
    const view = render(<MemoryRouter><PodTable pods={[pod]} /></MemoryRouter>)
    const image = screen.getByTitle('app: app:v1')
    const scrollContainer = view.container.querySelector('[data-slot="table-container"]') as HTMLElement
    scrollContainer.scrollLeft = 150
    fireEvent.pointerMove(image, { pointerType: 'mouse' })
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeTruthy())

    view.rerender(<MemoryRouter><PodTable pods={[{ ...pod, status: { ...pod.status, podIP: '10.0.0.1' } }]} /></MemoryRouter>)

    expect(screen.getByTitle('app: app:v1')).toBe(image)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    expect(view.container.querySelector('[data-slot="table-container"]')).toBe(scrollContainer)
    expect(scrollContainer.scrollLeft).toBe(150)
    expect(screen.getByText('10.0.0.1')).toBeTruthy()
  })
})
