import type {DBXInvoke} from './dbx-transport'
import type {FileInfo} from './api/core'
import { kubectlCpCommand, kubectlCpReady, type ClusterInfo } from './kubectl-cp'
const MAX_BYTES = 262144
interface FileReply { content: string; truncated: boolean }
export type UploadFallbackReason = 'size' | 'binary'
export class DBXUploadFallbackError extends Error {
 readonly reason: UploadFallbackReason
 readonly command: string
 readonly ready: boolean
 constructor(reason: UploadFallbackReason, command: string, ready: boolean, message: string) { super(message); this.name = 'DBXUploadFallbackError'; this.reason = reason; this.command = command; this.ready = ready }
}
export async function dispatchDBXFiles(invoke: DBXInvoke, params: Record<string,unknown>, action: string | undefined, method:string, body: unknown): Promise<unknown> {
 if (!action && method === 'GET') {
  const result = await invoke('pod/files-list', {...params, depth:1}) as {items:FileInfo[]; truncated:boolean}
  if(result.truncated) throw new Error('目录超过 500 项，请进入更小的子目录')
  return result.items
 }
 if ((action === 'preview' || action === 'download') && method === 'GET') {
  const result = await invoke('pod/file-read',params) as FileReply
  if(result.truncated) throw new Error('文件超过 256 KiB，无法完整读取，请使用容器终端传输')
  return result.content
 }
 if(action === 'content' && method === 'PUT') {
  const content = (body as {content?:unknown})?.content
  if(typeof content !== 'string') throw new Error('文件内容必须为文本')
  if(new TextEncoder().encode(content).length > MAX_BYTES) throw new Error('文件超过 256 KiB')
  return invoke('pod/file-write',{...params,content,overwrite:true})
 }
 if(action === 'upload' && method === 'PUT') {
  if(!(body instanceof FormData)) throw new Error('上传需要 FormData')
  const file = body.get('file')
  if(!(file instanceof File)) throw new Error('未选择文件')
  if(file.size > MAX_BYTES) throw await uploadFallbackError(invoke, params, file, 'size', '文件超过 256 KiB / File exceeds 256 KiB')
  let content: string
  try { content = new TextDecoder('utf-8',{fatal:true}).decode(await readBytes(file)) } catch { throw await uploadFallbackError(invoke, params, file, 'binary', '请选择 UTF-8 文本文件 / Choose a UTF-8 text file') }
  if(content.includes('\0')) throw await uploadFallbackError(invoke, params, file, 'binary', '请选择 UTF-8 文本文件 / Choose a UTF-8 text file')
  if(!file.name || file.name.includes('/') || file.name.includes('\\')) throw new Error('文件名无效')
  const path = String(params.path || '/').replace(/\/$/,'') + '/' + file.name
  return invoke('pod/file-write',{...params,path,content,overwrite:false})
 }
 if(!action && method === 'DELETE') return invoke('pod/file-delete',params)
 throw new Error('未支持的文件操作')
}
async function uploadFallbackError(invoke: DBXInvoke, params: Record<string,unknown>, file: File, reason: UploadFallbackReason, message: string): Promise<DBXUploadFallbackError> {
 let info: ClusterInfo = {}
 try { info = await invoke('kube/cluster-info', {}) as ClusterInfo || {} } catch { /* The command remains useful without optional connection metadata. */ }
 const targetPath = `${String(params.path || '/').replace(/\/$/,'')}/${file.name.split(/[\\/]/).pop() || file.name}`
 const command = kubectlCpCommand(file.name, String(params.namespace || ''), String(params.name || ''), targetPath, String(params.container || ''), info)
 return new DBXUploadFallbackError(reason, command, kubectlCpReady(info), message)
}
function readBytes(file:File):Promise<ArrayBuffer> {
 if(typeof file.arrayBuffer === 'function') return file.arrayBuffer()
 return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result as ArrayBuffer);reader.onerror=()=>reject(reader.error);reader.readAsArrayBuffer(file)})
}
type ManagedDownloadHost = {
 capabilities?: {downloadFile?: boolean}
 downloadFile?: (options: {downloadId: string; fileName: string; params: Record<string, unknown>}) => Promise<unknown | null>
 cancelDownload?: (id: string) => Promise<unknown>
 onEvent?: (listener: (event: {method?: string; params?: {downloadId?: string; sent?: number; total?: number}}) => void) => () => void
}
export function hasManagedDownload(): boolean {
 const host = (window as unknown as {dbxPlugin?: ManagedDownloadHost}).dbxPlugin
 return Boolean(host?.capabilities?.downloadFile && host.downloadFile && host.cancelDownload)
}
export class DBXDownloadUnavailableError extends Error {
 constructor() { super('Safe file downloads require a newer DBX desktop host'); this.name = 'DBXDownloadUnavailableError' }
}
type DownloadOptions = { signal?: AbortSignal; onProgress?: (bytes: number, total?: number) => void }
export async function downloadDBXFile(params: Record<string, unknown>, options: DownloadOptions = {}): Promise<'saved' | 'canceled'> {
 const host = (window as unknown as {dbxPlugin?: ManagedDownloadHost}).dbxPlugin
 if (options.signal?.aborted) return 'canceled'
 if (!hasManagedDownload() || !host?.downloadFile || !host.cancelDownload) throw new DBXDownloadUnavailableError()
 const downloadId = crypto.randomUUID()
 const cancelDownload = host.cancelDownload
 const abort = () => { void cancelDownload(downloadId).catch(() => {}) }
 const unsubscribe = host.onEvent?.(event => {
  if (event.method === 'host.download.progress' && event.params?.downloadId === downloadId && typeof event.params.sent === 'number') {
   options.onProgress?.(event.params.sent, event.params.total)
  }
 })
 options.signal?.addEventListener('abort', abort)
 try {
  if (options.signal?.aborted) return 'canceled'
  const result = await host.downloadFile({downloadId, fileName: String(params.path).split('/').pop() || 'download', params})
  return result === null ? 'canceled' : 'saved'
 } catch (error) {
  if (options.signal?.aborted) return 'canceled'
  throw error
 } finally {
  options.signal?.removeEventListener('abort', abort)
  unsubscribe?.()
 }
}

export async function previewDBXFile(invoke: DBXInvoke, params: Record<string, unknown>): Promise<void> {
 const content = await dispatchDBXFiles(invoke, params, 'preview', 'GET', undefined) as string
 const url = URL.createObjectURL(new Blob([content], {type: 'text/plain;charset=utf-8'}))
 const link = document.createElement('a'); link.href = url; link.download = String(params.path).split('/').pop() || 'download'
 document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
