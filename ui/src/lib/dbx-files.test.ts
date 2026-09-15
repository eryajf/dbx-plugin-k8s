import {describe,it,expect,vi} from 'vitest'
import {dispatchDBXFiles} from './dbx-files'
const params={connectionId:'c',namespace:'default',name:'pod',container:'app',path:'/tmp'}
describe('DBX files',()=>{
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
  const invoke=vi.fn()
  for(const file of [new File([new Uint8Array([255,254])],'binary'),new File(['x'.repeat(262145)],'big')]){
   const form=new FormData();form.append('file',file)
   await expect(dispatchDBXFiles(invoke,params,'upload','PUT',form)).rejects.toThrow()
  }
  expect(invoke).not.toHaveBeenCalled()
 })
 it('routes deletes without fabricating results',async()=>{
  const invoke=vi.fn().mockRejectedValue(new Error('permission denied'))
  await expect(dispatchDBXFiles(invoke,params,undefined,'DELETE',undefined)).rejects.toThrow('permission denied')
 })
})
