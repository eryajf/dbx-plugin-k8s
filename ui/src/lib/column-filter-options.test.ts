import { describe, expect, it } from 'vitest'

import { displayFilterValue } from './column-filter-match'
import { columnFilterOptions } from './column-filter-options'

describe('column filter options', () => {
  it('merges translated aliases and adds their counts while retaining both match values', () => {
    expect(
      columnFilterOptions(
        new Map([
          ['Completed', 2],
          ['Succeeded', 3],
        ]),
        () => '已完成'
      )
    ).toEqual([
      {
        label: '已完成',
        values: [
          displayFilterValue('Completed'),
          displayFilterValue('Succeeded'),
        ],
        count: 5,
      },
    ])
  })
  it('provides a selectable empty placeholder and omits structured values', () => {
    expect(
      columnFilterOptions(
        new Map<unknown, number>([
          [null, 1],
          [undefined, 2],
          ['', 3],
          [{}, 4],
        ])
      )
    ).toEqual([{ label: '-', values: [''], count: 6 }])
  })
  it('keeps false and zero selectable', () => {
    expect(
      columnFilterOptions(
        new Map<unknown, number>([
          [false, 1],
          [0, 2],
        ])
      )
    ).toEqual([
      { label: '0', values: ['0'], count: 2 },
      { label: 'false', values: ['false'], count: 1 },
    ])
  })
})
