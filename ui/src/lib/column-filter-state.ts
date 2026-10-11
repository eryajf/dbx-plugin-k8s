import type { ColumnFiltersState } from '@tanstack/react-table'

/** Retire phase-based Pod filters; they cannot be mapped to detailed statuses. */
export function restoreColumnFilters(
  saved: string | null,
  resourceName: string,
  legacyPodStatusIds: string[],
  legacyCapacityIds: string[] = []
): ColumnFiltersState {
  if (!saved) return []
  try {
    const filters: unknown = JSON.parse(saved)
    if (!Array.isArray(filters)) return []
    return filters.filter((filter): filter is ColumnFiltersState[number] => {
      if (
        !filter ||
        typeof filter.id !== 'string' ||
        !Array.isArray(filter.value)
      )
        return false
      if (!filter.value.every((value: unknown) => typeof value === 'string'))
        return false
      if (resourceName === 'Pods' && legacyPodStatusIds.includes(filter.id))
        return false
      if (
        ['PersistentVolumes', 'PersistentVolumeClaims'].includes(
          resourceName
        ) &&
        legacyCapacityIds.includes(filter.id)
      )
        return false
      if (
        resourceName === 'Pods' &&
        filter.id === 'restarts' &&
        filter.value.some((value: string) => !/^\d+$/.test(value))
      )
        return false
      // Old readiness facets stored only the numerator, not the displayed ratio.
      if (
        ['Pods', 'Deployments', 'StatefulSets'].includes(resourceName) &&
        ['ready', 'containers'].includes(filter.id) &&
        filter.value.some((value: string) => !value.includes('/'))
      )
        return false
      return true
    })
  } catch {
    return []
  }
}

export function migrateResourceColumnVisibility(
  visibility: Record<string, boolean>,
  resourceName: string,
  legacyIds: string[],
  legacyCapacityIds: string[] = []
): Record<string, boolean> {
  const columnId =
    resourceName === 'Pods'
      ? 'status'
      : ['PersistentVolumes', 'PersistentVolumeClaims'].includes(resourceName)
        ? 'capacity'
        : null
  if (!columnId) return visibility
  const ids = columnId === 'status' ? legacyIds : legacyCapacityIds
  const next = { ...visibility }
  for (const id of ids) {
    if (id === columnId || !(id in next)) continue
    next[columnId] ??= next[id]
    delete next[id]
  }
  return next
}
