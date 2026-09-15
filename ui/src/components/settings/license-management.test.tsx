import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openURL } from '@/lib/desktop'

import { LicenseManagement } from './license-management'

const refreshLicense = vi.fn()
const activateLicenseMock = vi.fn()
const claimPurchasedLicenseMock = vi.fn()
const createLicenseCheckoutMock = vi.fn()
const getLicenseCheckoutAvailabilityMock = vi.fn()
let mockedCustomerEmail: string | undefined

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('@/lib/desktop', () => ({
  openURL: vi.fn(),
}))

vi.mock('@/lib/api/license', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/license')>()
  return {
    ...actual,
    activateLicense: (licenseKey: string) => activateLicenseMock(licenseKey),
    claimPurchasedLicense: (input: unknown) => claimPurchasedLicenseMock(input),
    createLicenseCheckout: (input: unknown) => createLicenseCheckoutMock(input),
    deactivateLicense: vi.fn(),
    getLicenseCheckoutAvailability: () => getLicenseCheckoutAvailabilityMock(),
    syncLicense: vi.fn(),
    validateLicense: vi.fn(),
  }
})

vi.mock('@/hooks/use-license', () => ({
  useLicense: () => ({
    status: {
      status: 'inactive',
      edition: 'community',
      plan: 'community',
      customerEmail: mockedCustomerEmail,
      features: [],
    },
    featureMatrix: [
      {
        key: 'ai.agent',
        name: 'AI Assistant',
        description: 'AI chat and agent workflows.',
        community: false,
        pro: true,
      },
      {
        key: 'terminal.kubectl',
        name: 'Kubectl terminal workspace',
        description: 'Interactive kubectl terminal workspace.',
        community: false,
        pro: true,
      },
    ],
    features: new Set(),
    isLoading: false,
    error: null,
    refresh: refreshLicense,
  }),
}))

function renderLicenseManagement() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <LicenseManagement />
    </QueryClientProvider>
  )
}

