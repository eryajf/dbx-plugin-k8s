// API client with authentication support
import {
  appendClusterNameParam,
  stripClusterNameHeader,
} from './cluster-transport'
import { withSubPath } from './subpath'
import { getDBXTransport } from './dbx-transport'
import { normalizeRequestError } from './request-errors'

export interface APIRequestOptions extends RequestInit {
  connectionId?: string
  timeoutMs?: number
}

export interface APIErrorOptions {
  code?: string
  detail?: string
  status?: number
}

export class APIError extends Error {
  code?: string
  detail?: string
  status?: number

  constructor(message: string, options: APIErrorOptions = {}) {
    super(message)
    this.name = 'APIError'
    this.code = options.code
    this.detail = options.detail
    this.status = options.status
  }
}

class ApiClient {
  private baseUrl: string = ''
  private getCurrentCluster: (() => string | null) | null = null

  constructor(baseUrl: string = '') {
    this.baseUrl = baseUrl
  }

  setClusterProvider(provider: () => string | null) {
    this.getCurrentCluster = provider
  }

  private async makeRequest<T>(
    url: string,
    options: APIRequestOptions = {}
  ): Promise<T> {
    const { connectionId, timeoutMs, ...requestOptions } = options
    const transport = getDBXTransport(connectionId)
    if (transport) {
      try {
        return await transport.request<T>(url, options.method || 'GET', options.body instanceof FormData ? options.body : options.body ? JSON.parse(String(options.body)) : undefined, { timeoutMs, signal: options.signal })
      } catch (error) {
        throw normalizeRequestError(error)
      }
    }
    if (connectionId && (globalThis as {dbxPlugin?: unknown}).dbxPlugin) {
      throw Object.assign(new Error('DBX connection is not connected'), { code: 'not_connected', retryable: false })
    }
    const fullUrl = withSubPath(this.baseUrl + url)

    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    }
    const explicitClusterName = stripClusterNameHeader(headers)

    // Only set default Content-Type to application/json if not already set and body is not FormData
    if (!headers['Content-Type'] && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json'
    }

    const requestUrl = appendClusterNameParam(
      fullUrl,
      connectionId ?? explicitClusterName ?? this.getCurrentCluster?.()
    )

    const controller = new AbortController()
    const abort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true
      controller.abort()
    }, Math.max(1, Math.min(60_000, timeoutMs)))
    const defaultOptions: RequestInit = {
      credentials: 'include',
      ...requestOptions,
      headers,
      signal: controller.signal,
    }

    try {
      const response = await fetch(requestUrl, defaultOptions)

      if (response.status === 401) {
        throw new APIError('Unauthorized', { status: 401 })
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new APIError(
          errorData.error || `HTTP error! status: ${response.status}`,
          {
            code:
              typeof errorData.errorCode === 'string'
                ? errorData.errorCode
                : undefined,
            detail:
              typeof errorData.errorDetail === 'string'
                ? errorData.errorDetail
                : undefined,
            status: response.status,
          }
        )
      }

      const contentType = response.headers.get('content-type')
      if (contentType && contentType.includes('application/json')) {
        return await response.json()
      } else {
        return (await response.text()) as T
      }
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException('Request canceled', 'AbortError')
      if (timedOut) throw Object.assign(new Error('Resource read timed out'), { code: 'timeout', retryable: true })
      if (error instanceof TypeError && /Failed to fetch|NetworkError|Load failed|fetch failed/i.test(error.message)) {
        throw Object.assign(error, { code: 'network', retryable: true })
      }
      throw normalizeRequestError(error)
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }

  async get<T>(url: string, options?: APIRequestOptions): Promise<T> {
    return this.makeRequest<T>(url, { ...options, method: 'GET' })
  }

  async post<T>(
    url: string,
    data?: unknown,
    options?: APIRequestOptions
  ): Promise<T> {
    const isFormData = data instanceof FormData
    return this.makeRequest<T>(url, {
      ...options,
      method: 'POST',
      body: isFormData
        ? (data as BodyInit)
        : data
          ? JSON.stringify(data)
          : undefined,
    })
  }

  async put<T>(url: string, data?: unknown, options?: APIRequestOptions): Promise<T> {
    const isFormData = data instanceof FormData
    return this.makeRequest<T>(url, {
      ...options,
      method: 'PUT',
      body: isFormData
        ? (data as BodyInit)
        : data
          ? JSON.stringify(data)
          : undefined,
    })
  }

  async delete<T>(url: string, options?: APIRequestOptions): Promise<T> {
    return this.makeRequest<T>(url, { ...options, method: 'DELETE' })
  }

  async patch<T>(
    url: string,
    data?: unknown,
    options?: APIRequestOptions
  ): Promise<T> {
    const isFormData = data instanceof FormData
    return this.makeRequest<T>(url, {
      ...options,
      method: 'PATCH',
      body: isFormData
        ? (data as BodyInit)
        : data
          ? JSON.stringify(data)
          : undefined,
    })
  }
}

export const API_BASE_URL = '/api/v1'

// Create a singleton instance
export const apiClient = new ApiClient(API_BASE_URL)
