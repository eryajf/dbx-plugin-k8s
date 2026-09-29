import { useState } from 'react'
import { IconCopy } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'

import { copyTextToClipboard } from '@/lib/desktop'
import type { UploadFallbackReason } from '@/lib/dbx-files'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'

interface KubectlCpDialogProps { reason: UploadFallbackReason | null; command: string; ready: boolean; onClose: () => void }

export function KubectlCpDialog({ reason, command, ready, onClose }: KubectlCpDialogProps) {
  const { t } = useTranslation()
  const [copiedCommand, setCopiedCommand] = useState('')
  const [copyError, setCopyError] = useState(false)
  const open = Boolean(reason && command)
  const copy = async () => {
    setCopyError(false)
    try { await copyTextToClipboard(command); setCopiedCommand(command) } catch { setCopyError(true) }
  }
  return <Dialog open={open} onOpenChange={(value) => { if (!value) onClose() }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t('podFiles.kubectlCpTitle', 'Use kubectl cp to upload')}</DialogTitle>
        <DialogDescription>{reason === 'size'
          ? t('podFiles.kubectlCpSize', 'This file exceeds the online upload limit. Use the command below to upload it.')
          : t('podFiles.kubectlCpBinary', 'Binary or non-UTF-8 files cannot be uploaded online. Use the command below.')}</DialogDescription>
      </DialogHeader>
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-sm whitespace-pre-wrap break-all">{command}</pre>
      {!ready && <p role="status" className="text-amber-600">{t('podFiles.kubectlCpMissingContext', 'Copying is disabled until both a local kubeconfig path and context are available. Fill them in before running this command.')}</p>}
      {copyError && <p role="alert">{t('common.error')}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{t('common.close', 'Close')}</Button>
        <Button disabled={!ready} onClick={() => void copy()}><IconCopy className="mr-2 h-4 w-4" />{copiedCommand === command ? t('common.copied', 'Copied') : t('common.copy', 'Copy command')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
