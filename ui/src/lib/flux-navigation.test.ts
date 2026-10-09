import { describe, expect, it } from 'vitest'

import type { DBXResourceDescriptor } from './dbx-resource-discovery'
import { buildFluxNavItems } from './flux-navigation'

const FLUX: Array<[string, string, string, string]> = [
  ['source.toolkit.fluxcd.io', 'GitRepository', 'gitrepositories', 'v1'],
  ['source.toolkit.fluxcd.io', 'OCIRepository', 'ocirepositories', 'v1'],
  ['source.toolkit.fluxcd.io', 'HelmRepository', 'helmrepositories', 'v1'],
  ['source.toolkit.fluxcd.io', 'Bucket', 'buckets', 'v1'],
  ['source.toolkit.fluxcd.io', 'ExternalArtifact', 'externalartifacts', 'v1'],
  ['kustomize.toolkit.fluxcd.io', 'Kustomization', 'kustomizations', 'v1'],
  ['helm.toolkit.fluxcd.io', 'HelmRelease', 'helmreleases', 'v2'],
  ['image.toolkit.fluxcd.io', 'ImageRepository', 'imagerepositories', 'v1'],
  ['image.toolkit.fluxcd.io', 'ImagePolicy', 'imagepolicies', 'v1'],
  ['image.toolkit.fluxcd.io', 'ImageUpdateAutomation', 'imageupdateautomations', 'v1'],
  ['notification.toolkit.fluxcd.io', 'Alert', 'alerts', 'v1beta3'],
  ['notification.toolkit.fluxcd.io', 'Provider', 'providers', 'v1beta3'],
  ['notification.toolkit.fluxcd.io', 'Receiver', 'receivers', 'v1'],
]

const descriptor = (
  group: string,
  kind: string,
  resource: string,
  version: string,
  extra: Partial<DBXResourceDescriptor> = {}
): DBXResourceDescriptor => ({
  group,
  kind,
  resource,
  version,
  namespaced: true,
  verbs: ['get', 'list', 'watch'],
  ...extra,
})

const allFlux = () => FLUX.map((f) => descriptor(...f))

describe('buildFluxNavItems', () => {
  it('returns all 13 supported Flux kinds in display order', () => {
    const items = buildFluxNavItems(allFlux())
    expect(items.map((i) => i.kind)).toEqual(FLUX.map((f) => f[1]))
    expect(new Set(items.map((i) => i.id)).size).toBe(13)
  })

  it('routes through the generic CRD path with discovered group/version', () => {
    const [git] = buildFluxNavItems(allFlux())
    expect(git.url).toBe(
      '/crds/gitrepositories.source.toolkit.fluxcd.io?group=source.toolkit.fluxcd.io&version=v1'
    )
    expect(git.titleKey).toBe('flux.kinds.GitRepository')
  })

  it('returns nothing when Flux is not installed or discovery is empty', () => {
    expect(buildFluxNavItems([descriptor('', 'Pod', 'pods', 'v1')])).toEqual([])
    expect(buildFluxNavItems([])).toEqual([])
    expect(buildFluxNavItems(undefined)).toEqual([])
  })

  it('prefers GA over beta and picks the newest stable version', () => {
    const items = buildFluxNavItems([
      descriptor('helm.toolkit.fluxcd.io', 'HelmRelease', 'helmreleases', 'v2beta2'),
      descriptor('helm.toolkit.fluxcd.io', 'HelmRelease', 'helmreleases', 'v2'),
      descriptor('helm.toolkit.fluxcd.io', 'HelmRelease', 'helmreleases', 'v2beta1'),
    ])
    expect(items).toHaveLength(1)
    expect(items[0].version).toBe('v2')
  })

  it('prefers a stable API over a newer-major beta API', () => {
    const items = buildFluxNavItems([
      descriptor('helm.toolkit.fluxcd.io', 'HelmRelease', 'helmreleases', 'v3beta1'),
      descriptor('helm.toolkit.fluxcd.io', 'HelmRelease', 'helmreleases', 'v2'),
    ])
    expect(items[0].version).toBe('v2')
  })

  it('falls back to the version the cluster serves rather than a hardcoded one', () => {
    const items = buildFluxNavItems([
      descriptor('source.toolkit.fluxcd.io', 'GitRepository', 'gitrepositories', 'v1beta2'),
    ])
    expect(items[0].version).toBe('v1beta2')
  })

  it('skips non-listable API resources and subresources', () => {
    const items = buildFluxNavItems([
      descriptor('source.toolkit.fluxcd.io', 'GitRepository', 'gitrepositories', 'v1', {
        verbs: ['get'],
      }),
      descriptor('kustomize.toolkit.fluxcd.io', 'Kustomization', 'kustomizations/status', 'v1'),
    ])
    expect(items).toEqual([])
  })

  it('ignores same-kind resources from foreign groups', () => {
    expect(
      buildFluxNavItems([descriptor('example.com', 'GitRepository', 'gitrepositories', 'v1')])
    ).toEqual([])
  })
})
