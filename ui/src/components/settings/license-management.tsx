import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconCircleCheck,
  IconInfoCircle,
  IconKey,
  IconRefresh,
  IconShoppingCart,
} from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  activateLicense,
  claimPurchasedLicense,
  createLicenseCheckout,
  deactivateLicense,
  getLicenseCheckoutAvailability,
  syncLicense,
  type LicenseFeatureDefinition,
} from '@/lib/api/license'
import { openURL } from '@/lib/desktop'
import { useLicense } from '@/hooks/use-license'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

function DetailRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <span className="text-right text-sm break-all">
        {value && value.trim() ? value : '-'}
      </span>
    </div>
  )
}

function formatTime(value: string | undefined, emptyValue: string) {
  if (!value) {
    return emptyValue
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString()
}

function featureEnabledInCommunity(feature: LicenseFeatureDefinition) {
  return feature.community
}

function isValidEmail(value: string) {
  const trimmed = value.trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
}

function isDodoCheckoutURL(value: string) {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'dodopayments.com' ||
        url.hostname.endsWith('.dodopayments.com'))
    )
  } catch {
    return false
  }
}

const automaticClaimAttempts = 12
const automaticClaimIntervalMs = 10_000
const pendingCheckoutStorageKey = 'kite-license-pending-checkout'

interface PendingCheckoutState {
  checkoutId?: string
  customerEmail?: string
  startedAt?: string
}

function loadPendingCheckout(): PendingCheckoutState | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    const raw = window.localStorage.getItem(pendingCheckoutStorageKey)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as PendingCheckoutState
    if (!parsed.checkoutId && !isValidEmail(parsed.customerEmail ?? '')) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function savePendingCheckout(value: PendingCheckoutState) {
  if (typeof window === 'undefined') {
    return
  }
  window.localStorage.setItem(pendingCheckoutStorageKey, JSON.stringify(value))
}

function clearPendingCheckout() {
  if (typeof window === 'undefined') {
    return
  }
  window.localStorage.removeItem(pendingCheckoutStorageKey)
}

