/** Store a typed representative so display groups can be re-evaluated after refresh or locale changes. */
const displayPrefix = '__dbx_display_filter_v1__:'

export function displayFilterValue(value: unknown): string {
  return displayPrefix + JSON.stringify(value ?? null)
}

export function matchesColumnFilter(
  value: unknown,
  selected: readonly string[],
  formatLabel?: (value: unknown) => string
): boolean {
  const raw = String(value ?? '')
  return selected.some((entry) => {
    if (formatLabel && entry.startsWith(displayPrefix)) {
      try {
        return (
          formatLabel(value) ===
          formatLabel(JSON.parse(entry.slice(displayPrefix.length)))
        )
      } catch {
        return false
      }
    }
    // Legacy selections stored raw strings. Preserve their display-group semantics.
    if (formatLabel) {
      const reference =
        typeof value === 'number'
          ? Number(entry)
          : typeof value === 'boolean'
            ? entry === 'true'
              ? true
              : entry === 'false'
                ? false
                : entry
            : entry
      return formatLabel(value) === formatLabel(reference)
    }
    return entry === raw
  })
}

export function matchesFilterOption(
  candidate: string,
  selected: readonly string[],
  formatLabel?: (value: unknown) => string
): boolean {
  if (formatLabel && candidate.startsWith(displayPrefix)) {
    return matchesColumnFilter(
      JSON.parse(candidate.slice(displayPrefix.length)),
      selected,
      formatLabel
    )
  }
  return selected.includes(candidate)
}
