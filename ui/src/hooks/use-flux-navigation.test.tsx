import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useFluxNavigation } from './use-flux-navigation'

const state = vi.hoisted(() => ({ cluster: 'a' as string | null }))
const listDBXResources = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/use-cluster', () => ({
  useCluster: () => ({ currentCluster: state.cluster }),
}))
vi.mock('@/lib/dbx-transport', () => ({
  getDBXTransport: (id: string) => ({ invoke: vi.fn(), id }),
}))
vi.mock('@/lib/dbx-resource-discovery', () => ({ listDBXResources }))

const git = {
  group: 'source.toolkit.fluxcd.io',
  kind: 'GitRepository',
  resource: 'gitrepositories',
  version: 'v1',
  namespaced: true,
  verbs: ['list'],
}

function wrapper() {
  const client = new QueryClient()
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

describe('useFluxNavigation', () => {
  beforeEach(() => {
    state.cluster = 'a'
    listDBXResources.mockReset()
    localStorage.clear()
  })

  it('exposes Flux items when discovery lists Flux CRDs', async () => {
    listDBXResources.mockResolvedValue([git])
    const { result } = renderHook(() => useFluxNavigation(), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    expect(result.current.items[0].kind).toBe('GitRepository')
  })

  it('is empty when Flux is not installed', async () => {
    listDBXResources.mockResolvedValue([{ ...git, group: '', kind: 'Pod', resource: 'pods' }])
    const { result } = renderHook(() => useFluxNavigation(), { wrapper: wrapper() })
    await waitFor(() => expect(listDBXResources).toHaveBeenCalled())
    expect(result.current.items).toEqual([])
  })

  it('hides Flux silently on RBAC / discovery errors', async () => {
    listDBXResources.mockRejectedValue(new Error('forbidden'))
    const { result } = renderHook(() => useFluxNavigation(), { wrapper: wrapper() })
    await waitFor(() => expect(listDBXResources).toHaveBeenCalled())
    expect(result.current.items).toEqual([])
  })

  it('does not call discovery without a connection', () => {
    state.cluster = null
    const { result } = renderHook(() => useFluxNavigation(), { wrapper: wrapper() })
    expect(listDBXResources).not.toHaveBeenCalled()
    expect(result.current.items).toEqual([])
  })

  it('never shows another cluster\'s items after a connection change', async () => {
    listDBXResources.mockImplementation(async (id: string) =>
      id === 'a' ? [git] : new Promise(() => {})
    )
    const { result, rerender } = renderHook(() => useFluxNavigation(), {
      wrapper: wrapper(),
    })
    await waitFor(() => expect(result.current.items).toHaveLength(1))
    state.cluster = 'b'
    rerender()
    expect(result.current.items).toEqual([])
  })

  it('stores collapse state per connection', async () => {
    listDBXResources.mockResolvedValue([git])
    const { result, rerender } = renderHook(() => useFluxNavigation(), {
      wrapper: wrapper(),
    })
    result.current.toggleCollapsed()
    await waitFor(() => expect(result.current.collapsed).toBe(true))
    expect(localStorage.getItem('dbx:kite:a:flux-nav-collapsed')).toBe('1')
    state.cluster = 'b'
    rerender()
    expect(result.current.collapsed).toBe(false)
  })
})
