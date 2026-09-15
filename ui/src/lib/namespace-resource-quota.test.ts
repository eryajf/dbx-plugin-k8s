import type { ResourceQuota } from 'kubernetes-types/core/v1'
import { describe, expect, it } from 'vitest'

import {
  composeQuotaValue,
  NAMESPACE_RESOURCE_QUOTA_KEY_OPTIONS,
  parseQuotaValue,
  quotaEntriesToHardRecord,
  resourceQuotaToEntries,
} from './namespace-resource-quota'

describe('namespace-resource-quota', () => {
  it('exposes common namespace resource quota keys', () => {
    expect(
      NAMESPACE_RESOURCE_QUOTA_KEY_OPTIONS.map((option) => option.value)
    ).toEqual(
      expect.arrayContaining([
        'limits.cpu',
        'limits.memory',
        'requests.cpu',
        'requests.memory',
        'pods',
        'services',
        'persistentvolumeclaims',
        'requests.storage',
      ])
    )
  })

  it('maps existing hard quota values into editable entries', () => {
    const quota = {
      spec: {
        hard: {
          'limits.cpu': '4',
          'requests.memory': '8Gi',
          'count/deployments.apps': '20',
        },
      },
    } as ResourceQuota

    const entries = resourceQuotaToEntries(quota)

    expect(entries).toEqual(
      expect.arrayContaining([
        {
          key: 'count/deployments.apps',
          value: '20',
          isCustomKey: false,
        },
        {
          key: 'limits.cpu',
          value: '4',
          isCustomKey: false,
        },
        {
          key: 'requests.memory',
          value: '8Gi',
          isCustomKey: false,
        },
      ])
    )
    expect(entries.find((entry) => entry.key === 'pods')).toEqual({
      key: 'pods',
      value: '',
      isCustomKey: false,
    })
  })

  it('builds hard record from non-empty entries only', () => {
    expect(
      quotaEntriesToHardRecord([
        {
          key: 'limits.cpu',
          value: '4',
          isCustomKey: false,
        },
        {
          key: 'requests.memory',
          value: '  ',
          isCustomKey: false,
        },
        {
          key: '',
          value: '5',
          isCustomKey: true,
        },
      ])
    ).toEqual({
      'limits.cpu': '4',
    })
  })

  it('parses and composes cpu and memory quota values with units', () => {
    expect(parseQuotaValue('limits.cpu', '500m')).toEqual({
      amount: '500',
      unit: 'm',
    })
    expect(parseQuotaValue('limits.cpu', '2')).toEqual({
      amount: '2',
      unit: 'core',
    })
    expect(parseQuotaValue('requests.memory', '8Gi')).toEqual({
      amount: '8',
      unit: 'Gi',
    })
    expect(parseQuotaValue('pods', '12')).toEqual({
      amount: '12',
      unit: 'count',
    })

    expect(composeQuotaValue('limits.cpu', '2', 'core')).toBe('2')
    expect(composeQuotaValue('limits.cpu', '500', 'm')).toBe('500m')
    expect(composeQuotaValue('requests.memory', '8', 'Gi')).toBe('8Gi')
    expect(composeQuotaValue('pods', '12', 'count')).toBe('12')
  })
})
