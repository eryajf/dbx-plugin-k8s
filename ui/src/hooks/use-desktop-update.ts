import { useRuntime } from '@/contexts/runtime-context'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { trackEvent } from '@/lib/analytics'
import { getCurrentAnalyticsPageKey } from '@/lib/analytics-route'
import { checkVersionUpdate, type UpdateCheckInfo } from '@/lib/api'
import {
  applyDesktopUpdate,
  cancelDesktopUpdateDownload,
  checkDesktopUpdate,
  clearIgnoredDesktopUpdate,
  getDesktopUpdateState,
  ignoreDesktopUpdate,
  retryDesktopUpdateDownload,
  startDesktopUpdateDownload,
} from '@/lib/desktop'
import { useFeature } from '@/hooks/use-license'

export const desktopUpdateStateKey = ['desktop-update-state'] as const

interface DesktopUpdateStateData {
  ignoredVersion: string
  lastCheck?: UpdateCheckInfo
  download?: {
    status: 'downloading' | 'download_failed'
    version: string
    assetName: string
    downloadUrl: string
    targetPath: string
    receivedBytes: number
    totalBytes: number
    speedBytesPerSec: number
    error?: string
    startedAt?: string
    updatedAt?: string
  }
  readyToApply?: {
    version: string
    assetName: string
    path: string
    downloadedAt?: string
  }
}

async function readDesktopUpdateState(): Promise<DesktopUpdateStateData> {
  const state = await getDesktopUpdateState()
  return {
    ignoredVersion: state?.ignoredVersion || '',
    lastCheck: state?.lastCheck,
    download: state?.download,
    readyToApply: state?.readyToApply,
  }
}

