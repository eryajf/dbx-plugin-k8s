import type {KubeObject,ResourceType} from './types'
const categories:Record<string,[string,string]>= {
  nodes:['集群','Cluster'],namespaces:['集群','Cluster'],events:['集群','Cluster'],
  pods:['工作负载','Workloads'],deployments:['工作负载','Workloads'],replicasets:['工作负载','Workloads'],statefulsets:['工作负载','Workloads'],daemonsets:['工作负载','Workloads'],jobs:['工作负载','Workloads'],cronjobs:['工作负载','Workloads'],horizontalpodautoscalers:['工作负载','Workloads'],
  services:['网络','Network'],ingresses:['网络','Network'],ingressclasses:['网络','Network'],networkpolicies:['网络','Network'],endpoints:['网络','Network'],endpointslices:['网络','Network'],gateways:['网络','Network'],httproutes:['网络','Network'],
  configmaps:['配置','Configuration'],secrets:['配置','Configuration'],resourcequotas:['配置','Configuration'],limitranges:['配置','Configuration'],
  persistentvolumes:['存储','Storage'],persistentvolumeclaims:['存储','Storage'],storageclasses:['存储','Storage'],
  roles:['安全','Security'],rolebindings:['安全','Security'],clusterroles:['安全','Security'],clusterrolebindings:['安全','Security'],serviceaccounts:['安全','Security']
}
const labels:Record<string,string>={nodes:'节点',namespaces:'命名空间',events:'事件',pods:'容器组',deployments:'部署',replicasets:'副本集',statefulsets:'有状态副本集',daemonsets:'守护进程集',jobs:'任务',cronjobs:'定时任务',services:'服务',ingresses:'Ingress',configmaps:'配置项',secrets:'密钥',persistentvolumes:'存储卷',persistentvolumeclaims:'存储声明',storageclasses:'存储类',customresourcedefinitions:'自定义资源定义',roles:'角色',rolebindings:'角色绑定',clusterroles:'集群角色',clusterrolebindings:'集群角色绑定',serviceaccounts:'服务账户',horizontalpodautoscalers:'HPA'}
export const builtinResources:ResourceType[] = ([
  ['v1','pods',true],['v1','services',true],['v1','configmaps',true],['v1','secrets',true],['v1','namespaces',false],['v1','nodes',false],
  ['apps','deployments',true],['apps','replicasets',true],['apps','statefulsets',true],['apps','daemonsets',true],['batch','jobs',true],['batch','cronjobs',true],
  ['networking.k8s.io','ingresses',true],['networking.k8s.io','networkpolicies',true],['storage.k8s.io','storageclasses',false],['v1','persistentvolumes',false],['v1','persistentvolumeclaims',true],
  ['rbac.authorization.k8s.io','roles',true],['rbac.authorization.k8s.io','rolebindings',true],['rbac.authorization.k8s.io','clusterroles',false],['rbac.authorization.k8s.io','clusterrolebindings',false]
] as [string,string,boolean][]).map(([group,resource,namespaced])=>({group:group==='v1'?'':group,version:'v1',resource,kind:resource.replace(/s$/,'').replace(/^./,(x:string)=>x.toUpperCase()),namespaced,verbs:['get','list','watch','create','update','patch','delete']} as ResourceType))
export const category=(r:ResourceType,zh:boolean)=>categories[r.resource]?.[zh?0:1]||(zh?'扩展':'Extensions')
export const label=(r:ResourceType,zh:boolean)=>zh?(labels[r.resource]||r.kind):r.kind
export function status(o:KubeObject):string{
  if(o.metadata.deletionTimestamp)return 'Terminating'
  if(o.kind==='Node')return o.status?.conditions?.find((c:any)=>c.type==='Ready')?.status==='True'?(o.spec?.unschedulable?'SchedulingDisabled':'Ready'):'NotReady'
  if(o.kind==='Pod'){
    const states=o.status?.containerStatuses||[]
    const reason=states.find((c:any)=>c.state?.waiting?.reason)?.state.waiting.reason
    if(reason)return reason
    return o.status?.phase||'Pending'
  }
  if(o.kind==='CronJob')return o.spec?.suspend?'Suspended':'Active'
  if(o.kind==='Deployment'||o.kind==='StatefulSet'||o.kind==='ReplicaSet')return `${o.status?.readyReplicas||0} / ${o.spec?.replicas??1}`
  if(o.kind==='DaemonSet')return `${o.status?.numberReady||0} / ${o.status?.desiredNumberScheduled||0}`
  if(o.kind==='Job')return o.status?.succeeded?'Complete':o.status?.failed?'Failed':'Active'
  return o.status?.phase||o.status?.conditions?.find((c:any)=>c.status==='True')?.type||'—'
}
export function summary(o:KubeObject):string{
  if(o.kind==='Node')return `${o.status?.capacity?.cpu||'—'} CPU · ${o.status?.capacity?.memory||'—'} · ${o.status?.nodeInfo?.kubeletVersion||''}`
  if(o.kind==='Service')return `${o.spec?.type||''} · ${o.spec?.clusterIP||'—'} · ${(o.spec?.ports||[]).map((p:any)=>p.port).join(', ')}`
  if(o.kind==='Event')return `${o.reason||''} · ${o.message||''}`
  if(o.kind==='PersistentVolumeClaim'||o.kind==='PersistentVolume')return `${o.spec?.storageClassName||'—'} · ${o.status?.capacity?.storage||o.spec?.capacity?.storage||o.spec?.resources?.requests?.storage||'—'}`
  return (o.spec?.containers||o.spec?.template?.spec?.containers||[]).map((c:any)=>c.image).join(', ')||Object.entries(o.metadata.labels||{}).slice(0,3).map(([k,v])=>`${k}=${v}`).join(', ')||'—'
}
// Prefer stable API versions when discovery returns several served versions.
export function primaryResources(all:ResourceType[]):ResourceType[]{
  const byName=new Map<string,ResourceType>()
  const rank=(version:string)=>version.includes('alpha')?0:version.includes('beta')?1:2
  for(const r of all.filter(r=>r.verbs.includes('list'))){const key=`${r.group}/${r.resource}`,old=byName.get(key);if(!old||rank(r.version)>rank(old.version))byName.set(key,r)}
  return [...byName.values()].sort((a,b)=>a.resource.localeCompare(b.resource))
}
