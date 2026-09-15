import { describe, expect, it } from 'vitest'

import { clearClusterCookie, setClusterCookie } from './cluster-cookie'

describe('cluster cookie helpers', () => {
  it('encodes non-ascii cluster names before writing cookies', () => {
    setClusterCookie('生产集群')

    expect(document.cookie).toContain(
      'x-cluster-name=%E7%94%9F%E4%BA%A7%E9%9B%86%E7%BE%A4'
    )
  })

  it('clears the cluster cookie', () => {
    setClusterCookie('cluster-a')
    clearClusterCookie()

    expect(document.cookie).not.toContain('x-cluster-name=')
  })
})