export function useDesktopUpdate() {
  const { isDesktop, isReady } = useRuntime()
  const canUseOfficialUpdates = useFeature('updates.official')
  const queryClient = useQueryClient()

  const trackDesktopUpdateEvent = (name: string) => {
    if (!isDesktop) {
      return
    }
    trackEvent(name, {
      runtime: 'desktop',
      page: getCurrentAnalyticsPageKey(),
    })
  }

  const showMutationError = (error: unknown) => {
    toast.error(
      error instanceof Error ? error.message : 'Update operation failed'
    )
  }

  const stateQuery = useQuery({
    queryKey: desktopUpdateStateKey,
    queryFn: readDesktopUpdateState,
    enabled: isReady && isDesktop && canUseOfficialUpdates,
    staleTime: 1000 * 60,
    refetchInterval: (query) => {
      const state = query.state.data as DesktopUpdateStateData | undefined
      return state?.download?.status === 'downloading' ? 1000 : false
    },
  })

  const refreshState = async () => {
    if (!isDesktop) {
      return
    }
    await queryClient.invalidateQueries({ queryKey: desktopUpdateStateKey })
  }

  const checkMutation = useMutation({
    mutationFn: async (force: boolean = true) => {
      if (!canUseOfficialUpdates) {
        throw new Error('Official updates require Kite Desktop Pro')
      }
      if (isDesktop) {
        const result = await checkDesktopUpdate(force)
        return result as UpdateCheckInfo
      }
      return checkVersionUpdate(force)
    },
    onSuccess: async (result) => {
      if (!isDesktop) {
        return
      }
      queryClient.setQueryData<DesktopUpdateStateData>(
        desktopUpdateStateKey,
        (prev) => ({
          ignoredVersion:
            prev?.ignoredVersion ||
            (result.ignored ? result.latestVersion.replace(/^v/, '') : ''),
          lastCheck: result,
          download: prev?.download,
          readyToApply: prev?.readyToApply,
        })
      )
      await refreshState()
    },
    onError: showMutationError,
  })

  const ignoreMutation = useMutation({
    mutationFn: async (version: string) => {
      if (!canUseOfficialUpdates) {
        throw new Error('Official updates require Kite Desktop Pro')
      }
      await ignoreDesktopUpdate(version)
      return version.replace(/^v/, '')
    },
    onSuccess: (version) => {
      trackDesktopUpdateEvent('update_ignored')
      queryClient.setQueryData<DesktopUpdateStateData>(
        desktopUpdateStateKey,
        (prev) => ({
          ignoredVersion: version,
          lastCheck: prev?.lastCheck
            ? {
                ...prev.lastCheck,
                ignored: prev.lastCheck.latestVersion === version,
              }
            : prev?.lastCheck,
          download: prev?.download,
          readyToApply: prev?.readyToApply,
        })
      )
    },
    onError: showMutationError,
  })

  const clearIgnoreMutation = useMutation({
    mutationFn: async () => {
      if (!canUseOfficialUpdates) {
        throw new Error('Official updates require Kite Desktop Pro')
      }
      return clearIgnoredDesktopUpdate()
    },
    onSuccess: () => {
      trackDesktopUpdateEvent('update_ignore_cleared')
      queryClient.setQueryData<DesktopUpdateStateData>(
        desktopUpdateStateKey,
        (prev) => ({
          ignoredVersion: '',
          lastCheck: prev?.lastCheck
            ? { ...prev.lastCheck, ignored: false }
            : prev?.lastCheck,
          download: prev?.download,
          readyToApply: prev?.readyToApply,
        })
      )
    },
    onError: showMutationError,
  })

  const startDownloadMutation = useMutation({
    mutationFn: async (version: string) => {
      if (!canUseOfficialUpdates) {
        throw new Error('Official updates require Kite Desktop Pro')
      }
      return startDesktopUpdateDownload(version)
    },
    onSuccess: refreshState,
    onError: showMutationError,
  })

  const retryDownloadMutation = useMutation({
    mutationFn: async () => {
      if (!canUseOfficialUpdates) {
        throw new Error('Official updates require Kite Desktop Pro')
      }
      return retryDesktopUpdateDownload()
    },
    onSuccess: async () => {
      trackDesktopUpdateEvent('update_download_retried')
      await refreshState()
    },
    onError: showMutationError,
  })

  const cancelDownloadMutation = useMutation({
    mutationFn: async () => {
      if (!canUseOfficialUpdates) {
        throw new Error('Official updates require Kite Desktop Pro')
      }
      return cancelDesktopUpdateDownload()
    },
    onSuccess: async () => {
      trackDesktopUpdateEvent('update_download_cancelled')
      await refreshState()
    },
    onError: showMutationError,
  })

  const applyUpdateMutation = useMutation({
    mutationFn: async () => {
      if (!canUseOfficialUpdates) {
        throw new Error('Official updates require Kite Desktop Pro')
      }
      return applyDesktopUpdate()
    },
    onError: showMutationError,
  })

  return {
    isDesktop,
    canUseOfficialUpdates,
    state: stateQuery.data,
    result: canUseOfficialUpdates
      ? isDesktop
        ? stateQuery.data?.lastCheck
        : checkMutation.data
      : undefined,
    download: canUseOfficialUpdates ? stateQuery.data?.download : undefined,
    readyToApply: canUseOfficialUpdates
      ? stateQuery.data?.readyToApply
      : undefined,
    isLoadingState: stateQuery.isLoading,
    isChecking: checkMutation.isPending,
    isStartingDownload: startDownloadMutation.isPending,
    isRetryingDownload: retryDownloadMutation.isPending,
    isCancellingDownload: cancelDownloadMutation.isPending,
    isApplyingUpdate: applyUpdateMutation.isPending,
    check: (force: boolean = true) => {
      if (force) {
        trackDesktopUpdateEvent('update_check_clicked')
      }
      checkMutation.mutate(force)
    },
    checkAsync: (force: boolean = true) => checkMutation.mutateAsync(force),
    ignore: (version: string) => ignoreMutation.mutate(version),
    clearIgnore: () => clearIgnoreMutation.mutate(),
    startDownload: (version: string) => {
      trackDesktopUpdateEvent('update_download_started')
      startDownloadMutation.mutate(version)
    },
    retryDownload: () => retryDownloadMutation.mutate(),
    cancelDownload: () => cancelDownloadMutation.mutate(),
    applyUpdate: () => {
      trackDesktopUpdateEvent('update_install_started')
      applyUpdateMutation.mutate()
    },
    refreshState,
    isIgnoring: ignoreMutation.isPending,
    isClearingIgnore: clearIgnoreMutation.isPending,
    error:
      checkMutation.error ||
      stateQuery.error ||
      ignoreMutation.error ||
      clearIgnoreMutation.error ||
      startDownloadMutation.error ||
      retryDownloadMutation.error ||
      cancelDownloadMutation.error ||
      applyUpdateMutation.error,
  }
}
