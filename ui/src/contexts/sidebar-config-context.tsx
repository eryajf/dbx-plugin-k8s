/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'
import * as React from 'react'
import {
  Icon,
  IconArrowsHorizontal,
  IconBell,
  IconBox,
  IconBoxMultiple,
  IconClockHour4,
  IconCode,
  IconDatabase,
  IconFileDatabase,
  IconKey,
  IconLoadBalancer,
  IconLock,
  IconMap,
  IconNetwork,
  IconPlayerPlay,
  IconProps,
  IconRocket,
  IconRoute,
  IconRouter,
  IconServer2,
  IconShield,
  IconShieldCheck,
  IconStack2,
  IconStar,
  IconTopologyBus,
  IconUser,
  IconUsers,
} from '@tabler/icons-react'

import {
  DefaultMenus,
  SidebarConfig,
  SidebarGroup,
  SidebarItem,
} from '@/types/sidebar'
import { getSidebarPreference, saveSidebarPreference } from '@/lib/api/admin'

const iconMap = {
  IconBox,
  IconRocket,
  IconStack2,
  IconTopologyBus,
  IconPlayerPlay,
  IconClockHour4,
  IconRouter,
  IconNetwork,
  IconLoadBalancer,
  IconRoute,
  IconFileDatabase,
  IconDatabase,
  IconMap,
  IconLock,
  IconUser,
  IconShield,
  IconUsers,
  IconShieldCheck,
  IconKey,
  IconBoxMultiple,
  IconServer2,
  IconBell,
  IconCode,
  IconArrowsHorizontal,
  IconStar,
}

const getIconName = (iconComponent: React.ComponentType): string => {
  const entry = Object.entries(iconMap).find(
    ([, component]) => component === iconComponent
  )
  return entry ? entry[0] : 'IconBox'
}

interface SidebarConfigContextType {
  config: SidebarConfig | null
  isLoading: boolean
  hasUpdate: boolean
  updateConfig: (updates: Partial<SidebarConfig>) => void
  toggleItemVisibility: (itemId: string) => void
  toggleGroupVisibility: (groupId: string) => void
  toggleItemPin: (itemId: string) => void
  toggleGroupCollapse: (groupId: string) => void
  resetConfig: () => void
  getIconComponent: (
    iconName: string
  ) =>
    | React.ForwardRefExoticComponent<IconProps & React.RefAttributes<Icon>>
    | React.ElementType
  createCustomGroup: (groupName: string) => void
  addCRDToGroup: (groupId: string, crdName: string, kind: string) => void
  removeCRDToGroup: (groupId: string, crdName: string) => void
  removeCustomGroup: (groupId: string) => void
  moveGroup: (groupId: string, direction: 'up' | 'down') => void
}

const SidebarConfigContext = createContext<
  SidebarConfigContextType | undefined
>(undefined)

export const useSidebarConfig = () => {
  const context = useContext(SidebarConfigContext)
  if (!context) {
    throw new Error(
      'useSidebarConfig must be used within a SidebarConfigProvider'
    )
  }
  return context
}

interface SidebarConfigProviderProps {
  children: React.ReactNode
}

