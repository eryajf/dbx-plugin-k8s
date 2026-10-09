import type { DBXResourceDescriptor } from '@/lib/dbx-resource-discovery'

export const FLUX_GROUP_ID = 'sidebar-groups-flux'
export const FLUX_GROUP_NAME_KEY = 'sidebar.groups.flux'

export interface FluxNavItem {
  id: string
  titleKey: string
  url: string
  icon: string
  group: string
  version: string
  resource: string
  kind: string
}

// Supported Flux kinds, in display order. The API version is deliberately not
// listed here: it always comes from cluster discovery.
const FLUX_KINDS: ReadonlyArray<{ group: string; kind: string }> = [
  { group: 'source.toolkit.fluxcd.io', kind: 'GitRepository' },
  { group: 'source.toolkit.fluxcd.io', kind: 'OCIRepository' },
  { group: 'source.toolkit.fluxcd.io', kind: 'HelmRepository' },
  { group: 'source.toolkit.fluxcd.io', kind: 'Bucket' },
  { group: 'source.toolkit.fluxcd.io', kind: 'ExternalArtifact' },
  { group: 'kustomize.toolkit.fluxcd.io', kind: 'Kustomization' },
  { group: 'helm.toolkit.fluxcd.io', kind: 'HelmRelease' },
  { group: 'image.toolkit.fluxcd.io', kind: 'ImageRepository' },
  { group: 'image.toolkit.fluxcd.io', kind: 'ImagePolicy' },
  { group: 'image.toolkit.fluxcd.io', kind: 'ImageUpdateAutomation' },
  { group: 'notification.toolkit.fluxcd.io', kind: 'Alert' },
  { group: 'notification.toolkit.fluxcd.io', kind: 'Provider' },
  { group: 'notification.toolkit.fluxcd.io', kind: 'Receiver' },
]

// Higher is preferred: GA over beta over alpha, then newer major/minor.
function versionRank(version: string): number {
  const match = /^v(\d+)(?:(alpha|beta)(\d+))?$/.exec(version)
  if (!match) return -1
  const stability = match[2] === 'alpha' ? 0 : match[2] === 'beta' ? 1 : 2
  return stability * 1e9 + Number(match[1]) * 1e6 + Number(match[3] || 0)
}

/**
 * Build Flux navigation items from discovered resources. Only supported kinds
 * that the cluster actually serves (and the user can list) are returned.
 */
export function buildFluxNavItems(
  resources: readonly DBXResourceDescriptor[] | undefined
): FluxNavItem[] {
  if (!resources?.length) return []
  const items: FluxNavItem[] = []
  for (const { group, kind } of FLUX_KINDS) {
    const best = resources
      .filter(
        (r) =>
          r.group === group &&
          r.kind === kind &&
          !r.resource.includes('/') &&
          (!r.verbs || r.verbs.includes('list'))
      )
      .sort((a, b) => versionRank(b.version) - versionRank(a.version))[0]
    if (!best) continue
    const crdName = `${best.resource}.${best.group}`
    items.push({
      id: `${FLUX_GROUP_ID}-${best.resource}`,
      titleKey: `flux.kinds.${kind}`,
      url: `/crds/${crdName}?group=${encodeURIComponent(best.group)}&version=${encodeURIComponent(best.version)}`,
      icon: 'IconGitBranch',
      group: best.group,
      version: best.version,
      resource: best.resource,
      kind,
    })
  }
  return items
}
