import type { ImageTagInfo } from '@/types/api'

/** Validate external responses and cached data before rendering tag suggestions. */
export function normalizeImageTags(value: unknown): ImageTagInfo[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return []
    const { name, timestamp } = item as Record<string, unknown>
    if (typeof name !== 'string' || !name.trim()) return []

    const tag: ImageTagInfo = { name }
    if (
      typeof timestamp === 'string' &&
      Number.isFinite(new Date(timestamp).getTime())
    ) {
      tag.timestamp = timestamp
    }
    return [tag]
  })
}
