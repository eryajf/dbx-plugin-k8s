import { describe, expect, it } from 'vitest'
import { displayFilterValue, matchesColumnFilter } from './column-filter-match'

describe('display filter persistence', () => {
  it('re-evaluates numeric legacy and new selections using the current formatter', () => {
    const format = (value: unknown) =>
      `${(Number(value) / 1000).toFixed(1)} cores`
    for (const selection of [['1001'], [displayFilterValue(1001)]]) {
      expect(matchesColumnFilter(1002, selection, format)).toBe(true)
      expect(matchesColumnFilter(2000, selection, format)).toBe(false)
    }
  })
  it('preserves boolean and null reference types through JSON storage', () => {
    const selection = JSON.parse(JSON.stringify([displayFilterValue(false)]))
    const format = (value: unknown) => (value ? '是' : '否')
    expect(matchesColumnFilter(false, selection, format)).toBe(true)
    expect(matchesColumnFilter(true, selection, format)).toBe(false)
    expect(matchesColumnFilter(false, ['false'], format)).toBe(true)
    expect(
      matchesColumnFilter(null, [displayFilterValue(null)], () => '-')
    ).toBe(true)
  })
})
