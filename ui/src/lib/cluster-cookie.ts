const CLUSTER_COOKIE_NAME = 'x-cluster-name'

export function setClusterCookie(clusterName: string) {
  document.cookie = `${CLUSTER_COOKIE_NAME}=${encodeURIComponent(clusterName)}; path=/`
}

export function clearClusterCookie() {
  document.cookie = `${CLUSTER_COOKIE_NAME}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`
}
