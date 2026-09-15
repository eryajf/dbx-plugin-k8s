import type {KubeObject,ResourceType} from './types'

export function referenceOnly(resource:ResourceType,object:KubeObject) {
 return {resource,object:{apiVersion:object.apiVersion,kind:object.kind,metadata:{name:object.metadata.name,namespace:object.metadata.namespace}}}
}
const defaultColumns=['namespace','status','summary','created']
export function readPreferences(connectionId:string) {
 const empty={recent:[] as ReturnType<typeof referenceOnly>[],columns:[...defaultColumns],refreshInterval:0}
 if(!connectionId)return empty
 try {
  const value=JSON.parse(localStorage.getItem(`dbx-k8s:${connectionId}`)||'{}')
  if(Array.isArray(value.recent))empty.recent=value.recent.filter((s:any)=>s?.resource&&typeof s.resource.resource==='string'&&typeof s.resource.version==='string'&&typeof s.resource.group==='string'&&Array.isArray(s.resource.verbs)&&typeof s.object?.metadata?.name==='string').slice(0,30).map((s:any)=>referenceOnly(s.resource,s.object))
  if(Array.isArray(value.columns))empty.columns=value.columns.filter((c:unknown)=>typeof c==='string'&&defaultColumns.includes(c))
  if([0,5,10,30,60].includes(value.refreshInterval)) empty.refreshInterval=value.refreshInterval
 }catch{/* Sandboxed hosts may disable storage, or stored data may be malformed. */}
 return empty
}
