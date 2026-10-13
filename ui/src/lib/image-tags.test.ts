import { describe, expect, it } from 'vitest'

import { normalizeImageTags } from './image-tags'

describe('normalizeImageTags', () => {
  it.each([undefined, null, {}, { items: [{ name: 'v1' }] }, 'html', 42])(
    'does not interpret non-array responses as tag suggestions: %j',
    (value) => expect(normalizeImageTags(value)).toEqual([])
  )

  it('preserves valid tags and timestamps without changing the source', () => {
    const tags = [{ name: 'v1', timestamp: '2026-10-13T00:00:00Z' }, { name: 'latest' }]
    expect(normalizeImageTags(tags)).toEqual(tags)
    expect(normalizeImageTags(tags)[0]).not.toBe(tags[0])
  })

  it('filters invalid entries and removes unsafe timestamps without losing valid names', () => {
    expect(normalizeImageTags([
      null, undefined, 'v1', 42, [], {}, { name: 1 }, { name: '' }, { name: '  ' },
      { name: 'v1', timestamp: 'not-a-date' },
      { name: 'v2', timestamp: {} },
      { name: 'v3', timestamp: 123 },
      { name: 'v4', timestamp: '' },
      { name: 'v5', timestamp: '2026-10-13T00:00:00Z' },
    ])).toEqual([
      { name: 'v1' }, { name: 'v2' }, { name: 'v3' }, { name: 'v4' },
      { name: 'v5', timestamp: '2026-10-13T00:00:00Z' },
    ])
  })
})
