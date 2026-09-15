import { useCallback, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { trackDesktopEvent } from '@/lib/analytics'
import {
  addFavoriteResource,
  FavoriteResource,
  listFavoriteResources,
  removeFavoriteResource,
  SearchResult,
} from '@/lib/api'
import { buildFavoriteKeyFromResource } from '@/lib/favorites'
import { useCluster } from '@/hooks/use-cluster'

function favoriteToSearchResult(favorite: FavoriteResource): SearchResult {
  return {
    id: buildFavoriteKeyFromResource({
      resourceType: favorite.resourceType,
      namespace: favorite.namespace,
      resourceName: favorite.resourceName,
    }),
    name: favorite.resourceName,
    namespace: favorite.namespace,
    resourceType: favorite.resourceType,
    createdAt: favorite.createdAt,
  }
}

function toFavoriteRequest(resource: SearchResult) {
  return {
    resourceType: resource.resourceType,
    namespace: resource.namespace,
    resourceName: resource.name,
  }
}

export function useFavorites() {
  const queryClient = useQueryClient()
  const { currentCluster } = useCluster()
  const queryKey = ['favorites', currentCluster] as const

  const favoritesQuery = useQuery({
    queryKey,
    queryFn: async () => {
      if (!currentCluster) {
        return [] as FavoriteResource[]
      }
      return listFavoriteResources()
    },
    enabled: !!currentCluster,
  })

  const favorites = useMemo(
    () => (favoritesQuery.data || []).map(favoriteToSearchResult),
    [favoritesQuery.data]
  )
  const favoriteKeys = useMemo(
    () =>
      new Set(
        favorites.map((favorite) => buildFavoriteKeyFromResource(favorite))
      ),
    [favorites]
  )

  const refreshFavorites = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: ['favorites', currentCluster],
    })
  }, [queryClient, currentCluster])

  const addMutation = useMutation({
    mutationFn: async (resource: SearchResult) =>
      addFavoriteResource(toFavoriteRequest(resource)),
    onSuccess: async () => {
      await refreshFavorites()
    },
  })

  const removeMutation = useMutation({
    mutationFn: async (resource: SearchResult) =>
      removeFavoriteResource(toFavoriteRequest(resource)),
    onSuccess: async () => {
      await refreshFavorites()
    },
  })

  const addToFavorites = useCallback(
    async (resource: SearchResult) => {
      await addMutation.mutateAsync(resource)
      trackDesktopEvent('favorite_toggle', {
        action: 'add',
        resource_type: resource.resourceType,
      })
    },
    [addMutation]
  )

  const removeFromFavorites = useCallback(
    async (resource: SearchResult) => {
      await removeMutation.mutateAsync(resource)
      trackDesktopEvent('favorite_toggle', {
        action: 'remove',
        resource_type: resource.resourceType,
      })
    },
    [removeMutation]
  )

  const isFavorite = useCallback(
    (resource: Pick<SearchResult, 'name' | 'namespace' | 'resourceType'>) => {
      return favoriteKeys.has(buildFavoriteKeyFromResource(resource))
    },
    [favoriteKeys]
  )

  const toggleFavorite = useCallback(
    async (resource: SearchResult) => {
      if (favoriteKeys.has(buildFavoriteKeyFromResource(resource))) {
        await removeMutation.mutateAsync(resource)
        trackDesktopEvent('favorite_toggle', {
          action: 'remove',
          resource_type: resource.resourceType,
        })
        return false
      }

      await addMutation.mutateAsync(resource)
      trackDesktopEvent('favorite_toggle', {
        action: 'add',
        resource_type: resource.resourceType,
      })
      return true
    },
    [addMutation, favoriteKeys, removeMutation]
  )

  return {
    favorites,
    addToFavorites,
    removeFromFavorites,
    isFavorite,
    toggleFavorite,
    refreshFavorites,
    isLoading: favoritesQuery.isLoading,
  }
}
