import {useCallback,useEffect,useState} from 'react'
import type {Invoke} from './types'
type Context = {connectionId?:string;connectionName?:string;[key:string]:unknown}
type Bridge = {ready:Promise<void>;context?:Context;locale?:string;theme?:{appearance?:string};invoke(method:string,params:unknown,options?:{timeoutMs:number}):Promise<unknown>;onContext?(fn:(context:Context)=>void):()=>void}
const bridge = () => (window as unknown as {dbxPlugin?:Bridge}).dbxPlugin
export function errorText(error:unknown):string {
  if(error instanceof Error) return error.message
  if(error && typeof error==='object' && 'message' in error) return String(error.message)
  return String(error)
}
export function useBridge() {
  const [context,setContext]=useState<Context>({})
  const [error,setError]=useState('')
  const [locale,setLocale]=useState('zh-CN')
  useEffect(()=>{
    const b=bridge();if(!b){setError('请通过 DBX 插件开发主机打开此页面');return}
    let alive=true
    const off=b.onContext?.(c=>{if(alive)setContext(c||{})})
    const env=()=>{if(alive){setLocale(b.locale||'zh-CN');document.documentElement.dataset.theme=b.theme?.appearance||'dark'}}
    b.ready.then(()=>{if(alive){setContext(b.context||{});env()}}).catch(e=>{if(alive)setError(errorText(e))})
    window.addEventListener('dbx-plugin-env',env)
    return ()=>{alive=false;off?.();window.removeEventListener('dbx-plugin-env',env)}
  },[])
  const connectionId=context.connectionId||''
  const invoke:Invoke=useCallback(async<T,>(method:string,params:Record<string,unknown>={}):Promise<T>=>{
    const b=bridge();if(!b)throw Error('DBX Host Bridge unavailable');await b.ready
    if(!connectionId)throw Error('请先连接 Kubernetes 集群')
    return await b.invoke(method,{...params,connectionId},{timeoutMs:method==='node/drain'?3600000:60000}) as T
  },[connectionId])
  return {connectionId,connectionLabel:context.connectionName||connectionId,invoke,error,locale}
}
