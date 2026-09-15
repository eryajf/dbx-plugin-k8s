import { apiClient } from '../api-client'
import { fetchAPI } from './shared'

export type LicenseStatus =
  | 'inactive'
  | 'active'
  | 'grace'
  | 'expired'
  | 'revoked'
  | 'invalid'

export type LicenseEdition = 'community' | 'pro'

export type LicenseFeatureKey =
  | 'ai.agent'
  | 'ai.sidecar'
  | 'terminal.kubectl'
  | 'terminal.node'
  | 'resource.batchActions'
  | 'resource.history.extended'
  | 'export.advanced'
  | 'updates.official'

export interface LicenseStatusResponse {
  status: LicenseStatus
  edition: LicenseEdition
  plan: LicenseEdition
  licenseKeyHash?: string
  licenseKeyInstanceId?: string
  deviceName?: string
  customerEmail?: string
  productId?: string
  activatedAt?: string
  lastValidatedAt?: string
  offlineValidUntil?: string
  expiresAt?: string
  features: LicenseFeatureKey[]
}

export interface LicenseFeatureDefinition {
  key: LicenseFeatureKey
  name: string
  description: string
  community: boolean
  pro: boolean
}

export interface LicenseFeaturesResponse {
  edition: LicenseEdition
  features: LicenseFeatureKey[]
  matrix: LicenseFeatureDefinition[]
}

export interface LicenseCheckoutResponse {
  checkoutUrl: string
  checkoutId?: string
  mode: 'license-service' | 'static'
  provider: string
  message?: string
}

export interface LicenseCheckoutAvailability {
  available: boolean
  mode?: 'license-service' | 'static'
  provider?: string
  source?: 'env' | 'build'
  configured: boolean
  serviceReady?: boolean
  serviceStatus?: string
  message?: string
}

export interface CreateLicenseCheckoutInput {
  plan?: LicenseEdition
  returnUrl?: string
  customerEmail?: string
}

export interface LicenseClaimInput {
  checkoutId?: string
  customerEmail?: string
  deviceName?: string
}

export interface LicenseClaimResponse {
  status: LicenseStatus
  plan: LicenseEdition
  ready: boolean
  licenseKeyPreview?: string
  licenseKeyInstanceId?: string
  customerId?: string
  customerEmail?: string
  productId?: string
  checkoutId?: string
  checkoutStatus?: string
  deliveryStatus?: string
  expiresAt?: string
  message?: string
  localStatus?: LicenseStatusResponse
}

export async function getLicenseStatus(): Promise<LicenseStatusResponse> {
  return fetchAPI<LicenseStatusResponse>('/license/status')
}

export async function getLicenseFeatures(): Promise<LicenseFeaturesResponse> {
  return fetchAPI<LicenseFeaturesResponse>('/license/features')
}

export async function getLicenseCheckoutAvailability(): Promise<LicenseCheckoutAvailability> {
  return fetchAPI<LicenseCheckoutAvailability>('/license/checkout/status')
}

export async function createLicenseCheckout(
  input: LicenseEdition | CreateLicenseCheckoutInput = 'pro'
): Promise<LicenseCheckoutResponse> {
  const payload =
    typeof input === 'string'
      ? {
          plan: input,
        }
      : {
          plan: input.plan ?? 'pro',
          returnUrl: input.returnUrl,
          customerEmail: input.customerEmail,
        }
  return await apiClient.post<LicenseCheckoutResponse>('/license/checkout', {
    ...payload,
  })
}

export async function claimPurchasedLicense(
  input: LicenseClaimInput
): Promise<LicenseClaimResponse> {
  return await apiClient.post<LicenseClaimResponse>('/license/claim', input)
}

export async function activateLicense(
  licenseKey: string
): Promise<LicenseStatusResponse> {
  return await apiClient.post<LicenseStatusResponse>('/license/activate', {
    licenseKey,
  })
}

export async function validateLicense(): Promise<LicenseStatusResponse> {
  return await apiClient.post<LicenseStatusResponse>('/license/validate')
}

export async function syncLicense(): Promise<LicenseStatusResponse> {
  return await apiClient.post<LicenseStatusResponse>('/license/sync')
}

export async function deactivateLicense(): Promise<LicenseStatusResponse> {
  return await apiClient.post<LicenseStatusResponse>('/license/deactivate')
}
