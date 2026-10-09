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
    const invoke = vi.fn().mockResolvedValue({resources:[]}); await expect(resolveDBXResource('c','widgets.example.com',invoke)).rejects.toThrow('not discovered')
    clearDBXResourceDiscovery('c'); expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('loads stable resources without waiting for unrelated discovery', async () => {
    const invoke = vi.fn(() => new Promise<never>(() => {}))
    expect(await resolveDBXResource('fast', 'pods', invoke)).toMatchObject({ group: '', version: 'v1', namespaced: true })
    expect(await resolveDBXResource('fast', 'nodes', invoke)).toMatchObject({ group: '', version: 'v1', namespaced: false })
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each([
    ['cronjobs', 'CronJob', 'batch', 'v1beta1'],
    ['deployments', 'Deployment', 'apps', 'v1beta1'],
    ['statefulsets', 'StatefulSet', 'apps', 'v1beta1'],
    ['daemonsets', 'DaemonSet', 'extensions', 'v1beta1'],
    ['replicasets', 'ReplicaSet', 'extensions', 'v1beta1'],
    ['jobs', 'Job', 'batch', 'v1'],
  ])('resolves %s using the version served by the cluster', async (resource, kind, group, version) => {
    const descriptor = { resource, kind, group, version, namespaced: true }
    const invoke = vi.fn().mockResolvedValue({ resources: [descriptor] })
    const connection = `served-${resource}`
    clearDBXResourceDiscovery(connection)
    expect(await resolveDBXResource(connection, resource, invoke)).toMatchObject(descriptor)
    expect(await resolveDBXResource(connection, kind, invoke)).toMatchObject(descriptor)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('honors explicit CronJob versions and rejects an unserved version', async () => {
    const connection = 'cronjob-versions'
    clearDBXResourceDiscovery(connection)
    const invoke = vi.fn().mockResolvedValue({ resources: ['v1beta1', 'v1'].map(version => ({
      group: 'batch', version, resource: 'cronjobs', kind: 'CronJob', namespaced: true,
    })) })
    for (const version of ['v1', 'v1beta1']) {
      expect(await resolveDBXResource(connection, 'cronjobs', invoke, { group: 'batch', version }))
        .toMatchObject({ group: 'batch', version, resource: 'cronjobs' })
    }
    await expect(resolveDBXResource(connection, 'cronjobs', invoke, { group: 'batch', version: 'v2' }))
      .rejects.toThrow('not discovered')
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
