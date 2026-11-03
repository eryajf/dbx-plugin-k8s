import {afterEach,describe,it,expect,vi} from 'vitest'
import {dispatchDBXFiles, downloadDBXFile} from './dbx-files'
const params={connectionId:'c',namespace:'default',name:'pod',container:'app',path:'/tmp'}
describe('DBX files',()=>{
 afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
 it('uses the atomic host download and forwards progress and cancellation', async () => {
  const controller = new AbortController()
  let listener: (event: {method: string; params: {downloadId: string; sent: number; total: number}}) => void = () => {}
  let finish: (value: null) => void = () => {}
  const cancelDownload = vi.fn().mockResolvedValue(undefined)
  const off = vi.fn()
  const downloadFile = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve }))
  vi.stubGlobal('dbxPlugin', {capabilities: {downloadFile: true}, downloadFile, cancelDownload, onEvent: (fn: typeof listener) => { listener = fn; return off }})
  const progress = vi.fn()
  const pending = downloadDBXFile(params, {signal: controller.signal, onProgress: progress})
  const request = downloadFile.mock.calls[0][0]
  listener({method: 'host.download.progress', params: {downloadId: request.downloadId, sent: 3, total: 4}})
  expect(progress).toHaveBeenCalledWith(3, 4)
  controller.abort()
  expect(cancelDownload).toHaveBeenCalledWith(request.downloadId)
  finish(null)
  expect(await pending).toBe('canceled')
  expect(off).toHaveBeenCalledOnce()
 })
 it('never starts an unsafe legacy save for any file, including binary files', async () => {
  const saveFile = vi.fn()
  vi.stubGlobal('dbxPlugin', {capabilities: {}, saveFile})
  for (const path of ['/tmp/text.txt', '/tmp/binary-ff.bin']) {
   await expect(downloadDBXFile({...params, path})).rejects.toMatchObject({name: 'DBXDownloadUnavailableError'})
  }
  expect(saveFile).not.toHaveBeenCalled()
 })
 it('lists real metadata at depth one',async()=>{
  const items=[{name:'x',size:'17',mode:'-rw-r--r--',isDir:false,uid:'1',gid:'2',modTime:'2024-01-01T00:00:00Z'}]
  const invoke=vi.fn().mockResolvedValue({items,truncated:false})
  expect(await dispatchDBXFiles(invoke,params,undefined,'GET',undefined)).toEqual(items)
  expect(invoke).toHaveBeenCalledWith('pod/files-list',{...params,depth:1})
 })
 it('refuses to present truncated content as complete',async()=>{
  const invoke=vi.fn().mockResolvedValue({content:'partial',truncated:true})
  await expect(dispatchDBXFiles(invoke,params,'preview','GET',undefined)).rejects.toThrow('256 KiB')
 })
 it('writes existing content with explicit overwrite and upload without overwrite',async()=>{
  const invoke=vi.fn().mockResolvedValue({})
  await dispatchDBXFiles(invoke,params,'content','PUT',{content:'hello'})
  expect(invoke).toHaveBeenLastCalledWith('pod/file-write',{...params,content:'hello',overwrite:true})
  const form=new FormData();form.append('file',new File(['hello'],'config.txt'))
  await dispatchDBXFiles(invoke,params,'upload','PUT',form)
  expect(invoke).toHaveBeenLastCalledWith('pod/file-write',{...params,path:'/tmp/config.txt',content:'hello',overwrite:false})
 })
 it('rejects binary and oversized uploads before RPC',async()=>{
  const invoke=vi.fn().mockResolvedValue({context:'prod',kubeconfigPath:'/tmp/config'})
  for(const file of [new File([new Uint8Array([255,254])],'binary'),new File(['x'.repeat(262145)],'big')]){
   const form=new FormData();form.append('file',file)
   await expect(dispatchDBXFiles(invoke,params,'upload','PUT',form)).rejects.toMatchObject({name:'DBXUploadFallbackError',reason:expect.any(String),command:expect.stringContaining('--context=\'prod\'')})
  }
  expect(invoke).toHaveBeenCalledWith('kube/cluster-info', {})
 })
 it('marks the fallback unavailable when connection metadata is missing',async()=>{
  const invoke=vi.fn().mockRejectedValue(new Error('unavailable'))
  const form=new FormData();form.append('file',new File(['x'.repeat(262145)],'big'))
  await expect(dispatchDBXFiles(invoke,params,'upload','PUT',form)).rejects.toMatchObject({name:'DBXUploadFallbackError',ready:false})
 })
 it('routes deletes without fabricating results',async()=>{
  const invoke=vi.fn().mockRejectedValue(new Error('permission denied'))
  await expect(dispatchDBXFiles(invoke,params,undefined,'DELETE',undefined)).rejects.toThrow('permission denied')
 })
})
