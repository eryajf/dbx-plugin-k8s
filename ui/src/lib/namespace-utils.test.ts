import type { Namespace, ResourceQuota } from 'kubernetes-types/core/v1'
import { describe, expect, it } from 'vitest'

import {
  findPrimaryResourceQuota,
  formatMetadataSummaryItems,
  getNamespaceQuotaSummary,
} from './namespace-utils'

describe('namespace-utils', () => {
  it('prefers status hard values when deriving namespace quota summary', () => {
    const quota = {
      metadata: {
        name: 'team-a-quota',
        namespace: 'team-a',
      },
      spec: {
        hard: {
          'limits.cpu': '2',
          'limits.memory': '4Gi',
        },
      },
      status: {
        hard: {
          'limits.cpu': '4',
          'limits.memory': '8Gi',
        },
      },
    } as ResourceQuota

    expect(getNamespaceQuotaSummary(quota)).toEqual({
      cpuLimit: '4',
      memoryLimit: '8Gi',
    })
  })

  it('selects the only resource quota in a namespace for quick editing', () => {
    const namespace = {
      metadata: {
        name: 'team-a',
      },
    } as Namespace

    const quotas = [
      {
        metadata: {
          name: 'team-a-quota',
          namespace: 'team-a',
        },
      },
    ] as ResourceQuota[]

    expect(findPrimaryResourceQuota(namespace, quotas)?.metadata?.name).toBe(
      'team-a-quota'
    )
  })

  it('returns no editable resource quota when multiple quotas exist', () => {
    const namespace = {
      metadata: {
        name: 'team-a',
      },
    } as Namespace

    const quotas = [
      {
        metadata: {
          name: 'team-a-quota-a',
          namespace: 'team-a',
        },
      },
      {
        metadata: {
          name: 'team-a-quota-b',
          namespace: 'team-a',
        },
      },
    ] as ResourceQuota[]

    expect(findPrimaryResourceQuota(namespace, quotas)).toBeNull()
  })

  it('formats metadata summaries with truncation markers', () => {
    expect(
      formatMetadataSummaryItems({
        env: 'prod',
        owner: 'platform',
        tier: 'backend',
      })
    ).toEqual({
      primaryItems: ['env=prod'],
      overflowCount: 2,
    })
  })
})
