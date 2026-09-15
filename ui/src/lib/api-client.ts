// API client with authentication support
import {
  appendClusterNameParam,
  stripClusterNameHeader,
} from './cluster-transport'
import { withSubPath } from './subpath'
import { getDBXTransport } from './dbx-transport'

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
    options: RequestInit = {}
  ): Promise<T> {
    const transport = getDBXTransport()
    if (transport) return transport.request<T>(url, options.method || 'GET', options.body instanceof FormData ? options.body : options.body ? JSON.parse(String(options.body)) : undefined)
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
      explicitClusterName ?? this.getCurrentCluster?.()
    )

    const defaultOptions: RequestInit = {
      credentials: 'include',
      headers,
      ...options,
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
      console.error('API request failed:', error)
      throw error
    }
  }

  async get<T>(url: string, options?: RequestInit): Promise<T> {
    return this.makeRequest<T>(url, { ...options, method: 'GET' })
  }

  async post<T>(
    url: string,
    data?: unknown,
    options?: RequestInit
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

  async put<T>(url: string, data?: unknown, options?: RequestInit): Promise<T> {
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

  async delete<T>(url: string, options?: RequestInit): Promise<T> {
    return this.makeRequest<T>(url, { ...options, method: 'DELETE' })
  }

  async patch<T>(
    url: string,
    data?: unknown,
    options?: RequestInit
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