export function LicenseManagement() {
  const { t } = useTranslation()
  const { status, featureMatrix, features, isLoading, error, refresh } =
    useLicense()
  const checkoutAvailabilityQuery = useQuery({
    queryKey: ['license', 'checkout', 'status'],
    queryFn: getLicenseCheckoutAvailability,
  })
  const [licenseKey, setLicenseKey] = useState('')
  const [checkoutEmail, setCheckoutEmail] = useState('')
  const [checkoutId, setCheckoutId] = useState('')
  const [checkoutStarted, setCheckoutStarted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const automaticClaimAttemptsRef = useRef(0)
  const automaticClaimInFlightRef = useRef(false)
  const automaticClaimSuccessRef = useRef(false)
  const checkoutAvailability = checkoutAvailabilityQuery.data
  const checkoutConfigured = checkoutAvailability?.available === true
  const checkoutStatusLoading = checkoutAvailabilityQuery.isLoading

  const unlockedFeatures = useMemo(
    () => featureMatrix.filter((feature) => features.has(feature.key)),
    [featureMatrix, features]
  )
  const proOnlyFeatures = useMemo(
    () =>
      featureMatrix.filter((feature) => !featureEnabledInCommunity(feature)),
    [featureMatrix]
  )

  useEffect(() => {
    const pendingCheckout = loadPendingCheckout()
    if (!pendingCheckout) {
      return
    }
    if (pendingCheckout.checkoutId) {
      setCheckoutId(pendingCheckout.checkoutId)
    }
    if (!checkoutEmail.trim() && pendingCheckout.customerEmail) {
      setCheckoutEmail(pendingCheckout.customerEmail)
    }
    setCheckoutStarted(true)
    // Only restore once on mount; later edits are controlled by local state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (checkoutEmail.trim() || !status?.customerEmail) {
      return
    }
    setCheckoutEmail(status.customerEmail)
  }, [checkoutEmail, status?.customerEmail])

  const claimLicense = useCallback(async () => {
    const claim = await claimPurchasedLicense({
      checkoutId: checkoutId || undefined,
      customerEmail: isValidEmail(checkoutEmail)
        ? checkoutEmail.trim()
        : undefined,
    })
    if (claim.ready) {
      await refresh()
    }
    return claim
  }, [checkoutEmail, checkoutId, refresh])

  async function runLicenseAction(
    action: () => Promise<unknown>,
    successMessage: string
  ) {
    setSubmitting(true)
    try {
      await action()
      await refresh()
      toast.success(successMessage)
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t(
              'licenseManagement.messages.requestFailed',
              'License request failed'
            )
      toast.error(message)
      await refresh()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleBuyPro() {
    if (!isValidEmail(checkoutEmail)) {
      toast.error(
        t(
          'licenseManagement.messages.checkoutEmailRequired',
          'Enter a valid email before purchasing Pro'
        )
      )
      return
    }
    setSubmitting(true)
    try {
      const checkout = await createLicenseCheckout({
        plan: 'pro',
        customerEmail: checkoutEmail.trim(),
      })
      if (!isDodoCheckoutURL(checkout.checkoutUrl)) {
        throw new Error(
          t(
            'licenseManagement.messages.invalidCheckoutUrl',
            'Pro checkout is misconfigured. Refusing to open a non-Dodo checkout URL.'
          )
        )
      }
      await openURL(checkout.checkoutUrl)
      setCheckoutId(checkout.checkoutId ?? '')
      setCheckoutStarted(true)
      savePendingCheckout({
        checkoutId: checkout.checkoutId,
        customerEmail: checkoutEmail.trim(),
        startedAt: new Date().toISOString(),
      })
      toast.success(
        checkout.message ||
          t('licenseManagement.messages.checkoutOpened', 'Pro checkout opened')
      )
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t(
              'licenseManagement.messages.checkoutFailed',
              'Failed to open Pro checkout'
            )
      toast.error(message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleClaimLicense() {
    if (!checkoutId && !isValidEmail(checkoutEmail)) {
      toast.error(
        t(
          'licenseManagement.messages.claimReferenceRequired',
          'Enter the checkout email or start a checkout before claiming the license'
        )
      )
      return
    }
    setSubmitting(true)
    try {
      const claim = await claimLicense()
      if (!claim.ready) {
        toast.error(
          claim.message ||
            t(
              'licenseManagement.messages.claimNotReady',
              'License is not ready yet. Wait for Dodo delivery and try again.'
            )
        )
        return
      }
      clearPendingCheckout()
      await refresh()
      toast.success(
        claim.message ||
          t(
            'licenseManagement.messages.claimed',
            'License claimed and activated'
          )
      )
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : t(
              'licenseManagement.messages.claimFailed',
              'Failed to claim purchased license'
            )
      toast.error(message)
      await refresh()
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    automaticClaimAttemptsRef.current = 0
    automaticClaimInFlightRef.current = false
    automaticClaimSuccessRef.current = false
  }, [checkoutId])

  useEffect(() => {
    if (
      !checkoutStarted ||
      !checkoutConfigured ||
      status?.edition === 'pro' ||
      (!checkoutId && !isValidEmail(checkoutEmail))
    ) {
      return
    }

    const timer = window.setInterval(() => {
      if (
        automaticClaimInFlightRef.current ||
        automaticClaimSuccessRef.current ||
        automaticClaimAttemptsRef.current >= automaticClaimAttempts
      ) {
        if (automaticClaimAttemptsRef.current >= automaticClaimAttempts) {
          window.clearInterval(timer)
        }
        return
      }

      automaticClaimAttemptsRef.current += 1
      automaticClaimInFlightRef.current = true
      void claimLicense()
        .then((claim) => {
          if (!claim.ready) {
            return
          }
          automaticClaimSuccessRef.current = true
          clearPendingCheckout()
          window.clearInterval(timer)
          toast.success(
            claim.message ||
              t(
                'licenseManagement.messages.claimed',
                'License claimed and activated'
              )
          )
        })
        .catch(() => {
          // Keep polling quietly; the manual Claim License action shows errors.
        })
        .finally(() => {
          automaticClaimInFlightRef.current = false
        })
    }, automaticClaimIntervalMs)

    return () => window.clearInterval(timer)
  }, [
    checkoutConfigured,
    checkoutEmail,
    checkoutId,
    checkoutStarted,
    claimLicense,
    status?.edition,
    t,
  ])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <IconKey className="h-5 w-5" />
          {t('licenseManagement.title', 'License')}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-5">
        {error ? (
          <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
            {t(
              'licenseManagement.messages.loadFailed',
              'Failed to load license status'
            )}
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          <DetailRow
            label={t('licenseManagement.fields.edition', 'Edition')}
            value={status?.edition ?? (isLoading ? '...' : 'community')}
          />
          <DetailRow
            label={t('licenseManagement.fields.status', 'Status')}
            value={status?.status ?? (isLoading ? '...' : 'inactive')}
          />
          <DetailRow
            label={t('licenseManagement.fields.plan', 'Plan')}
            value={status?.plan ?? (isLoading ? '...' : 'community')}
          />
          <DetailRow
            label={t(
              'licenseManagement.fields.customerEmail',
              'Customer Email'
            )}
            value={status?.customerEmail}
          />
          <DetailRow
            label={t('licenseManagement.fields.device', 'Activated Device')}
            value={status?.deviceName}
          />
          <DetailRow
            label={t(
              'licenseManagement.fields.lastValidatedAt',
              'Last Validated'
            )}
            value={formatTime(status?.lastValidatedAt, '-')}
          />
          <DetailRow
            label={t(
              'licenseManagement.fields.offlineValidUntil',
              'Offline Grace Until'
            )}
            value={formatTime(status?.offlineValidUntil, '-')}
          />
          <DetailRow
            label={t('licenseManagement.fields.expiresAt', 'Expires At')}
            value={formatTime(status?.expiresAt, '-')}
          />
        </div>

        <div className="space-y-2">
          <Label>
            {t('licenseManagement.features.unlocked', 'Unlocked Features')}
          </Label>
          <div className="flex flex-wrap gap-2">
            {unlockedFeatures.length > 0 ? (
              unlockedFeatures.map((feature) => (
                <Badge key={feature.key} variant="secondary">
                  <IconCircleCheck className="h-3 w-3" />
                  {feature.name}
                </Badge>
              ))
            ) : (
              <span className="text-sm text-muted-foreground">
                {t(
                  'licenseManagement.features.communityOnly',
                  'Community core features are available. Pro features are not unlocked.'
                )}
              </span>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label>
            {t('licenseManagement.features.pro', 'Pro Feature Matrix')}
          </Label>
          <div className="grid gap-2 md:grid-cols-2">
            {proOnlyFeatures.map((feature) => (
              <div
                key={feature.key}
                className="flex items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">{feature.name}</div>
                  <div className="text-xs text-muted-foreground break-words">
                    {feature.key}
                  </div>
                </div>
                <Badge
                  variant={features.has(feature.key) ? 'default' : 'outline'}
                >
                  {features.has(feature.key)
                    ? t('licenseManagement.features.enabled', 'Enabled')
                    : t('licenseManagement.features.proOnly', 'Pro')}
                </Badge>
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <Input
            value={licenseKey}
            onChange={(event) => setLicenseKey(event.target.value)}
            placeholder={t(
              'licenseManagement.input.placeholder',
              'Paste your license key'
            )}
          />
          <Button
            onClick={() =>
              runLicenseAction(
                async () => {
                  await activateLicense(licenseKey)
                  setLicenseKey('')
                },
                t('licenseManagement.messages.activated', 'License activated')
              )
            }
            disabled={submitting || licenseKey.trim().length === 0}
          >
            <IconKey className="mr-2 h-4 w-4" />
            {t('licenseManagement.actions.activate', 'Activate')}
          </Button>
        </div>

        {checkoutStarted ? (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
            <div className="font-medium">
              {t('licenseManagement.checkout.startedTitle', 'Checkout started')}
            </div>
            <div className="mt-1 text-muted-foreground">
              {t(
                'licenseManagement.checkout.startedDescription',
                'After Dodo sends your license key, Kite Desktop will try to claim and activate it automatically. You can also claim it here or paste the key above manually.'
              )}
            </div>
            {checkoutId ? (
              <div className="mt-2 text-xs text-muted-foreground break-all">
                {t('licenseManagement.checkout.checkoutId', 'Checkout')}:{' '}
                {checkoutId}
              </div>
            ) : null}
          </div>
        ) : null}

        {!checkoutStatusLoading && !checkoutConfigured ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <div className="flex items-start gap-2">
              <IconInfoCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                <div className="font-medium">
                  {t(
                    'licenseManagement.checkout.unavailableTitle',
                    'Pro checkout is not configured'
                  )}
                </div>
                <div className="mt-1 text-muted-foreground">
                  {checkoutAvailability?.message ||
                    t(
                      'licenseManagement.checkout.unavailableDescription',
                      'Configure the private license service or a Dodo checkout URL before selling Pro licenses.'
                    )}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Input
            value={checkoutEmail}
            onChange={(event) => setCheckoutEmail(event.target.value)}
            placeholder={t(
              'licenseManagement.input.checkoutEmail',
              'Email for purchase receipt'
            )}
            className="w-full sm:w-64"
            type="email"
            required
          />
          <Button
            variant="outline"
            onClick={() =>
              runLicenseAction(
                syncLicense,
                t('licenseManagement.messages.refreshed', 'License refreshed')
              )
            }
            disabled={submitting}
          >
            <IconRefresh className="mr-2 h-4 w-4" />
            {t('licenseManagement.actions.refresh', 'Refresh License')}
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              runLicenseAction(
                deactivateLicense,
                t(
                  'licenseManagement.messages.deactivated',
                  'Device deactivated'
                )
              )
            }
            disabled={submitting}
          >
            {t('licenseManagement.actions.deactivate', 'Deactivate Device')}
          </Button>
          <Button
            variant="default"
            onClick={() => {
              void handleBuyPro()
            }}
            disabled={
              submitting || checkoutStatusLoading || !checkoutConfigured
            }
            title={
              checkoutStatusLoading || checkoutConfigured
                ? undefined
                : t(
                    'licenseManagement.checkout.unavailableTitle',
                    'Pro checkout is not configured'
                  )
            }
          >
            <IconShoppingCart className="mr-2 h-4 w-4" />
            {t('licenseManagement.actions.buyPro', 'Buy Pro')}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              void handleClaimLicense()
            }}
            disabled={
              submitting ||
              !checkoutConfigured ||
              (!checkoutId && !isValidEmail(checkoutEmail))
            }
          >
            <IconCircleCheck className="mr-2 h-4 w-4" />
            {t('licenseManagement.actions.claimLicense', 'Claim License')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
