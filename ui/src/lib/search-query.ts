/**
 * Normalize user supplied search input consistently across the UI and API
 * boundary. NFKC makes full-width and compatibility characters searchable,
 * while lower-casing gives us case-insensitive matching without imposing a
 * locale on Kubernetes resource names.
 */
export function normalizeSearchQuery(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
}

export function getSearchTokens(value: string): string[] {
  const normalized = normalizeSearchQuery(value)
  return normalized ? normalized.split(' ') : []
}

export function hasSearchQuery(value: string): boolean {
  return getSearchTokens(value).length > 0
}
