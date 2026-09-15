import { useEffect, useMemo, useState, type ComponentType } from 'react'
import {
  IconBell,
  IconBox,
  IconBoxMultiple,
  IconClockHour4,
  IconCode,
  IconDatabase,
  IconFileDatabase,
  IconKey,
  IconLoader,
  IconLock,
  IconMap,
  IconNetwork,
  IconPlayerPlay,
  IconRocket,
  IconRoute,
  IconRouter,
  IconSearch,
  IconServer2,
  IconShield,
  IconShieldCheck,
  IconStack2,
  IconStar,
  IconStarFilled,
  IconTopologyBus,
  IconUser,
  IconUsers,
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import type { SearchResult } from '@/lib/api'
import { useCluster } from '@/hooks/use-cluster'
import { useFavorites } from '@/hooks/use-favorites'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useGlobalSearch } from '@/components/global-search-provider'
import { NoClusterState } from '@/components/no-cluster-state'
import { RefreshButton } from '@/components/refresh-button'

const RESOURCE_CONFIG: Record<
  string,
  {
    label: string
    icon: ComponentType<{ className?: string }>
  }
> = {
  pods: { label: 'nav.pods', icon: IconBox },
  deployments: { label: 'nav.deployments', icon: IconRocket },
  statefulsets: { label: 'nav.statefulsets', icon: IconStack2 },
  daemonsets: { label: 'nav.daemonsets', icon: IconTopologyBus },
  jobs: { label: 'nav.jobs', icon: IconPlayerPlay },
  cronjobs: { label: 'nav.cronjobs', icon: IconClockHour4 },
  services: { label: 'nav.services', icon: IconNetwork },
  configmaps: { label: 'nav.configMaps', icon: IconMap },
  secrets: { label: 'nav.secrets', icon: IconLock },
  namespaces: { label: 'nav.namespaces', icon: IconBoxMultiple },
  nodes: { label: 'nav.nodes', icon: IconServer2 },
  ingresses: { label: 'nav.ingresses', icon: IconRouter },
  networkpolicies: { label: 'nav.networkpolicies', icon: IconShield },
  gateways: { label: 'nav.gateways', icon: IconRoute },
  httproutes: { label: 'nav.httproutes', icon: IconRoute },
  events: { label: 'nav.events', icon: IconBell },
  persistentvolumes: {
    label: 'nav.persistentvolumes',
    icon: IconDatabase,
  },
  persistentvolumeclaims: {
    label: 'nav.persistentvolumeclaims',
    icon: IconFileDatabase,
  },
  storageclasses: {
    label: 'nav.storageclasses',
    icon: IconFileDatabase,
  },
  serviceaccounts: {
    label: 'nav.serviceaccounts',
    icon: IconUser,
  },
  roles: { label: 'nav.roles', icon: IconShield },
  rolebindings: { label: 'nav.rolebindings', icon: IconUsers },
  clusterroles: {
    label: 'nav.clusterroles',
    icon: IconShieldCheck,
  },
  clusterrolebindings: {
    label: 'nav.clusterrolebindings',
    icon: IconKey,
  },
  crds: { label: 'nav.crds', icon: IconCode },
}

function getFavoritePath(favorite: SearchResult) {
  if (favorite.namespace) {
    return `/${favorite.resourceType}/${favorite.namespace}/${favorite.name}`
  }

  return `/${favorite.resourceType}/${favorite.name}`
}

function getResourcePresentation(resourceType: string) {
  return (
    RESOURCE_CONFIG[resourceType] || {
      label: resourceType,
      icon: IconBox,
    }
  )
}

