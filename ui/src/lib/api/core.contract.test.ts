import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  post: vi.fn(),
}))

vi.mock('../api-client', () => ({
  API_BASE_URL: '/api/v1',
  apiClient: mocks,
}))

import { fetchResource } from './core'

describe('resource API route GVR propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState({}, '', '/deployments/default/web?group=apps&version=v1beta1')
    mocks.get.mockResolvedValue({})
  })

  it('keeps the selected served version on detail reads', async () => {
    await fetchResource('deployments', 'web', 'default')
    expect(mocks.get).toHaveBeenCalledWith(
      '/deployments/default/web?group=apps&version=v1beta1',
      undefined
    )
  })
})