describe('LicenseManagement', () => {
  beforeEach(() => {
    window.localStorage.clear()
    mockedCustomerEmail = undefined
    refreshLicense.mockReset()
    activateLicenseMock.mockReset()
    claimPurchasedLicenseMock.mockReset()
    createLicenseCheckoutMock.mockReset()
    getLicenseCheckoutAvailabilityMock.mockReset()
    vi.mocked(openURL).mockReset()
    vi.mocked(toast.error).mockReset()
    vi.mocked(toast.success).mockReset()
    activateLicenseMock.mockResolvedValue({
      status: 'active',
      edition: 'pro',
      plan: 'pro',
      features: ['ai.agent'],
    })
    createLicenseCheckoutMock.mockResolvedValue({
      checkoutUrl: 'https://checkout.dodopayments.com/pro',
      checkoutId: 'chk_test',
      mode: 'license-service',
      provider: 'dodo',
    })
    claimPurchasedLicenseMock.mockResolvedValue({
      status: 'active',
      plan: 'pro',
      ready: true,
      checkoutId: 'chk_test',
      message: 'License is ready to activate.',
      localStatus: {
        status: 'active',
        edition: 'pro',
        plan: 'pro',
        features: ['ai.agent'],
      },
    })
    getLicenseCheckoutAvailabilityMock.mockResolvedValue({
      available: true,
      mode: 'license-service',
      provider: 'dodo',
      source: 'env',
      configured: true,
      serviceReady: true,
      serviceStatus: 'ready',
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders Community license status and Pro feature matrix', async () => {
    renderLicenseManagement()

    expect(screen.getByText('License')).toBeInTheDocument()
    expect(screen.getByText('Edition')).toBeInTheDocument()
    expect(screen.getAllByText('community').length).toBeGreaterThan(0)
    expect(screen.getByText('AI Assistant')).toBeInTheDocument()
    expect(screen.getByText('Kubectl terminal workspace')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Activate/ })).toBeDisabled()
    expect(
      await screen.findByRole('button', { name: /Buy Pro/ })
    ).toBeInTheDocument()
  })

  it('activates a pasted license key and refreshes local status', async () => {
    const user = userEvent.setup()
    renderLicenseManagement()

    await user.type(
      screen.getByPlaceholderText('Paste your license key'),
      'license-key'
    )
    await user.click(screen.getByRole('button', { name: /Activate/ }))

    expect(activateLicenseMock).toHaveBeenCalledWith('license-key')
    expect(refreshLicense).toHaveBeenCalled()
  })

  it('opens the checkout URL returned by the license service', async () => {
    const user = userEvent.setup()
    renderLicenseManagement()

    await user.type(
      screen.getByPlaceholderText('Email for purchase receipt'),
      'buyer@example.com'
    )
    await user.click(screen.getByRole('button', { name: /Buy Pro/ }))

    expect(createLicenseCheckoutMock).toHaveBeenCalledWith({
      plan: 'pro',
      customerEmail: 'buyer@example.com',
    })
    expect(openURL).toHaveBeenCalledWith(
      'https://checkout.dodopayments.com/pro'
    )
    expect(screen.getByText('Checkout started')).toBeInTheDocument()
    expect(screen.getByText(/chk_test/)).toBeInTheDocument()
    expect(
      JSON.parse(
        window.localStorage.getItem('kite-license-pending-checkout') ?? '{}'
      )
    ).toMatchObject({
      checkoutId: 'chk_test',
      customerEmail: 'buyer@example.com',
    })
  })

  it('claims a delivered checkout license and refreshes local status', async () => {
    const user = userEvent.setup()
    renderLicenseManagement()

    await user.type(
      screen.getByPlaceholderText('Email for purchase receipt'),
      'buyer@example.com'
    )
    await user.click(screen.getByRole('button', { name: /Buy Pro/ }))
    await user.click(screen.getByRole('button', { name: /Claim License/ }))

    expect(claimPurchasedLicenseMock).toHaveBeenCalledWith({
      checkoutId: 'chk_test',
      customerEmail: 'buyer@example.com',
    })
    expect(refreshLicense).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('License is ready to activate.')
    expect(
      window.localStorage.getItem('kite-license-pending-checkout')
    ).toBeNull()
  })

  it('automatically claims a delivered checkout license after purchase', async () => {
    let intervalHandler: TimerHandler | undefined
    const setIntervalSpy = vi
      .spyOn(window, 'setInterval')
      .mockImplementation((handler: TimerHandler) => {
        intervalHandler = handler
        return 1
      })
    const clearIntervalSpy = vi
      .spyOn(window, 'clearInterval')
      .mockImplementation(() => undefined)

    renderLicenseManagement()

    fireEvent.change(
      screen.getByPlaceholderText('Email for purchase receipt'),
      {
        target: { value: 'buyer@example.com' },
      }
    )
    const buyButton = await screen.findByRole('button', { name: /Buy Pro/ })
    await waitFor(() => expect(buyButton).not.toBeDisabled())
    fireEvent.click(buyButton)

    await waitFor(() =>
      expect(openURL).toHaveBeenCalledWith(
        'https://checkout.dodopayments.com/pro'
      )
    )
    expect(setIntervalSpy).toHaveBeenCalled()
    expect(intervalHandler).toBeTypeOf('function')

    expect(claimPurchasedLicenseMock).not.toHaveBeenCalled()
    ;(intervalHandler as () => void)()
    await flushPromises()

    expect(claimPurchasedLicenseMock).toHaveBeenCalledWith({
      checkoutId: 'chk_test',
      customerEmail: 'buyer@example.com',
    })
    expect(refreshLicense).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('License is ready to activate.')
    expect(clearIntervalSpy).toHaveBeenCalled()
    expect(
      window.localStorage.getItem('kite-license-pending-checkout')
    ).toBeNull()
  })

  it('restores a pending checkout and can claim it after app reload', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(
      'kite-license-pending-checkout',
      JSON.stringify({
        checkoutId: 'chk_restored',
        customerEmail: 'restored@example.com',
        startedAt: '2026-06-05T00:00:00.000Z',
      })
    )

    renderLicenseManagement()

    expect(
      screen.getByPlaceholderText('Email for purchase receipt')
    ).toHaveValue('restored@example.com')
    expect(screen.getByText('Checkout started')).toBeInTheDocument()
    expect(screen.getByText(/chk_restored/)).toBeInTheDocument()

    const claimButton = await screen.findByRole('button', {
      name: /Claim License/,
    })
    await waitFor(() => expect(claimButton).not.toBeDisabled())
    await user.click(claimButton)

    expect(claimPurchasedLicenseMock).toHaveBeenCalledWith({
      checkoutId: 'chk_restored',
      customerEmail: 'restored@example.com',
    })
    expect(refreshLicense).toHaveBeenCalled()
    expect(
      window.localStorage.getItem('kite-license-pending-checkout')
    ).toBeNull()
  })

  it('shows a pending message when the purchased license is not ready', async () => {
    const user = userEvent.setup()
    claimPurchasedLicenseMock.mockResolvedValue({
      status: 'inactive',
      plan: 'community',
      ready: false,
      checkoutId: 'chk_test',
      message: 'License has not been delivered for this checkout yet.',
    })
    renderLicenseManagement()

    await user.type(
      screen.getByPlaceholderText('Email for purchase receipt'),
      'buyer@example.com'
    )
    await user.click(screen.getByRole('button', { name: /Buy Pro/ }))
    await user.click(screen.getByRole('button', { name: /Claim License/ }))

    expect(refreshLicense).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(
      'License has not been delivered for this checkout yet.'
    )
  })

  it('prefills checkout email from the current license customer email', () => {
    mockedCustomerEmail = 'existing@example.com'
    renderLicenseManagement()

    expect(
      screen.getByPlaceholderText('Email for purchase receipt')
    ).toHaveValue('existing@example.com')
  })

  it('requires a valid checkout email before opening Pro checkout', async () => {
    const user = userEvent.setup()
    renderLicenseManagement()

    await user.click(screen.getByRole('button', { name: /Buy Pro/ }))

    expect(createLicenseCheckoutMock).not.toHaveBeenCalled()
    expect(openURL).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(
      'Enter a valid email before purchasing Pro'
    )

    await user.type(
      screen.getByPlaceholderText('Email for purchase receipt'),
      'invalid-email'
    )
    await user.click(screen.getByRole('button', { name: /Buy Pro/ }))

    expect(createLicenseCheckoutMock).not.toHaveBeenCalled()
    expect(openURL).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledTimes(2)
  })

  it('disables Buy Pro when checkout is not configured', async () => {
    getLicenseCheckoutAvailabilityMock.mockResolvedValue({
      available: false,
      configured: false,
      message: 'Pro checkout is not configured',
    })

    renderLicenseManagement()

    expect(
      await screen.findAllByText('Pro checkout is not configured')
    ).toHaveLength(2)
    expect(screen.getByRole('button', { name: /Buy Pro/ })).toBeDisabled()
  })

  it('refuses to open a non-Dodo checkout URL', async () => {
    const user = userEvent.setup()
    createLicenseCheckoutMock.mockResolvedValue({
      checkoutUrl: 'https://github.com/eryajf/kite-desktop',
      mode: 'license-service',
      provider: 'dodo',
    })

    renderLicenseManagement()

    await user.type(
      screen.getByPlaceholderText('Email for purchase receipt'),
      'buyer@example.com'
    )
    await user.click(await screen.findByRole('button', { name: /Buy Pro/ }))

    expect(createLicenseCheckoutMock).toHaveBeenCalled()
    expect(openURL).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(
      'Pro checkout is misconfigured. Refusing to open a non-Dodo checkout URL.'
    )
  })
})
