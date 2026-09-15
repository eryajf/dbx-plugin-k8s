export type KubeObject = {
  apiVersion?: string
  kind?: string
  metadata: { name: string; namespace?: string; uid?: string; resourceVersion?: string; creationTimestamp?: string; deletionTimestamp?: string; labels?: Record<string,string>; annotations?: Record<string,string>; ownerReferences?: any[]; managedFields?: any[] }
  spec?: any
  status?: any
  data?: Record<string,string>
  [key: string]: any
}
export type ResourceType = { group:string; version:string; resource:string; kind:string; namespaced:boolean; verbs:string[] }
export type Invoke = <T>(method:string,params?:Record<string,unknown>)=>Promise<T>
export type ListResult = {items:KubeObject[]; metadata?:{continue?:string;resourceVersion?:string}}
export const resourceKey = (r:ResourceType) => `${r.group}/${r.version}/${r.resource}`
export const objectKey = (r:ResourceType,o:KubeObject) => `${resourceKey(r)}/${o.metadata.namespace||''}/${o.metadata.name}`