const defaultMenus: DefaultMenus = {
  'sidebar.groups.cluster': [
    { titleKey: 'nav.nodes', url: '/nodes', icon: IconServer2 },
    {
      titleKey: 'nav.namespaces',
      url: '/namespaces',
      icon: IconBoxMultiple,
    },
    { titleKey: 'nav.events', url: '/events', icon: IconBell },
    { titleKey: 'nav.favorites', url: '/favorites', icon: IconStar },
  ],
  'sidebar.groups.workloads': [
    { titleKey: 'nav.deployments', url: '/deployments', icon: IconRocket },
    {
      titleKey: 'nav.statefulsets',
      url: '/statefulsets',
      icon: IconStack2,
    },
    {
      titleKey: 'nav.daemonsets',
      url: '/daemonsets',
      icon: IconTopologyBus,
    },
    { titleKey: 'nav.pods', url: '/pods', icon: IconBox },
    { titleKey: 'nav.jobs', url: '/jobs', icon: IconPlayerPlay },
    { titleKey: 'nav.cronjobs', url: '/cronjobs', icon: IconClockHour4 },
    {
      titleKey: 'nav.horizontalpodautoscalers',
      url: '/horizontalpodautoscalers',
      icon: IconArrowsHorizontal,
    },
  ],
  'sidebar.groups.network': [
    { titleKey: 'nav.services', url: '/services', icon: IconNetwork },
    { titleKey: 'nav.ingresses', url: '/ingresses', icon: IconRouter },
    {
      titleKey: 'nav.advancedNetworking',
      url: '/networking/advanced',
      icon: IconRoute,
    },
  ],
  'sidebar.groups.config': [
    { titleKey: 'nav.configMaps', url: '/configmaps', icon: IconMap },
    { titleKey: 'nav.secrets', url: '/secrets', icon: IconLock },
  ],
  'sidebar.groups.storage': [
    {
      titleKey: 'nav.persistentvolumeclaims',
      url: '/persistentvolumeclaims',
      icon: IconFileDatabase,
    },
    {
      titleKey: 'nav.persistentvolumes',
      url: '/persistentvolumes',
      icon: IconDatabase,
    },
    {
      titleKey: 'nav.storageclasses',
      url: '/storageclasses',
      icon: IconFileDatabase,
    },
  ],
  'sidebar.groups.security': [
    {
      titleKey: 'nav.serviceaccounts',
      url: '/serviceaccounts',
      icon: IconUser,
    },
    { titleKey: 'nav.roles', url: '/roles', icon: IconShield },
    { titleKey: 'nav.rolebindings', url: '/rolebindings', icon: IconUsers },
    {
      titleKey: 'nav.clusterroles',
      url: '/clusterroles',
      icon: IconShieldCheck,
    },
    {
      titleKey: 'nav.clusterrolebindings',
      url: '/clusterrolebindings',
      icon: IconKey,
    },
  ],
  'sidebar.groups.extension': [
    { titleKey: 'nav.crds', url: '/crds', icon: IconCode },
  ],
}

const CURRENT_CONFIG_VERSION = 4
const sidebarStorageKey = () => `dbx:kite:${(window as unknown as {dbxPlugin?: {context?: {connectionId?: string}}}).dbxPlugin?.context?.connectionId || 'unbound'}:sidebar-config`
const DEFAULT_COLLAPSED_GROUP_IDS = new Set([
  'sidebar-groups-security',
  'sidebar-groups-extension',
])
const SIDEBAR_GROUP_MIGRATION_SOURCES: Record<string, string[]> = {
  'sidebar-groups-cluster': ['sidebar-groups-cluster', 'sidebar-groups-other'],
  'sidebar-groups-workloads': ['sidebar-groups-workloads'],
  'sidebar-groups-network': [
    'sidebar-groups-network',
    'sidebar-groups-traffic',
  ],
  'sidebar-groups-config': ['sidebar-groups-config'],
  'sidebar-groups-storage': ['sidebar-groups-storage'],
  'sidebar-groups-security': ['sidebar-groups-security'],
  'sidebar-groups-extension': [
    'sidebar-groups-extension',
    'sidebar-groups-other',
  ],
}

const isDefaultCollapsedGroup = (groupId: string) =>
  DEFAULT_COLLAPSED_GROUP_IDS.has(groupId)

