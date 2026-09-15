import { useEffect, useState } from 'react'
import {
  IconDownload,
  IconFolderOpen,
  IconInfoCircle,
  IconLoader2,
  IconPlayerPlay,
  IconRefresh,
  IconX,
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { revealPath } from '@/lib/desktop'
import { useDesktopUpdate } from '@/hooks/use-desktop-update'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

function formatBytes(bytes?: number) {
  if (!bytes || bytes <= 0) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`
}

function formatSpeed(bytesPerSec?: number) {
  if (!bytesPerSec || bytesPerSec <= 0) {
    return ''
  }
  return `${formatBytes(bytesPerSec)}/s`
}

function UpdateAssetSummary({
  assetName,
  downloadUrl,
}: {
  assetName: string
  downloadUrl?: string
}) {
  const assetLabel = (
    <span
      className={`inline-flex min-w-0 flex-1 items-center gap-1 truncate align-bottom ${
        downloadUrl ? 'cursor-help' : ''
      }`}
    >
      <span className="truncate font-medium text-foreground/80">
        {assetName}
      </span>
      {downloadUrl ? (
        <IconInfoCircle className="h-3 w-3 shrink-0 text-muted-foreground" />
      ) : null}
    </span>
  )

  return (
    <div className="flex items-center rounded-xl border border-border/70 bg-muted/35 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      {downloadUrl ? (
        <Tooltip delayDuration={120}>
          <TooltipTrigger asChild>{assetLabel}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-[22rem] break-all">
            {downloadUrl}
          </TooltipContent>
        </Tooltip>
      ) : (
        assetLabel
      )}
    </div>
  )
}

export function UpdateDownloadToast() {
  const { t } = useTranslation()
  const {
    isDesktop,
    download,
    readyToApply,
    retryDownload,
    cancelDownload,
    applyUpdate,
    isRetryingDownload,
    isCancellingDownload,
    isApplyingUpdate,
    canUseOfficialUpdates,
  } = useDesktopUpdate()
  const [dismissedReadyPath, setDismissedReadyPath] = useState('')

  useEffect(() => {
    if (readyToApply?.path !== dismissedReadyPath) {
      setDismissedReadyPath('')
    }
  }, [dismissedReadyPath, readyToApply?.path])

  if (!isDesktop || !canUseOfficialUpdates) {
    return null
  }

  if (readyToApply && readyToApply.path !== dismissedReadyPath) {
    return (
      <div className="pointer-events-none fixed bottom-3 right-3 z-50 w-[min(94vw,22rem)]">
        <Card className="pointer-events-auto overflow-hidden rounded-2xl border-primary/20 bg-background/95 shadow-xl backdrop-blur">
          <CardContent className="space-y-2 px-3.5 py-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <IconDownload className="h-4 w-4" />
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="text-sm font-semibold leading-none">
                    {t(
                      'updateToast.downloadedTitle',
                      'Update ready to install'
                    )}
                  </div>
                  <p className="text-[11px] leading-4 text-muted-foreground">
                    {t(
                      'updateToast.downloadedDescription',
                      'The installer package has been downloaded. Restart the app to continue the update.'
                    )}
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2 text-xs"
                onClick={() => setDismissedReadyPath(readyToApply.path)}
              >
                {t('common.later', 'Later')}
              </Button>
            </div>
            <UpdateAssetSummary assetName={readyToApply.assetName} />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7"
                onClick={() => void revealPath(readyToApply.path)}
              >
                <IconFolderOpen className="h-4 w-4" />
                {t('updateToast.showFile', 'Show file')}
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-7"
                onClick={() => applyUpdate()}
                disabled={isApplyingUpdate}
              >
                {isApplyingUpdate ? (
                  <IconLoader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <IconPlayerPlay className="h-4 w-4" />
                )}
                {t('updateToast.apply', 'Restart and install')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!download) {
    return null
  }

  const progress =
    download.totalBytes > 0
      ? Math.min(
          100,
          Math.round((download.receivedBytes / download.totalBytes) * 100)
        )
      : 0

  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-50 w-[min(94vw,22rem)]">
      <Card className="pointer-events-auto overflow-hidden rounded-2xl border-primary/20 bg-background/95 shadow-xl backdrop-blur">
        <CardContent className="space-y-2 px-3.5 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <div
                className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                  download.status === 'downloading'
                    ? 'bg-primary/10 text-primary'
                    : 'bg-destructive/10 text-destructive'
                }`}
              >
                {download.status === 'downloading' ? (
                  <IconLoader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <IconX className="h-4 w-4" />
                )}
              </div>
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold leading-none">
                    {download.status === 'downloading'
                      ? t('updateToast.downloadingTitle', 'Downloading update')
                      : t('updateToast.failedTitle', 'Update download failed')}
                  </span>
                  {download.status === 'downloading' &&
                  download.totalBytes > 0 ? (
                    <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                      {progress}%
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-4 text-muted-foreground">
                  <span className="shrink-0">
                    {formatBytes(download.receivedBytes)}
                    {download.totalBytes > 0
                      ? ` / ${formatBytes(download.totalBytes)}`
                      : ''}
                  </span>
                  <span className="hidden text-border sm:inline">•</span>
                  <span className="truncate">
                    {download.status === 'downloading'
                      ? formatSpeed(download.speedBytesPerSec) || ' '
                      : download.error}
                  </span>
                </div>
              </div>
            </div>
            {download.status === 'download_failed' ? (
              <Button
                type="button"
                size="sm"
                className="h-7 shrink-0"
                onClick={() => retryDownload()}
                disabled={isRetryingDownload}
              >
                {isRetryingDownload ? (
                  <IconLoader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <IconRefresh className="h-4 w-4" />
                )}
                {t('common.retry', 'Retry')}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 px-2.5 text-xs"
                onClick={() => cancelDownload()}
                disabled={isCancellingDownload}
              >
                {isCancellingDownload ? (
                  <IconLoader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <IconX className="h-4 w-4" />
                )}
                {t('common.cancel', 'Cancel')}
              </Button>
            )}
          </div>
          <UpdateAssetSummary
            assetName={download.assetName}
            downloadUrl={download.downloadUrl}
          />
          <div className="space-y-1">
            <div className="h-1 overflow-hidden rounded-full bg-muted/80">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  download.status === 'downloading'
                    ? 'bg-primary'
                    : 'bg-destructive'
                }`}
                style={{
                  width:
                    download.totalBytes > 0
                      ? `${Math.max(progress, 4)}%`
                      : '18%',
                }}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
