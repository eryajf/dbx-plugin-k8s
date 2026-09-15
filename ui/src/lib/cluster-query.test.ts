import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import {
  clusterManagementQueryKey,
  clusterQueryKey,
  invalidateClusterQueries,
} from './cluster-query'

describe('invalidateClusterQueries', () => {
  it('invalidates both cluster caches', async () => {
    const queryClient = new QueryClient()
    const invalidateQueriesSpy = vi.spyOn(queryClient, 'invalidateQueries')

    await invalidateClusterQueries(queryClient)

    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: clusterQueryKey,
    })
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: clusterManagementQueryKey,
    })
    expect(invalidateQueriesSpy).toHaveBeenCalledTimes(2)
  })
})
