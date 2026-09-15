import { render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LicenseProvider, useFeature, useLicense } from './license-context'

const useQueryMock = vi.fn()

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => useQueryMock(options),
}))

vi.mock('@/lib/api/license', () => ({
  getLicenseFeatures: vi.fn(),
  getLicenseStatus: vi.fn(),
  syncLicense: vi.fn(),
}))

function Probe() {
  const { status, refresh } = useLicense()
  const canUseAI = useFeature('ai.agent')
  return (
    <button type="button" onClick={() => void refresh()}>
      {status?.edition}:{String(canUseAI)}
    </button>
  )
}

describe('LicenseProvider', () => {
  it('disables features without a provider', () => {
    const { result } = renderHook(() => useFeature('ai.agent'))
    expect(result.current).toBe(false)
  })
  beforeEach(() => {
    useQueryMock.mockReset()
    useQueryMock.mockImplementation((options: { queryKey: string[] }) => {
      if (options.queryKey[1] === 'status') {
        return {
          data: {
            edition: 'pro',
            status: 'active',
            licenseKeyHash: 'hash',
            features: [],
          },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        }
      }
      if (options.queryKey[1] === 'sync') {
        return {
          data: {
            edition: 'pro',
            status: 'active',
            features: ['ai.agent'],
          },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        }
      }
      return {
        data: {
          features: [],
          matrix: [],
        },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      }
    })
  })

  it('refreshes license state frequently so FeatureGate follows subscription changes', () => {
    render(
      <LicenseProvider>
        <Probe />
      </LicenseProvider>
    )

    expect(screen.getByRole('button', { name: 'pro:true' })).toBeInTheDocument()
    expect(useQueryMock).toHaveBeenCalledTimes(3)

    for (const options of useQueryMock.mock.calls.map(([value]) => value)) {
      expect(options).toMatchObject({
        staleTime: 0,
        refetchOnWindowFocus: 'always',
      })
    }

    expect(useQueryMock.mock.calls.map(([value]) => value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          queryKey: ['license', 'status'],
          refetchInterval: 60_000,
        }),
        expect.objectContaining({
          queryKey: ['license', 'features'],
          refetchInterval: 60_000,
        }),
        expect.objectContaining({
          queryKey: ['license', 'sync'],
          enabled: true,
          refetchInterval: 60_000,
        }),
      ])
    )
  })

  it('does not poll commercial sync before a local license exists', () => {
    useQueryMock.mockImplementation((options: { queryKey: string[] }) => {
      if (options.queryKey[1] === 'status') {
        return {
          data: {
            edition: 'community',
            status: 'inactive',
            features: [],
          },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        }
      }
      return {
        data: {
          features: [],
          matrix: [],
        },
        isLoading: false,
        error: null,
        refetch: vi.fn(),
      }
    })

    render(
      <LicenseProvider>
        <Probe />
      </LicenseProvider>
    )

    expect(useQueryMock.mock.calls.map(([value]) => value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          queryKey: ['license', 'sync'],
          enabled: false,
          refetchInterval: false,
        }),
      ])
    )
  })
})
