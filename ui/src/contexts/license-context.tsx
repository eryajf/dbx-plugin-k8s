/* eslint-disable react-refresh/only-export-components */
import { createContext, ReactNode, useContext, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import {
  getLicenseFeatures,
  getLicenseStatus,
  syncLicense,
  type LicenseFeatureDefinition,
  type LicenseFeatureKey,
  type LicenseStatusResponse,
} from '@/lib/api/license'

interface LicenseContextValue {
  status?: LicenseStatusResponse
  featureMatrix: LicenseFeatureDefinition[]
  features: Set<LicenseFeatureKey>
  isLoading: boolean
  error: Error | null
  refresh: () => Promise<void>
}

const LicenseContext = createContext<LicenseContextValue | undefined>(undefined)
const licenseRefetchIntervalMs = 60_000

export function LicenseProvider({ children }: { children: ReactNode }) {
  const statusQuery = useQuery({
    queryKey: ['license', 'status'],
    queryFn: getLicenseStatus,
    staleTime: 0,
    refetchInterval: licenseRefetchIntervalMs,
    refetchOnWindowFocus: 'always',
  })

  const featuresQuery = useQuery({
    queryKey: ['license', 'features'],
    queryFn: getLicenseFeatures,
    staleTime: 0,
    refetchInterval: licenseRefetchIntervalMs,
    refetchOnWindowFocus: 'always',
  })

  const localStatus = statusQuery.data
  const shouldSyncCommercialState =
    localStatus?.edition === 'pro' ||
    localStatus?.status === 'grace' ||
    Boolean(
      localStatus?.licenseKeyHash ||
      localStatus?.licenseKeyInstanceId ||
      localStatus?.customerEmail ||
      localStatus?.productId
    )

  const syncQuery = useQuery({
    queryKey: ['license', 'sync'],
    queryFn: syncLicense,
    enabled: shouldSyncCommercialState,
    staleTime: 0,
    refetchInterval: shouldSyncCommercialState
      ? licenseRefetchIntervalMs
      : false,
    refetchOnWindowFocus: 'always',
  })

  const features = useMemo(
    () =>
      new Set<LicenseFeatureKey>(
        syncQuery.data?.features ??
          statusQuery.data?.features ??
          featuresQuery.data?.features ??
          []
      ),
    [
      featuresQuery.data?.features,
      statusQuery.data?.features,
      syncQuery.data?.features,
    ]
  )

  const status = syncQuery.data ?? statusQuery.data
  const featureMatrix = featuresQuery.data?.matrix ?? []
  const isLoading = statusQuery.isLoading || featuresQuery.isLoading
  const error =
    (statusQuery.error as Error | null) ??
    (featuresQuery.error as Error | null) ??
    (syncQuery.error as Error | null)
  const refreshStatus = statusQuery.refetch
  const refreshFeatures = featuresQuery.refetch
  const refreshSync = syncQuery.refetch

  const value = useMemo<LicenseContextValue>(
    () => ({
      status,
      featureMatrix,
      features,
      isLoading,
      error,
      refresh: async () => {
        await Promise.all([refreshStatus(), refreshFeatures(), refreshSync()])
      },
    }),
    [
      error,
      featureMatrix,
      features,
      isLoading,
      refreshFeatures,
      refreshStatus,
      refreshSync,
      status,
    ]
  )

  return (
    <LicenseContext.Provider value={value}>{children}</LicenseContext.Provider>
  )
}

export function useLicense() {
  const context = useContext(LicenseContext)
  if (!context) {
    throw new Error('useLicense must be used within a LicenseProvider')
  }
  return context
}

export function useFeature(feature: LicenseFeatureKey) {
  const context = useContext(LicenseContext)
  // Standalone previews have no license context. Missing capabilities remain
  // disabled; useLicense still requires a provider for full account access.
  if ((globalThis as unknown as {dbxPlugin?: unknown}).dbxPlugin) {
    return ['resource.batchActions', 'export.advanced', 'terminal.node', 'terminal.kubectl'].includes(feature)
  }
  return context?.features.has(feature) ?? false
}
