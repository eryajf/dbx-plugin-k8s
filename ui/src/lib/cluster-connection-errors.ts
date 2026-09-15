import { TFunction } from 'i18next'

import { APIError } from './api-client'

function appendErrorDetail(
  message: string,
  detail: string | undefined,
  t: TFunction
): string {
  const trimmedDetail = detail?.trim()
  if (!trimmedDetail) {
    return message
  }

  return t('clusterManagement.messages.testErrorWithDetail', {
    defaultValue: '{{message}} Details: {{detail}}',
    message,
    detail: trimmedDetail,
  })
}

export function translateClusterConnectionError(
  error: unknown,
  t: TFunction
): string {
  if (error instanceof APIError) {
    let message: string

    switch (error.code) {
      case 'CLUSTER_CONNECTION_TIMEOUT':
        message = t(
          'clusterManagement.messages.testErrors.timeout',
          'Connection test timed out. Please check the Kubernetes API Server address, network, VPN/proxy, or firewall settings.'
        )
        break
      case 'CLUSTER_CONNECTION_DNS_RESOLUTION_FAILED':
        message = t(
          'clusterManagement.messages.testErrors.dns',
          'Failed to resolve the Kubernetes API Server host. Please check the server address and DNS settings.'
        )
        break
      case 'CLUSTER_CONNECTION_REFUSED':
        message = t(
          'clusterManagement.messages.testErrors.refused',
          'The Kubernetes API Server refused the connection. Please confirm the server address, port, and local network access.'
        )
        break
      case 'CLUSTER_CONNECTION_TLS_FAILED':
        message = t(
          'clusterManagement.messages.testErrors.tls',
          'TLS certificate validation failed. Please check the kubeconfig CA, certificate, or server address.'
        )
        break
      case 'CLUSTER_CONNECTION_UNAUTHORIZED':
        message = t(
          'clusterManagement.messages.testErrors.unauthorized',
          'Authentication failed. Please check the kubeconfig user credentials, token, or client certificate.'
        )
        break
      case 'CLUSTER_CONNECTION_FORBIDDEN':
        message = t(
          'clusterManagement.messages.testErrors.forbidden',
          'The current kubeconfig can reach the cluster, but it is not allowed to query cluster version.'
        )
        break
      case 'CLUSTER_CONNECTION_INVALID_CONFIG':
        message = t(
          'clusterManagement.messages.testErrors.invalidConfig',
          'The kubeconfig is invalid or incomplete. Please check the cluster, user, and context configuration.'
        )
        break
      case 'CLUSTER_CONNECTION_IN_CLUSTER_UNAVAILABLE':
        message = t(
          'clusterManagement.messages.testErrors.inClusterUnavailable',
          'In-cluster configuration is unavailable in the current environment.'
        )
        break
      default:
        message =
          error.message ||
          t(
            'clusterManagement.messages.testError',
            'Cluster connection test failed'
          )
    }

    return appendErrorDetail(message, error.detail, t)
  }

  if (error instanceof Error) {
    return error.message
  }

  return t(
    'clusterManagement.messages.testError',
    'Cluster connection test failed'
  )
}
