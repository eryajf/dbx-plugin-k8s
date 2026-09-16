import { describe, expect, it } from 'vitest'
import { normalizeLocale, languages } from './locale'

describe('locale normalization', () => {
  it('registers all DBX languages', () => expect(languages).toHaveLength(10))
  it.each([
    ['zh_CN', 'zh-CN'],
    ['zh-CN', 'zh-CN'],
    ['zh_Hant', 'zh-TW'],
    ['zh-TW', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['pt_BR', 'pt-BR'],
    ['pt-PT', 'pt-BR'],
    ['en-US', 'en'],
    ['ja-JP', 'ja'],
    ['ko-KR', 'ko'],
    ['unknown', 'en'],
    ['', 'en'],
  ])('%s -> %s', (input, expected) =>
    expect(normalizeLocale(input)).toBe(expected)
  )
})
