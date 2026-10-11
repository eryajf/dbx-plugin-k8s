import { displayFilterValue } from './column-filter-match'

export interface ColumnFilterOption {
  label: string
  values: string[]
  count: number
}

/** Combine equivalent display labels without losing the raw values used to match rows. */
export function columnFilterOptions(
  facets: Map<unknown, number>,
  formatLabel?: (value: unknown) => string
): ColumnFilterOption[] {
  const options = new Map<string, ColumnFilterOption>()
  for (const [value, count] of facets) {
    if (value != null && typeof value === 'object') continue
    const raw = String(value ?? '')
    const label = formatLabel ? formatLabel(value) : raw || '-'
    const key = formatLabel ? displayFilterValue(value) : raw
    const option = options.get(label) ?? { label, values: [], count: 0 }
    if (!option.values.includes(key)) option.values.push(key)
    option.count += count
    options.set(label, option)
  }
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label))
}
