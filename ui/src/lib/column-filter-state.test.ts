import { describe, expect, it } from 'vitest'

import {
  migrateResourceColumnVisibility,
  restoreColumnFilters,
} from './column-filter-state'

describe('restoring column filters after status semantics change', () => {
  it('retires legacy Pod phase and numerator filters but keeps new and unrelated filters', () => {
    const saved = JSON.stringify([
      { id: '状态', value: ['Running'] },
      { id: 'Status', value: ['Failed'] },
      { id: 'containers', value: ['1'] },
      { id: 'status', value: ['ImagePullBackOff'] },
      { id: 'nodeName', value: ['worker-1'] },
    ])
    expect(restoreColumnFilters(saved, 'Pods', ['状态', 'Status'])).toEqual([
      { id: 'status', value: ['ImagePullBackOff'] },
      { id: 'nodeName', value: ['worker-1'] },
    ])
  })

  it('does not discard other resource status filters or new ratios', () => {
    const filters = [
      { id: 'Status', value: ['Running'] },
      { id: 'ready', value: ['1 / 2'] },
    ]
    expect(
      restoreColumnFilters(JSON.stringify(filters), 'Deployments', ['Status'])
    ).toEqual(filters)
  })

  it('ignores malformed saved data', () => {
    for (const saved of [
      '{',
      '{}',
      '[null]',
      '[{"id":"status","value":[{}]}]',
    ]) {
      expect(restoreColumnFilters(saved, 'Pods', [])).toEqual([])
    }
  })
})

it('preserves hidden Pod status columns when adopting the stable ID', () => {
  expect(
    migrateResourceColumnVisibility({ 状态: false, nodeName: true }, 'Pods', [
      '状态',
    ])
  ).toEqual({ status: false, nodeName: true })
  expect(
    migrateResourceColumnVisibility({ Status: false, status: true }, 'Pods', [
      'Status',
    ])
  ).toEqual({ status: true })
})

it('retires byte-based capacity filters and preserves the capacity visibility preference', () => {
  const filters = [
    { id: '容量', value: ['1073741824'] },
    { id: 'capacity', value: ['1Gi'] },
  ]
  expect(
    restoreColumnFilters(
      JSON.stringify(filters),
      'PersistentVolumes',
      [],
      ['容量']
    )
  ).toEqual([filters[1]])
  expect(
    migrateResourceColumnVisibility(
      { 容量: false },
      'PersistentVolumes',
      [],
      ['容量']
    )
  ).toEqual({ capacity: false })
})

it('drops old time-dependent restart filters while preserving numeric selections', () => {
  expect(
    restoreColumnFilters(
      JSON.stringify([{ id: 'restarts', value: ['1 (30s)'] }]),
      'Pods',
      []
    )
  ).toEqual([])
  const current = [{ id: 'restarts', value: ['1'] }]
  expect(restoreColumnFilters(JSON.stringify(current), 'Pods', [])).toEqual(
    current
  )
})
