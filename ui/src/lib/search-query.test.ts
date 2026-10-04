import { describe, expect, it } from 'vitest'

import {
  getSearchTokens,
  hasSearchQuery,
  normalizeSearchQuery,
} from './search-query'

describe('search query normalization', () => {
  it('normalizes compatibility characters, case and whitespace', () => {
    expect(normalizeSearchQuery('  ＡＰＩ\u3000Server  ')).toBe('api server')
    expect(getSearchTokens('  ＡＰＩ\u3000Server  ')).toEqual(['api', 'server'])
  })

  it('accepts a single non-whitespace token', () => {
    expect(hasSearchQuery('p')).toBe(true)
    expect(hasSearchQuery('   ')).toBe(false)
  })
})
