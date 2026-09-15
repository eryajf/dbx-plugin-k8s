import { describe, expect, it, vi } from 'vitest'

import { APIError } from './api-client'
import { translateClusterConnectionError } from './cluster-connection-errors'

describe('translateClusterConnectionError', () => {
  const t = vi.fn(
    (
      key: string,
      fallbackOrOptions?:
        | string
        | { defaultValue?: string; message?: string; detail?: string }
    ) => {
      if (typeof fallbackOrOptions === 'string') {
        return fallbackOrOptions
      }
      if (key === 'clusterManagement.messages.testErrorWithDetail') {
        return `${fallbackOrOptions?.message} Details: ${fallbackOrOptions?.detail}`
      }
      return fallbackOrOptions?.defaultValue ?? key
    }
  )

  it('localizes known API errors and appends technical detail', () => {
    const error = new APIError(
      'Failed to resolve the Kubernetes API Server host.',
      {
        code: 'CLUSTER_CONNECTION_DNS_RESOLUTION_FAILED',
        detail: 'lookup demo.example.invalid: no such host',
      }
    )

    expect(translateClusterConnectionError(error, t)).toBe(
      'Failed to resolve the Kubernetes API Server host. Please check the server address and DNS settings. Details: lookup demo.example.invalid: no such host'
    )
  })

  it('falls back to the original message for unknown errors', () => {
    expect(translateClusterConnectionError(new Error('boom'), t)).toBe('boom')
  })
})
