function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reject broken responses instead of presenting a protocol error as no matches. */
export function validateSearchResponse(
  value: unknown,
  resourceKey: 'resource' | 'resourceType'
): void {
  const invalid = () => {
    throw new Error('Invalid resource search response')
  }
  if (!isRecord(value)) return invalid()
  const lists = [value.items, value.results].filter((items) => items !== undefined)
  if (lists.length === 0) return invalid()
  for (const items of lists) {
    if (!Array.isArray(items)) return invalid()
    for (const item of items) {
      if (
        !isRecord(item) ||
        typeof item.name !== 'string' ||
        !item.name.trim() ||
        typeof item[resourceKey] !== 'string' ||
        !(item[resourceKey] as string).trim()
      ) return invalid()
      for (const key of ['id', 'uid', 'namespace', 'group', 'version', 'kind', 'createdAt']) {
        if (item[key] !== undefined && typeof item[key] !== 'string') return invalid()
      }
      if (
        item.labels !== undefined &&
        (!isRecord(item.labels) || Object.values(item.labels).some((label) => typeof label !== 'string'))
      ) return invalid()
    }
  }
  // Go encodes a nil warning slice as null; this is equivalent to no warnings.
  if (
    value.warnings != null &&
    (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== 'string'))
  ) return invalid()
  for (const key of ['total', 'generation']) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) return invalid()
  }
  for (const key of ['truncated', 'complete', 'syncing']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return invalid()
  }
  for (const key of ['status', 'indexAge', 'nextCursor']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return invalid()
  }
}
