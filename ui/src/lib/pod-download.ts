import { toast } from 'sonner'
import i18n from '@/i18n'
import { podDownloadFile } from '@/lib/api/core'
import { getDBXTransport } from '@/lib/dbx-transport'
import { DBXDownloadUnavailableError, hasManagedDownload } from '@/lib/dbx-files'
import { translateError } from '@/lib/utils'

export async function downloadPodFile(namespace: string, pod: string, container: string, path: string, options: {clusterName?: string; isDirectory?: boolean}) {
 const controller = new AbortController()
 const name = path.split('/').pop() || path
 const cancellable = Boolean(getDBXTransport(options.clusterName)) && hasManagedDownload()
 const action = cancellable ? {label: i18n.t('podFiles.cancelDownload'), onClick: () => controller.abort()} : undefined
 const progress = (bytes: number, total?: number) => i18n.t('podFiles.downloadingProgress', {name, bytes}) + (total !== undefined ? ` / ${total} (${total ? Math.min(100, Math.floor(bytes * 100 / total)) : 100}%)` : '')
 const id = toast.loading(progress(0), {duration: Infinity, action})
 try {
  const result = await podDownloadFile(namespace, pod, container, path, {...options, signal: controller.signal, onProgress: (bytes, total) => toast.loading(progress(bytes, total), {id, duration: Infinity, action})})
  if (result === 'canceled') toast.info(i18n.t('podFiles.downloadCanceled'), {id})
  else if (result === 'saved') toast.success(i18n.t('podFiles.downloadSuccess', {name}), {id})
  else toast.dismiss(id)
 } catch (error) {
  const message = error instanceof DBXDownloadUnavailableError ? i18n.t('podFiles.safeDownloadUnavailable') : translateError(error, i18n.t.bind(i18n))
  toast.error(i18n.t('podFiles.downloadError', {error: message}), {id, duration: Infinity})
 }
}