export function FavoritesPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { currentCluster } = useCluster()
  const { openSearch } = useGlobalSearch()
  const { favorites, isLoading, refreshFavorites, removeFromFavorites } =
    useFavorites()
  const [searchQuery, setSearchQuery] = useState('')
  const [resourceTypeFilter, setResourceTypeFilter] = useState('all')
  const [namespaceFilter, setNamespaceFilter] = useState('all')
  const [pendingRemovalIds, setPendingRemovalIds] = useState<Set<string>>(
    () => new Set()
  )

  useEffect(() => {
    setResourceTypeFilter('all')
    setNamespaceFilter('all')
    setSearchQuery('')
  }, [currentCluster])

  useEffect(() => {
    setPendingRemovalIds((previous) => {
      const remaining = new Set(
        [...previous].filter((id) =>
          favorites.some((favorite) => favorite.id === id)
        )
      )

      if (remaining.size === previous.size) {
        return previous
      }

      return remaining
    })
  }, [favorites])

  const sortedFavorites = useMemo(
    () =>
      [...favorites]
        .filter((favorite) => !pendingRemovalIds.has(favorite.id))
        .sort((left, right) => {
          return (
            new Date(right.createdAt).getTime() -
              new Date(left.createdAt).getTime() ||
            left.name.localeCompare(right.name)
          )
        }),
    [favorites, pendingRemovalIds]
  )

  const resourceTypeOptions = useMemo(() => {
    return Array.from(
      new Set(sortedFavorites.map((favorite) => favorite.resourceType))
    ).sort((left, right) => {
      const leftLabel = t(getResourcePresentation(left).label)
      const rightLabel = t(getResourcePresentation(right).label)
      return leftLabel.localeCompare(rightLabel)
    })
  }, [sortedFavorites, t])

  const namespaceOptions = useMemo(() => {
    return Array.from(
      new Set(
        sortedFavorites
          .map((favorite) => favorite.namespace)
          .filter((namespace): namespace is string => Boolean(namespace))
      )
    ).sort((left, right) => left.localeCompare(right))
  }, [sortedFavorites])

  const filteredFavorites = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase()

    return sortedFavorites.filter((favorite) => {
      const typeLabel = t(
        getResourcePresentation(favorite.resourceType).label
      ).toLowerCase()
      const matchesQuery =
        normalizedQuery.length === 0 ||
        favorite.name.toLowerCase().includes(normalizedQuery) ||
        favorite.resourceType.toLowerCase().includes(normalizedQuery) ||
        typeLabel.includes(normalizedQuery) ||
        (favorite.namespace || '').toLowerCase().includes(normalizedQuery)

      const matchesType =
        resourceTypeFilter === 'all' ||
        favorite.resourceType === resourceTypeFilter

      const matchesNamespace =
        namespaceFilter === 'all' || favorite.namespace === namespaceFilter

      return matchesQuery && matchesType && matchesNamespace
    })
  }, [namespaceFilter, resourceTypeFilter, searchQuery, sortedFavorites, t])

  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    resourceTypeFilter !== 'all' ||
    namespaceFilter !== 'all'

  const handleRemoveFavorite = async (favorite: SearchResult) => {
    setPendingRemovalIds((previous) => new Set(previous).add(favorite.id))

    try {
      await removeFromFavorites(favorite)
    } catch (error) {
      console.error('Failed to remove favorite:', error)
      setPendingRemovalIds((previous) => {
        const next = new Set(previous)
        next.delete(favorite.id)
        return next
      })
    }
  }

  const clearFilters = () => {
    setSearchQuery('')
    setResourceTypeFilter('all')
    setNamespaceFilter('all')
  }

  if (!currentCluster) {
    return <NoClusterState />
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">{t('favorites.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('favorites.currentCluster', { name: currentCluster })}
          </p>
        </div>
        <RefreshButton
          variant="outline"
          onClick={() => void refreshFavorites()}
          disabled={isLoading}
        >
          {t('common.refresh')}
        </RefreshButton>
      </div>

      <div className="rounded-xl border bg-card/70 p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t('favorites.searchPlaceholder')}
              aria-label={t('favorites.searchAriaLabel')}
              className="pl-9"
            />
          </div>
          <Select
            value={resourceTypeFilter}
            onValueChange={setResourceTypeFilter}
          >
            <SelectTrigger
              aria-label={t('favorites.typeFilterAriaLabel')}
              className="w-full lg:w-[220px]"
            >
              <SelectValue placeholder={t('favorites.allTypes')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('favorites.allTypes')}</SelectItem>
              {resourceTypeOptions.map((resourceType) => (
                <SelectItem key={resourceType} value={resourceType}>
                  {t(getResourcePresentation(resourceType).label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={namespaceFilter} onValueChange={setNamespaceFilter}>
            <SelectTrigger
              aria-label={t('favorites.namespaceFilterAriaLabel')}
              className="w-full lg:w-[220px]"
            >
              <SelectValue placeholder={t('favorites.allNamespaces')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t('favorites.allNamespaces')}
              </SelectItem>
              {namespaceOptions.map((namespace) => (
                <SelectItem key={namespace} value={namespace}>
                  {namespace}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="border-b bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          {t('favorites.count', {
            count: filteredFavorites.length,
            total: sortedFavorites.length,
          })}
        </div>

        {isLoading && sortedFavorites.length === 0 ? (
          <div className="flex items-center justify-center gap-2 px-4 py-12 text-sm text-muted-foreground">
            <IconLoader className="h-4 w-4 animate-spin" />
            {t('common.loading')}
          </div>
        ) : sortedFavorites.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
            <div className="rounded-full bg-muted p-4 text-muted-foreground">
              <IconStar className="h-6 w-6" />
            </div>
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">
                {t('favorites.emptyTitle')}
              </h2>
              <p className="max-w-md text-sm text-muted-foreground">
                {t('favorites.emptyDescription')}
              </p>
            </div>
            <Button variant="outline" onClick={() => openSearch('all')}>
              {t('favorites.openSearch')}
            </Button>
          </div>
        ) : filteredFavorites.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
            <div className="rounded-full bg-muted p-4 text-muted-foreground">
              <IconSearch className="h-6 w-6" />
            </div>
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">
                {t('favorites.emptyFilteredTitle')}
              </h2>
              <p className="max-w-md text-sm text-muted-foreground">
                {t('favorites.emptyFilteredDescription')}
              </p>
            </div>
            {hasActiveFilters ? (
              <Button variant="outline" onClick={clearFilters}>
                {t('favorites.clearFilters')}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="divide-y">
            {filteredFavorites.map((favorite) => {
              const { icon: IconComponent, label } = getResourcePresentation(
                favorite.resourceType
              )

              return (
                <div
                  key={favorite.id}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/30"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    onClick={() => navigate(getFavoritePath(favorite))}
                  >
                    <div className="rounded-lg bg-primary/10 p-2 text-primary">
                      <IconComponent className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium">
                          {favorite.name}
                        </span>
                        <Badge variant="secondary">{t(label)}</Badge>
                      </div>
                      {favorite.namespace ? (
                        <div className="mt-1 text-sm text-muted-foreground">
                          {favorite.namespace}
                        </div>
                      ) : null}
                    </div>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('favorites.remove')}
                    onClick={() => void handleRemoveFavorite(favorite)}
                  >
                    <IconStarFilled className="h-4 w-4 text-yellow-500" />
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
