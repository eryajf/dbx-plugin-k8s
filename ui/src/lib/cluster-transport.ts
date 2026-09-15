const CLUSTER_NAME_PARAM = 'x-cluster-name'

export function appendClusterNameParam(
  url: string,
  clusterName?: string | null
): string {
  const normalizedClusterName = clusterName?.trim()
  if (!normalizedClusterName) {
    return url
  }

  const [base, hash = ''] = url.split('#', 2)
  const separator = base.includes('?') ? '&' : '?'
  const nextUrl = `${base}${separator}${new URLSearchParams({
    [CLUSTER_NAME_PARAM]: normalizedClusterName,
  }).toString()}`

  if (!hash) {
    return nextUrl
  }

  return `${nextUrl}#${hash}`
}

export function stripClusterNameHeader(
  headers: Record<string, string>
): string | undefined {
  const clusterName =
    headers['x-cluster-name'] ??
    headers['X-Cluster-Name'] ??
    headers[CLUSTER_NAME_PARAM]

  delete headers['x-cluster-name']
  delete headers['X-Cluster-Name']

  return clusterName?.trim() || undefined
}
