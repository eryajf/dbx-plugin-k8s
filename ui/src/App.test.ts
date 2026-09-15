import { describe, expect, it } from 'vitest'

import { shouldShowClusterLoading } from './App'

describe('App', () => {
  it('keeps the app shell visible while a current cluster already exists', () => {
    expect(shouldShowClusterLoading(true, 'cluster-a')).toBeFalsy()
    expect(shouldShowClusterLoading(false, 'cluster-a')).toBeFalsy()
  })

  it('shows cluster loading only when no current cluster is available', () => {
    expect(shouldShowClusterLoading(true, null)).toBeTruthy()
  })
})
