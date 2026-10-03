import { useCallback, useContext, useMemo } from 'react'
import {
  QueryClient,
  QueryClientContext,
  useMutation,
  useQuery,
} from '@tanstack/react-query'

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

const fallbackQueryClient = new QueryClient()

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
    customResource: favorite.customResource,
    group: favorite.group,
    version: favorite.version,
    createdAt: favorite.createdAt,
  }
}

function toFavoriteRequest(resource: SearchResult) {
  const request = {
    resourceType: resource.resourceType,
    namespace: resource.namespace,
    resourceName: resource.name,
  }
  return {
    ...request,
    ...(resource.group ? { group: resource.group } : {}),
    ...(resource.version ? { version: resource.version } : {}),
  }
}

export function useFavorites() {
  const providerQueryClient = useContext(QueryClientContext)
  const queryClient = providerQueryClient ?? fallbackQueryClient
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
    enabled: Boolean(providerQueryClient && currentCluster),
  }, queryClient)

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
  const findFavorite = useCallback(
    (
      resource: Pick<
        SearchResult,
        'name' | 'namespace' | 'resourceType' | 'group' | 'version'
      >
    ) => {
      const key = buildFavoriteKeyFromResource(resource)
      const matches = favorites.filter(
        (favorite) => buildFavoriteKeyFromResource(favorite) === key
      )
      if (resource.group && resource.version) {
        return (
          matches.find(
            (favorite) =>
              favorite.group === resource.group &&
              favorite.version === resource.version
          ) ?? matches[0]
        )
      }
      return matches[0]
    },
    [favorites]
  )

  const refreshFavorites = useCallback(async () => {
    if (!providerQueryClient) {
      return
    }
    await queryClient.invalidateQueries({
      queryKey: ['favorites', currentCluster],
    })
  }, [currentCluster, providerQueryClient, queryClient])

  const addMutation = useMutation({
    mutationFn: async (resource: SearchResult) =>
      addFavoriteResource(toFavoriteRequest(resource)),
    onSuccess: async () => {
      await refreshFavorites()
    },
  }, queryClient)

  const removeMutation = useMutation({
    mutationFn: async (resource: SearchResult) =>
      removeFavoriteResource(toFavoriteRequest(resource)),
    onSuccess: async () => {
      await refreshFavorites()
    },
  }, queryClient)

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
      // Resource list/detail views may only know the resource name and type.
      // Reuse the loaded favorite's exact GVR so a multi-version resource (for
      // example autoscaling/v1 and autoscaling/v2 HPAs) removes the same
      // object that was originally saved.
      await removeMutation.mutateAsync(findFavorite(resource) ?? resource)
      trackDesktopEvent('favorite_toggle', {
        action: 'remove',
        resource_type: resource.resourceType,
      })
    },
    [findFavorite, removeMutation]
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
        await removeMutation.mutateAsync(findFavorite(resource) ?? resource)
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
    [addMutation, favoriteKeys, findFavorite, removeMutation]
  )

  return {
    favorites,
    addToFavorites,
    removeFromFavorites,
    isFavorite,
    toggleFavorite,
    refreshFavorites,
    isLoading: favoritesQuery.isLoading,
    isError: favoritesQuery.isError,
    isMutating: addMutation.isPending || removeMutation.isPending,
  }
}
