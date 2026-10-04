import { describe, expect, it, vi } from 'vitest'
import {
  clearDBXResourceDiscovery,
  getDBXResourceIdentity,
  getDBXResourceIdentityForCRD,
  getDBXResourcePath,
  resolveDBXResource,
} from './dbx-resource-discovery'
describe('DBX resource discovery', () => {
  it('resolves discovered resources and caches per connection', async () => {
    const invoke = vi.fn().mockResolvedValue({ resources: [{ group:'apps', version:'v1', resource:'deployments', kind:'Deployment', namespaced:true, aliases:['deploy'] }] })
    expect(await resolveDBXResource('c1','deploy',invoke)).toMatchObject({group:'apps',resource:'deployments'})
    await resolveDBXResource('c1','deployments',invoke); expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('rejects unknown resources and supports clearing', async () => {
    const invoke = vi.fn().mockResolvedValue({resources:[]}); await expect(resolveDBXResource('c','pods',invoke)).rejects.toThrow('not discovered')
    clearDBXResourceDiscovery('c'); expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('keeps built-in resource routes plain and qualifies custom resources', () => {
    expect(getDBXResourceIdentity({ group: 'apps', version: 'v1', resource: 'deployments' })).toEqual({
      resourceType: 'deployments',
      customResource: false,
    })
    expect(getDBXResourceIdentity({ group: 'autoscaling', version: 'v1', resource: 'horizontalpodautoscalers' })).toEqual({
      resourceType: 'horizontalpodautoscalers',
      customResource: false,
    })
    expect(getDBXResourceIdentityForCRD({
      group: 'gateway.networking.k8s.io',
      version: 'v1',
      plural: 'gateways',
    })).toEqual({
      resourceType: 'gateways',
      customResource: false,
    })
    expect(getDBXResourceIdentity({ group: 'example.com', version: 'v1', resource: 'widgets' })).toEqual({
      resourceType: 'widgets.example.com',
      customResource: true,
    })
    expect(getDBXResourceIdentityForCRD({
      group: 'example.com',
      version: 'v1',
      plural: 'widgets',
    })).toEqual({
      resourceType: 'widgets.example.com',
      customResource: true,
    })
    expect(getDBXResourcePath({
      resourceType: 'widgets.example.com',
      customResource: true,
      namespace: 'default',
      name: 'widget/one',
    })).toBe('/crds/widgets.example.com/default/widget%2Fone')
    expect(getDBXResourcePath({
      resourceType: 'deployments',
      namespace: 'default',
      name: 'web',
      group: 'apps',
      version: 'v1',
    })).toBe('/deployments/default/web?group=apps&version=v1')
  })
})
