import { QueryClient } from '@tanstack/react-query'

export const clusterQueryKey = ['clusters'] as const
export const clusterManagementQueryKey = ['cluster-list'] as const

export async function invalidateClusterQueries(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: clusterQueryKey }),
    queryClient.invalidateQueries({ queryKey: clusterManagementQueryKey }),
  ])
}
