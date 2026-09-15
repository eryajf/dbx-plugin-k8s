import { describe, expect, it, vi } from 'vitest'
import { clearDBXResourceDiscovery, resolveDBXResource } from './dbx-resource-discovery'
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
})
