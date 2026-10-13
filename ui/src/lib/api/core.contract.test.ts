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

import { fetchResource, getImageTags } from './core'

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

describe('image tag API response boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not request tags for an empty image', async () => {
    await expect(getImageTags('')).resolves.toEqual([])
    expect(mocks.get).not.toHaveBeenCalled()
  })

  it('encodes the image reference and preserves valid suggestions', async () => {
    const tags = [{ name: 'v1', timestamp: '2026-10-13T00:00:00Z' }]
    mocks.get.mockResolvedValue(tags)
    await expect(getImageTags('registry.example:5000/team/app')).resolves.toEqual(tags)
    expect(mocks.get).toHaveBeenCalledWith('/image/tags?image=registry.example%3A5000%2Fteam%2Fapp')
  })

  it.each([{}, { items: [{ name: 'resource' }] }, '<html>error</html>', null, undefined])(
    'returns no suggestions for a malformed response: %j', async (response) => {
      mocks.get.mockResolvedValue(response)
      await expect(getImageTags('nginx')).resolves.toEqual([])
    }
  )

  it('normalizes individual entries before they enter the query cache', async () => {
    mocks.get.mockResolvedValue([null, { name: 1 }, { name: 'v1', timestamp: 'invalid' }])
    await expect(getImageTags('nginx')).resolves.toEqual([{ name: 'v1' }])
  })

  it('preserves request errors for the editor to handle', async () => {
    mocks.get.mockRejectedValue(new Error('tags unavailable'))
    await expect(getImageTags('nginx')).rejects.toThrow('tags unavailable')
  })
})
