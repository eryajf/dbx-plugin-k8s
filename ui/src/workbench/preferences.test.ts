// @vitest-environment jsdom
import {beforeEach,expect,it} from 'vitest'
import {readPreferences,referenceOnly} from './preferences'
const resource={group:'',version:'v1',resource:'secrets',kind:'Secret',namespaced:true,verbs:['get']}
beforeEach(()=>localStorage.clear())
it('restores connection scoped history without secret data or annotations',()=>{
 const object={kind:'Secret',metadata:{name:'key',namespace:'default',annotations:{password:'sensitive'}},data:{token:'sensitive'}}
 localStorage.setItem('dbx-k8s:a',JSON.stringify({recent:[{resource,object}],columns:['status','invalid'],refreshInterval:30}))
 expect(readPreferences('a')).toEqual({recent:[referenceOnly(resource,object)],columns:['status'],refreshInterval:30})
 expect(JSON.stringify(readPreferences('a'))).not.toContain('sensitive')
 expect(readPreferences('b').recent).toEqual([])
})
it('handles corrupt storage and malformed history without throwing',()=>{
 localStorage.setItem('dbx-k8s:a','{')
 expect(readPreferences('a').recent).toEqual([])
 localStorage.setItem('dbx-k8s:a',JSON.stringify({recent:[null,{}, {object:{metadata:{name:'x'}}}]}))
 expect(readPreferences('a').recent).toEqual([])
})

it('rejects unsupported refresh intervals',()=>{ localStorage.setItem('dbx-k8s:a',JSON.stringify({refreshInterval:7})); expect(readPreferences('a').refreshInterval).toBe(0) })
