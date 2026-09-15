import { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDesktopUpdate } from './use-desktop-update'

const {
  getDesktopUpdateState,
  checkDesktopUpdate,
  startDesktopUpdateDownload,
  applyDesktopUpdate,
  ignoreDesktopUpdate,
  clearIgnoredDesktopUpdate,
  retryDesktopUpdateDownload,
  cancelDesktopUpdateDownload,
} = vi.hoisted(() => ({
  getDesktopUpdateState: vi.fn(),
  checkDesktopUpdate: vi.fn(),
  startDesktopUpdateDownload: vi.fn(),
  applyDesktopUpdate: vi.fn(),
  ignoreDesktopUpdate: vi.fn(),
  clearIgnoredDesktopUpdate: vi.fn(),
  retryDesktopUpdateDownload: vi.fn(),
  cancelDesktopUpdateDownload: vi.fn(),
}))

const { trackEvent } = vi.hoisted(() => ({
  trackEvent: vi.fn(),
}))

const { useFeatureMock } = vi.hoisted(() => ({
  useFeatureMock: vi.fn(),
}))

vi.mock('@/contexts/runtime-context', () => ({
  useRuntime: vi.fn(() => ({
    isDesktop: true,
    isReady: true,
  })),
}))

vi.mock('@/lib/desktop', () => ({
  getDesktopUpdateState,
  checkDesktopUpdate,
  startDesktopUpdateDownload,
  applyDesktopUpdate,
  cancelDesktopUpdateDownload,
  clearIgnoredDesktopUpdate,
  ignoreDesktopUpdate,
  retryDesktopUpdateDownload,
}))

vi.mock('@/lib/api', () => ({
  checkVersionUpdate: vi.fn(),
}))

vi.mock('@/lib/analytics', () => ({
  trackEvent,
}))

vi.mock('@/hooks/use-license', () => ({
  useFeature: (feature: string) => useFeatureMock(feature),
}))

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
  }
}

describe('useDesktopUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useFeatureMock.mockReturnValue(true)
    getDesktopUpdateState.mockResolvedValue({ ignoredVersion: '' })
    checkDesktopUpdate.mockResolvedValue({
      currentVersion: 'v1.0.0',
      latestVersion: 'v1.0.1',
      comparison: 'update_available',
      hasNewVersion: true,
      releaseUrl: '',
      releaseNotes: '',
      publishedAt: '',
      ignored: false,
      assetAvailable: true,
      checkedAt: '',
    })
    startDesktopUpdateDownload.mockResolvedValue({ ignoredVersion: '' })
    applyDesktopUpdate.mockResolvedValue(true)
    ignoreDesktopUpdate.mockResolvedValue(true)
    clearIgnoredDesktopUpdate.mockResolvedValue(true)
    retryDesktopUpdateDownload.mockResolvedValue({ ignoredVersion: '' })
    cancelDesktopUpdateDownload.mockResolvedValue({ ignoredVersion: '' })
  })

  it('tracks manual update actions with sanitized metadata', async () => {
    const { result } = renderHook(() => useDesktopUpdate(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(getDesktopUpdateState).toHaveBeenCalled()
    })

    act(() => {
      result.current.check(true)
      result.current.startDownload('v1.0.1')
      result.current.applyUpdate()
    })

    expect(trackEvent).toHaveBeenNthCalledWith(1, 'update_check_clicked', {
      runtime: 'desktop',
      page: 'overview',
    })
    expect(trackEvent).toHaveBeenNthCalledWith(2, 'update_download_started', {
      runtime: 'desktop',
      page: 'overview',
    })
    expect(trackEvent).toHaveBeenNthCalledWith(3, 'update_install_started', {
      runtime: 'desktop',
      page: 'overview',
    })
  })

  it('does not track silent background checks', async () => {
    const { result } = renderHook(() => useDesktopUpdate(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(getDesktopUpdateState).toHaveBeenCalled()
    })

    act(() => {
      result.current.check(false)
    })

    expect(trackEvent).not.toHaveBeenCalled()
  })

  it('tracks update control actions beyond the initial start events', async () => {
    const { result } = renderHook(() => useDesktopUpdate(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(getDesktopUpdateState).toHaveBeenCalled()
    })

    act(() => {
      result.current.ignore('v1.0.1')
      result.current.clearIgnore()
      result.current.retryDownload()
      result.current.cancelDownload()
    })

    await waitFor(() => {
      expect(trackEvent).toHaveBeenCalledWith('update_ignored', {
        runtime: 'desktop',
        page: 'overview',
      })
      expect(trackEvent).toHaveBeenCalledWith('update_ignore_cleared', {
        runtime: 'desktop',
        page: 'overview',
      })
      expect(trackEvent).toHaveBeenCalledWith('update_download_retried', {
        runtime: 'desktop',
        page: 'overview',
      })
      expect(trackEvent).toHaveBeenCalledWith('update_download_cancelled', {
        runtime: 'desktop',
        page: 'overview',
      })
    })
  })

  it('does not call update APIs without the official updates feature', async () => {
    useFeatureMock.mockReturnValue(false)

    const { result } = renderHook(() => useDesktopUpdate(), {
      wrapper: createWrapper(),
    })

    expect(result.current.canUseOfficialUpdates).toBe(false)
    expect(getDesktopUpdateState).not.toHaveBeenCalled()

    await act(async () => {
      await expect(result.current.checkAsync(true)).rejects.toThrow(
        'Official updates require Kite Desktop Pro'
      )
    })

    expect(checkDesktopUpdate).not.toHaveBeenCalled()
    expect(trackEvent).not.toHaveBeenCalled()
  })
})
