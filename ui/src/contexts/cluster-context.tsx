/* DBX owns cluster identity; the plugin never discovers or selects clusters itself. */
import React, { createContext, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Cluster } from '@/types/api'

interface ClusterContextType { clusters: Cluster[]; currentCluster: string|null; setCurrentCluster:(id:string)=>void; isLoading:boolean; isSwitching:boolean; error:Error|null }
export const ClusterContext=createContext<ClusterContextType|undefined>(undefined)
type Ctx={connectionId?:string;connectionName?:string}
type Bridge={ready:Promise<void>;context?:Ctx;onContext?:(fn:(c:Ctx)=>void)=>()=>void}
const getBridge=()=> (window as unknown as {dbxPlugin?:Bridge}).dbxPlugin
const clusterFrom=(c:Ctx):Cluster|null=>c.connectionId?({id:0,name:c.connectionName||c.connectionId,enabled:true,inCluster:false,isDefault:true,createdAt:'',updatedAt:''}):null
export const ClusterProvider:React.FC<{children:React.ReactNode}>=({children})=>{
 const qc=useQueryClient(); const [ctx,setCtx]=useState<Ctx>({}); const [loading,setLoading]=useState(true); const [error,setError]=useState<Error|null>(null)
 useEffect(()=>{const b=getBridge(); if(!b){setLoading(false);setError(new Error('DBX Host Bridge unavailable'));return} let alive=true; const apply=(c:Ctx)=>{if(!alive)return; setCtx(c||{}); setLoading(false)}; const off=b.onContext?.(apply); b.ready.then(()=>apply(b.context||{})).catch(e=>{if(alive){setError(e instanceof Error?e:new Error(String(e)));setLoading(false)}}); return()=>{alive=false;off?.()}},[])
 const id=ctx.connectionId||null; useEffect(()=>{void qc.cancelQueries(); qc.clear()},[id,qc])
 const cluster=clusterFrom(ctx)
 return <ClusterContext.Provider value={{clusters:cluster?[cluster]:[],currentCluster:id,setCurrentCluster:()=>undefined,isLoading:loading,isSwitching:false,error}}>{children}</ClusterContext.Provider>
}
