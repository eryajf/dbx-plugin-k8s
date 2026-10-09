import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { getDBXTransport } from '@/lib/dbx-transport'
import { listDBXResources } from '@/lib/dbx-resource-discovery'
import { buildFluxNavItems, type FluxNavItem } from '@/lib/flux-navigation'
import { useCluster } from '@/hooks/use-cluster'

const collapsedKey = (connectionId: string) =>
  `dbx:kite:${connectionId}:flux-nav-collapsed`

/**
 * Flux navigation items for the current cluster, derived from discovery.
 * Returns an empty list while loading, when Flux is not installed, and when
 * discovery fails (for example restricted RBAC); the sidebar then simply hides
 * the Flux group instead of surfacing an error.
 */
export function useFluxNavigation(): {
  items: FluxNavItem[]
  collapsed: boolean
  toggleCollapsed: () => void
} {
  const { currentCluster } = useCluster()
  const connectionId = currentCluster || ''

  const { data } = useQuery({
    queryKey: ['flux-navigation', connectionId],
    enabled: !!connectionId,
    retry: false,
    staleTime: 30_000,
    queryFn: async () => {
      const transport = getDBXTransport(connectionId)
      if (!transport) return []
      const resources = await listDBXResources(connectionId, transport.invoke)
      return buildFluxNavItems(resources)
    },
  })

  const [collapsedState, setCollapsedState] = useState<{
    connectionId: string
    collapsed: boolean
  }>({ connectionId: '', collapsed: false })
  const read = (id: string) => {
    try {
      return localStorage.getItem(collapsedKey(id)) === '1'
    } catch {
      return false
    }
  }
  // Re-read the stored preference whenever the cluster changes.
  const collapsed =
    collapsedState.connectionId === connectionId
      ? collapsedState.collapsed
      : read(connectionId)

  const toggleCollapsed = useCallback(() => {
    const next = !collapsed
    setCollapsedState({ connectionId, collapsed: next })
    try {
      localStorage.setItem(collapsedKey(connectionId), next ? '1' : '0')
    } catch {
      // Collapse state is a convenience; ignore storage failures.
    }
  }, [collapsed, connectionId])

  // Never show cached items from another cluster or without a connection.
  return { items: connectionId && data ? data : [], collapsed, toggleCollapsed }
}