const defaultConfigs = (): SidebarConfig => {
  const groups: SidebarGroup[] = []
  let groupOrder = 0

  Object.entries(defaultMenus).forEach(([groupKey, items]) => {
    const groupId = groupKey
      .toLowerCase()
      .replace(/\./g, '-')
      .replace(/\s+/g, '-')
    const sidebarItems: SidebarItem[] = items.map((item, index) => ({
      id: `${groupId}-${item.url.replace(/[^a-zA-Z0-9]/g, '-')}`,
      titleKey: item.titleKey,
      url: item.url,
      icon: getIconName(item.icon),
      visible: true,
      pinned: false,
      order: index,
    }))

    groups.push({
      id: groupId,
      nameKey: groupKey,
      items: sidebarItems,
      visible: true,
      collapsed: isDefaultCollapsedGroup(groupId),
      order: groupOrder++,
    })
  })

  return {
    version: CURRENT_CONFIG_VERSION,
    groups,
    hiddenItems: [],
    pinnedItems: [],
    groupOrder: groups.map((g) => g.id),
    lastUpdated: Date.now(),
  }
}

const migrateSidebarConfig = (config: SidebarConfig): SidebarConfig => {
  const nextConfig = defaultConfigs()
  const itemIdMap = new Map<string, string>()
  const existingItemsByUrl = new Map(
    config.groups.flatMap((group) =>
      group.items.map((item) => [item.url, item] as const)
    )
  )

  const groups = nextConfig.groups.map((group) => {
    const sourceGroup = config.groups.find((candidate) =>
      (SIDEBAR_GROUP_MIGRATION_SOURCES[group.id] || []).includes(candidate.id)
    )

    return {
      ...group,
      visible: sourceGroup?.visible ?? group.visible,
      collapsed: isDefaultCollapsedGroup(group.id)
        ? true
        : (sourceGroup?.collapsed ?? group.collapsed),
      items: group.items.map((item, index) => {
        const existingItem = existingItemsByUrl.get(item.url)
        if (existingItem) {
          itemIdMap.set(existingItem.id, item.id)
        }

        return {
          ...item,
          visible: existingItem?.visible ?? item.visible,
          pinned: existingItem?.pinned ?? item.pinned,
          order: index,
        }
      }),
    }
  })

  const customGroups = config.groups
    .filter((group) => group.isCustom)
    .sort((a, b) => a.order - b.order)
    .map((group, index) => {
      group.items.forEach((item) => itemIdMap.set(item.id, item.id))
      return {
        ...group,
        order: groups.length + index,
        items: group.items.map((item, itemIndex) => ({
          ...item,
          order: itemIndex,
        })),
      }
    })

  const mergedGroups = [...groups, ...customGroups].map((group, index) => ({
    ...group,
    order: index,
  }))
  const validItemIds = new Set(
    mergedGroups.flatMap((group) => group.items.map((item) => item.id))
  )
  const remapItemIds = (itemIds: string[]) =>
    Array.from(
      new Set(
        itemIds
          .map((itemId) => itemIdMap.get(itemId))
          .filter(
            (itemId): itemId is string => !!itemId && validItemIds.has(itemId)
          )
      )
    )

  return {
    version: CURRENT_CONFIG_VERSION,
    groups: mergedGroups,
    hiddenItems: remapItemIds(config.hiddenItems),
    pinnedItems: remapItemIds(config.pinnedItems),
    groupOrder: mergedGroups.map((group) => group.id),
    lastUpdated: Date.now(),
  }
}

