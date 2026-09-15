type FavoriteLike = {
  resourceType: string
  namespace?: string
  name?: string
  resourceName?: string
}

export function getFavoriteResourceName(resource: FavoriteLike): string {
  return resource.resourceName || resource.name || ''
}

export function buildFavoriteResourceKey(
  resourceType: string,
  namespace: string | undefined,
  resourceName: string
): string {
  return [
    resourceType.trim().toLowerCase(),
    (namespace || '').trim(),
    resourceName.trim(),
  ].join('::')
}

export function buildFavoriteKeyFromResource(resource: FavoriteLike): string {
  return buildFavoriteResourceKey(
    resource.resourceType,
    resource.namespace,
    getFavoriteResourceName(resource)
  )
}
