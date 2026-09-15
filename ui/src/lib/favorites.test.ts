import { describe, expect, it } from 'vitest'

import {
  buildFavoriteKeyFromResource,
  buildFavoriteResourceKey,
  getFavoriteResourceName,
} from './favorites'

describe('favorites helpers', () => {
  it('prefers resourceName over name when deriving resource names', () => {
    expect(
      getFavoriteResourceName({
        name: 'legacy-name',
        resourceName: 'canonical-name',
        resourceType: 'pods',
      })
    ).toBe('canonical-name')
  })

  it('builds normalized favorite resource keys', () => {
    expect(
      buildFavoriteResourceKey(' Deployments ', ' default ', ' nginx ')
    ).toBe('deployments::default::nginx')
  })

  it('builds a favorite key from resource-like inputs', () => {
    expect(
      buildFavoriteKeyFromResource({
        resourceType: 'services',
        namespace: 'prod',
        name: 'api-service',
      })
    ).toBe('services::prod::api-service')
  })
})