export const SidebarConfigProvider: React.FC<SidebarConfigProviderProps> = ({
  children,
}) => {
  const [config, setConfig] = useState<SidebarConfig | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [hasUpdate, setHasUpdate] = useState(false)

  const applyConfig = useCallback(
    async (
      nextConfig: SidebarConfig,
      options: { persistRemote?: boolean } = {}
    ) => {
      const configToStore = {
        ...nextConfig,
        lastUpdated: Date.now(),
        version: CURRENT_CONFIG_VERSION,
      }
      const serializedConfig = JSON.stringify(configToStore)

      localStorage.setItem(sidebarStorageKey(), serializedConfig)
      setConfig(configToStore)

      if (options.persistRemote) {
        await saveSidebarPreference(serializedConfig)
      }

      return configToStore
    },
    []
  )

  const loadConfig = useCallback(async () => {
    try {
      setHasUpdate(false)

      const response = await getSidebarPreference()
      const remoteConfig = (response.sidebar_preference || '').trim()

      if (remoteConfig) {
        const parsedConfig = JSON.parse(remoteConfig) as SidebarConfig
        const currentVersion = parsedConfig.version || 0
        if (currentVersion < CURRENT_CONFIG_VERSION) {
          await applyConfig(migrateSidebarConfig(parsedConfig), {
            persistRemote: true,
          })
          return
        }

        await applyConfig(parsedConfig)
        return
      }

      const storedConfig = localStorage.getItem(sidebarStorageKey())
      if (!storedConfig) {
        setConfig(defaultConfigs())
        return
      }

      const parsedConfig = JSON.parse(storedConfig) as SidebarConfig
      const currentVersion = parsedConfig.version || 0
      if (currentVersion < CURRENT_CONFIG_VERSION) {
        await applyConfig(migrateSidebarConfig(parsedConfig), {
          persistRemote: true,
        })
        return
      }

      await applyConfig(parsedConfig)
      return
    } catch (error) {
      console.error('Failed to load sidebar config from storage:', error)
    }

    setConfig(defaultConfigs())
  }, [applyConfig])

  const saveConfig = useCallback(
    async (newConfig: SidebarConfig) => {
      try {
        await applyConfig(newConfig, { persistRemote: true })
      } catch (error) {
        console.error('Failed to save sidebar config to storage:', error)
      }
    },
    [applyConfig]
  )

  const updateConfig = useCallback(
    (updates: Partial<SidebarConfig>) => {
      if (!config) return
      const newConfig = { ...config, ...updates }
      saveConfig(newConfig)
    },
    [config, saveConfig]
  )

  const toggleItemVisibility = useCallback(
    (itemId: string) => {
      if (!config) return

      const hiddenItems = new Set(config.hiddenItems)
      if (hiddenItems.has(itemId)) {
        hiddenItems.delete(itemId)
      } else {
        hiddenItems.add(itemId)
      }

      updateConfig({ hiddenItems: Array.from(hiddenItems) })
    },
    [config, updateConfig]
  )

  const toggleItemPin = useCallback(
    (itemId: string) => {
      if (!config) return

      const pinnedItems = new Set(config.pinnedItems)
      if (pinnedItems.has(itemId)) {
        pinnedItems.delete(itemId)
      } else {
        pinnedItems.add(itemId)
      }

      updateConfig({ pinnedItems: Array.from(pinnedItems) })
    },
    [config, updateConfig]
  )

  const toggleGroupVisibility = useCallback(
    (groupId: string) => {
      if (!config) return

      const groups = config.groups.map((group) =>
        group.id === groupId ? { ...group, visible: !group.visible } : group
      )

      updateConfig({ groups })
    },
    [config, updateConfig]
  )

  const toggleGroupCollapse = useCallback(
    (groupId: string) => {
      if (!config) return

      const groups = config.groups.map((group) =>
        group.id === groupId ? { ...group, collapsed: !group.collapsed } : group
      )

      updateConfig({ groups })
    },
    [config, updateConfig]
  )

  const moveGroup = useCallback(
    (groupId: string, direction: 'up' | 'down') => {
      if (!config) return

      const sortedGroups = [...config.groups].sort((a, b) => a.order - b.order)
      const currentIndex = sortedGroups.findIndex(
        (group) => group.id === groupId
      )
      if (currentIndex === -1) return

      const targetIndex =
        direction === 'up' ? currentIndex - 1 : currentIndex + 1

      if (targetIndex < 0 || targetIndex >= sortedGroups.length) {
        return
      }

      const reordered = [...sortedGroups]
      const [movedGroup] = reordered.splice(currentIndex, 1)
      reordered.splice(targetIndex, 0, movedGroup)

      const groups = reordered.map((group, index) => ({
        ...group,
        order: index,
      }))
      const groupOrder = groups.map((group) => group.id)

      updateConfig({ groups, groupOrder })
    },
    [config, updateConfig]
  )

  const createCustomGroup = useCallback(
    (groupName: string) => {
      if (!config) return

      const groupId = `custom-${groupName.toLowerCase().replace(/\s+/g, '-')}`

      // Check if group already exists
      if (config.groups.find((g) => g.id === groupId)) {
        return
      }

      const newGroup: SidebarGroup = {
        id: groupId,
        nameKey: groupName,
        items: [],
        visible: true,
        collapsed: false,
        order: config.groups.length,
        isCustom: true,
      }

      const groups = [...config.groups, newGroup]
      updateConfig({ groups, groupOrder: [...config.groupOrder, groupId] })
    },
    [config, updateConfig]
  )

  const addCRDToGroup = useCallback(
    (groupId: string, crdName: string, kind: string) => {
      if (!config) return

      const groups = config.groups.map((group) => {
        if (group.id === groupId) {
          const itemId = `${groupId}-${crdName.replace(/[^a-zA-Z0-9]/g, '-')}`

          // Check if CRD already exists in this group
          if (group.items.find((item) => item.id === itemId)) {
            return group
          }

          const newItem: SidebarItem = {
            id: itemId,
            titleKey: kind,
            url: `/crds/${crdName}`,
            icon: 'IconCode',
            visible: true,
            pinned: false,
            order: group.items.length,
          }

          return {
            ...group,
            items: [...group.items, newItem],
          }
        }
        return group
      })

      updateConfig({ groups })
    },
    [config, updateConfig]
  )

  const removeCRDToGroup = useCallback(
    (groupId: string, itemID: string) => {
      if (!config) return
      const groups = config.groups.map((group) => {
        if (group.id === groupId) {
          const newItems = group.items.filter((item) => item.id !== itemID)
          return {
            ...group,
            items: newItems,
          }
        }
        return group
      })

      const pinnedItems = config.pinnedItems.filter((item) => item !== itemID)
      const hiddenItems = config.hiddenItems.filter((item) => item !== itemID)

      updateConfig({ groups, pinnedItems, hiddenItems })
    },
    [config, updateConfig]
  )

  const removeCustomGroup = useCallback(
    (groupId: string) => {
      if (!config) return

      // Only allow removing custom groups
      const group = config.groups.find((g) => g.id === groupId)
      if (!group?.isCustom) return

      const groups = config.groups.filter((g) => g.id !== groupId)
      const groupOrder = config.groupOrder.filter((id) => id !== groupId)

      // Remove any pinned items from this group
      const groupItemIds = group.items.map((item) => item.id)
      const pinnedItems = config.pinnedItems.filter(
        (itemId) => !groupItemIds.includes(itemId)
      )
      const hiddenItems = config.hiddenItems.filter(
        (itemId) => !groupItemIds.includes(itemId)
      )

      updateConfig({ groups, groupOrder, pinnedItems, hiddenItems })
    },
    [config, updateConfig]
  )

  const resetConfig = useCallback(() => {
    const newConfig = defaultConfigs()
    saveConfig(newConfig)
    setHasUpdate(false)
  }, [saveConfig])

  const getIconComponent = useCallback((iconName: string) => {
    return iconMap[iconName as keyof typeof iconMap] || IconBox
  }, [])

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true)
      await loadConfig()
      setIsLoading(false)
    }
    loadData()
  }, [loadConfig])

  const value: SidebarConfigContextType = {
    config,
    isLoading,
    hasUpdate,
    updateConfig,
    toggleItemVisibility,
    toggleGroupVisibility,
    toggleItemPin,
    toggleGroupCollapse,
    resetConfig,
    getIconComponent,
    createCustomGroup,
    addCRDToGroup,
    removeCRDToGroup,
    removeCustomGroup,
    moveGroup,
  }

  return (
    <SidebarConfigContext.Provider value={value}>
      {children}
    </SidebarConfigContext.Provider>
  )
}
