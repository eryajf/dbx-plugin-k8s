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
export async function downloadDBXFile(invoke:DBXInvoke, params:Record<string,unknown>):Promise<void> {
 const content = await dispatchDBXFiles(invoke,params,'download','GET',undefined) as string
 const url=URL.createObjectURL(new Blob([content],{type:'text/plain;charset=utf-8'}))
 const link=document.createElement('a');link.href=url;link.download=String(params.path).split('/').pop()||'download'
 document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
