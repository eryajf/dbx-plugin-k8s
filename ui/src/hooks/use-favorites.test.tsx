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
        group?: string
        version?: string
        namespace?: string
        resourceName: string
      }) => {
        const existing = favoritesStore.find(
          (favorite) =>
            favorite.resourceType === data.resourceType &&
            favorite.group === data.group &&
            favorite.version === data.version &&
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
          group: data.group,
          version: data.version,
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
        group?: string
        version?: string
        namespace?: string
        resourceName: string
      }) => {
        const index = favoritesStore.findIndex(
          (favorite) =>
            favorite.resourceType === data.resourceType &&
            favorite.group === data.group &&
            favorite.version === data.version &&
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

  it('keeps custom resource identity across reload and removal', async () => {
    const customFavorite: SearchResult = {
      id: 'custom-1',
      name: 'widget-one',
      namespace: 'default',
      resourceType: 'widgets.example.com',
      customResource: true,
      group: 'example.com',
      version: 'v1',
      createdAt: '2026-03-27T00:00:00.000Z',
    }
    favoritesStore.push({
      id: 1,
      clusterName: 'cluster-a',
      resourceType: customFavorite.resourceType,
      customResource: true,
      group: customFavorite.group,
      version: customFavorite.version,
      namespace: customFavorite.namespace,
      resourceName: customFavorite.name,
      createdAt: customFavorite.createdAt,
      updatedAt: customFavorite.createdAt,
    })

    const { result } = renderHook(() => useFavorites(), {
      wrapper: createQueryWrapper(),
    })

    await waitFor(() => expect(result.current.isFavorite(customFavorite)).toBe(true))

    await act(async () => {
      await result.current.removeFromFavorites(customFavorite)
    })

    expect(apiMocks.removeFavoriteResource).toHaveBeenCalledWith({
      resourceType: 'widgets.example.com',
      group: 'example.com',
      version: 'v1',
      namespace: 'default',
      resourceName: 'widget-one',
    })
    await waitFor(() => expect(result.current.isFavorite(customFavorite)).toBe(false))
  })

  it('removes the stored version when a list or detail view omits GVR fields', async () => {
    favoritesStore.push({
      id: 1,
      clusterName: 'cluster-a',
      resourceType: 'horizontalpodautoscalers',
      group: 'autoscaling',
      version: 'v2',
      namespace: 'default',
      resourceName: 'my-hpa',
      createdAt: '2026-03-27T00:00:00.000Z',
      updatedAt: '2026-03-27T00:00:00.000Z',
    })
    const resourceFromListPage: SearchResult = {
      id: 'hpa-1',
      name: 'my-hpa',
      namespace: 'default',
      resourceType: 'horizontalpodautoscalers',
      createdAt: '',
    }

    const { result } = renderHook(() => useFavorites(), {
      wrapper: createQueryWrapper(),
    })

    await waitFor(() => expect(result.current.isFavorite(resourceFromListPage)).toBe(true))

    await act(async () => {
      await result.current.toggleFavorite(resourceFromListPage)
    })

    expect(apiMocks.removeFavoriteResource).toHaveBeenCalledWith({
      resourceType: 'horizontalpodautoscalers',
      group: 'autoscaling',
      version: 'v2',
      namespace: 'default',
      resourceName: 'my-hpa',
    })
    await waitFor(() => expect(result.current.favorites).toEqual([]))
  })

  it('prefers the requested GVR when multiple versions share a favorite key', async () => {
    favoritesStore.push(
      {
        id: 1,
        clusterName: 'cluster-a',
        resourceType: 'horizontalpodautoscalers',
        group: 'autoscaling',
        version: 'v1',
        namespace: 'default',
        resourceName: 'my-hpa',
        createdAt: '2026-03-27T00:00:00.000Z',
        updatedAt: '2026-03-27T00:00:00.000Z',
      },
      {
        id: 2,
        clusterName: 'cluster-a',
        resourceType: 'horizontalpodautoscalers',
        group: 'autoscaling',
        version: 'v2',
        namespace: 'default',
        resourceName: 'my-hpa',
        createdAt: '2026-03-27T00:00:00.000Z',
        updatedAt: '2026-03-27T00:00:00.000Z',
      }
    )
    const resourceFromSearch: SearchResult = {
      id: 'hpa-v2',
      name: 'my-hpa',
      namespace: 'default',
      resourceType: 'horizontalpodautoscalers',
      group: 'autoscaling',
      version: 'v2',
      createdAt: '',
    }

    const { result } = renderHook(() => useFavorites(), {
      wrapper: createQueryWrapper(),
    })

    await waitFor(() => expect(result.current.isFavorite(resourceFromSearch)).toBe(true))

    await act(async () => {
      await result.current.removeFromFavorites(resourceFromSearch)
    })

    expect(apiMocks.removeFavoriteResource).toHaveBeenCalledWith({
      resourceType: 'horizontalpodautoscalers',
      group: 'autoscaling',
      version: 'v2',
      namespace: 'default',
      resourceName: 'my-hpa',
    })
    expect(favoritesStore).toHaveLength(1)
    expect(favoritesStore[0].version).toBe('v1')
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

  it('exposes mutation progress while a favorite request is pending', async () => {
    let resolveAdd!: (value: FavoriteResource) => void
    apiMocks.addFavoriteResource.mockImplementationOnce(
      () =>
        new Promise<FavoriteResource>((resolve) => {
          resolveAdd = resolve
        })
    )

    const { result } = renderHook(() => useFavorites(), {
      wrapper: createQueryWrapper(),
    })

    await waitFor(() => expect(result.current.favorites).toEqual([]))

    let mutationPromise!: Promise<void>
    await act(async () => {
      mutationPromise = result.current.addToFavorites(favorite).then(() => undefined)
    })

    await waitFor(() => expect(result.current.isMutating).toBe(true))

    resolveAdd({
      id: 1,
      clusterName: 'cluster-a',
      resourceType: favorite.resourceType,
      namespace: favorite.namespace,
      resourceName: favorite.name,
      createdAt: favorite.createdAt,
      updatedAt: favorite.createdAt,
    })
    await act(async () => {
      await mutationPromise
    })

    await waitFor(() => expect(result.current.isMutating).toBe(false))
  })

  it('reports when the favorite list cannot be loaded', async () => {
    apiMocks.listFavoriteResources.mockRejectedValueOnce(
      new Error('favorites unavailable')
    )

    const { result } = renderHook(() => useFavorites(), {
      wrapper: createQueryWrapper(),
    })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isFavorite(favorite)).toBe(false)
  })
})
