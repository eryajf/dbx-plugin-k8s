import { describe, expect, it } from 'vitest'

import {
  appendClusterNameParam,
  stripClusterNameHeader,
} from './cluster-transport'

describe('appendClusterNameParam', () => {
  it('appends a UTF-8 cluster name as a query parameter', () => {
    expect(appendClusterNameParam('/api/v1/nodes', '生产集群')).toBe(
      '/api/v1/nodes?x-cluster-name=%E7%94%9F%E4%BA%A7%E9%9B%86%E7%BE%A4'
    )
  })

  it('preserves existing query parameters and hashes', () => {
    expect(appendClusterNameParam('/api/v1/nodes?limit=20#table', 'prod')).toBe(
      '/api/v1/nodes?limit=20&x-cluster-name=prod#table'
    )
  })
})

describe('stripClusterNameHeader', () => {
  it('removes cluster headers and returns the trimmed value', () => {
    const headers = {
      'Content-Type': 'application/json',
      'x-cluster-name': '  生产集群  ',
    }

    expect(stripClusterNameHeader(headers)).toBe('生产集群')
    expect(headers).toEqual({
      'Content-Type': 'application/json',
    })
  })
})
