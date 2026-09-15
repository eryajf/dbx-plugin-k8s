import { describe, expect, it } from 'vitest'

import { getAnalyticsPageKey, getAnalyticsPageUrl } from './analytics-route'

describe('getAnalyticsPageKey', () => {
  it('maps static routes to stable page keys', () => {
    expect(getAnalyticsPageKey('/')).toBe('overview')
    expect(getAnalyticsPageKey('/dashboard')).toBe('overview')
    expect(getAnalyticsPageKey('/settings')).toBe('settings')
    expect(getAnalyticsPageKey('/favorites')).toBe('favorites')
    expect(getAnalyticsPageKey('/networking/advanced')).toBe(
      'networking/advanced'
    )
    expect(getAnalyticsPageKey('/ai-chat-box')).toBe('ai-chat')
  })

  it('maps resource list and detail routes without leaking object names', () => {
    expect(getAnalyticsPageKey('/pods')).toBe('pods/list')
    expect(getAnalyticsPageKey('/pods/default/nginx-7d8f9')).toBe('pods/detail')
    expect(getAnalyticsPageKey('/namespaces/kube-system')).toBe(
      'namespaces/detail'
    )
    expect(getAnalyticsPageKey('/deployments/prod/api-server')).toBe(
      'deployments/detail'
    )
  })

  it('maps CRD routes to shared analytics keys', () => {
    expect(getAnalyticsPageKey('/crds/networkpolicies')).toBe('crds/list')
    expect(getAnalyticsPageKey('/crds/widgets/default/demo')).toBe(
      'crds/detail'
    )
  })

  it('normalizes empty or trailing-slash paths', () => {
    expect(getAnalyticsPageKey('')).toBe('overview')
    expect(getAnalyticsPageKey('/services/')).toBe('services/list')
    expect(getAnalyticsPageKey('pods/default/demo')).toBe('pods/detail')
  })
})

describe('getAnalyticsPageUrl', () => {
  it('creates a synthetic analytics url from the page key', () => {
    expect(getAnalyticsPageUrl('pods/detail')).toBe('/pods/detail')
  })
})
