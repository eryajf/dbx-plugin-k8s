import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FavoriteResource, SearchResult } from '@/lib/api'

import { useFavorites } from './use-favorites'

const favoritesStore: FavoriteResource[] = []

const apiMocks = vi.hoisted(() => ({
  addFavoriteResource: vi.fn(),
  listFavoriteResources: vi.fn(),
  removeFavoriteResource: vi.fn(),
}))
const { trackDesktopEvent } = vi.hoisted(() => ({
  trackDesktopEvent: vi.fn(),
}))
let currentClusterMock = 'cluster-a'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')

  return {
    ...actual,
    addFavoriteResource: apiMocks.addFavoriteResource,
    listFavoriteResources: apiMocks.listFavoriteResources,
    removeFavoriteResource: apiMocks.removeFavoriteResource,
  }
})

vi.mock('@/hooks/use-cluster', () => ({
  useCluster: () => ({
    currentCluster: currentClusterMock,
  }),
}))

vi.mock('@/lib/analytics', () => ({
  trackDesktopEvent,
}))

const favorite: SearchResult = {
  id: 'resource-1',
  name: 'my-pod',
  resourceType: 'pods',
  namespace: 'default',
  createdAt: '2026-03-27T00:00:00.000Z',
}

function createQueryWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })

  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('useFavorites', () => {
  beforeEach(() => {
    favoritesStore.length = 0
    currentClusterMock = 'cluster-a'
    vi.restoreAllMocks()
    trackDesktopEvent.mockReset()

    apiMocks.listFavoriteResources.mockImplementation(async () => [
      ...favoritesStore,
    ])
    apiMocks.addFavoriteResource.mockImplementation(
      async (data: {
        resourceType: string
        namespace?: string
        resourceName: string
      }) => {
        const existing = favoritesStore.find(
          (favorite) =>
            favorite.resourceType === data.resourceType &&
            favorite.namespace === data.namespace &&
            favorite.resourceName === data.resourceName
        )
        if (existing) {
          return existing
        }

        const created: FavoriteResource = {
          id: favoritesStore.length + 1,
          clusterName: 'cluster-a',
          resourceType: data.resourceType,
          namespace: data.namespace,
          resourceName: data.resourceName,
          createdAt: '2026-03-27T00:00:00.000Z',
          updatedAt: '2026-03-27T00:00:00.000Z',
        }
        favoritesStore.push(created)
        return created
      }
    )
    apiMocks.removeFavoriteResource.mockImplementation(
      async (data: {
        resourceType: string
        namespace?: string
        resourceName: string
      }) => {
        const index = favoritesStore.findIndex(
          (favorite) =>
            favorite.resourceType === data.resourceType &&
            favorite.namespace === data.namespace &&
            favorite.resourceName === data.resourceName
        )
        if (index >= 0) {
          favoritesStore.splice(index, 1)
        }
      }
    )
  })

  it('adds and removes favorites while keeping state in sync with the backend', async () => {
    const { result } = renderHook(() => useFavorites(), {
      wrapper: createQueryWrapper(),
    })

    await waitFor(() => expect(result.current.favorites).toEqual([]))

    await act(async () => {
      await result.current.addToFavorites(favorite)
    })

    await waitFor(() => expect(result.current.favorites).toHaveLength(1))
    expect(result.current.favorites[0].name).toBe(favorite.name)
    expect(result.current.isFavorite(favorite)).toBe(true)

    await act(async () => {
      await result.current.removeFromFavorites(favorite)
    })

    await waitFor(() => expect(result.current.favorites).toEqual([]))
    expect(result.current.isFavorite(favorite)).toBe(false)
  })

  it('returns the new favorite state when toggling a resource', async () => {
    const { result } = renderHook(() => useFavorites(), {
      wrapper: createQueryWrapper(),
    })

    await waitFor(() => expect(result.current.favorites).toEqual([]))

    let nextState = false
    await act(async () => {
      nextState = await result.current.toggleFavorite(favorite)
    })

    expect(nextState).toBe(true)
    expect(trackDesktopEvent).toHaveBeenCalledWith('favorite_toggle', {
      action: 'add',
      resource_type: 'pods',
    })
    await waitFor(() => expect(result.current.favorites).toHaveLength(1))

    await act(async () => {
      nextState = await result.current.toggleFavorite(favorite)
    })

    expect(nextState).toBe(false)
    expect(trackDesktopEvent).toHaveBeenLastCalledWith('favorite_toggle', {
      action: 'remove',
      resource_type: 'pods',
    })
    await waitFor(() => expect(result.current.favorites).toEqual([]))
  })
})
