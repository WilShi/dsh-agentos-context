import { useCallback,useEffect,useRef,useState,useSyncExternalStore } from 'react'
import type { ContextApi } from './context-api.ts'
import type { ContextMemory,ContextUsage } from './context-types.ts'
export type LoadState<T>={ phase:'loading'|'ready'|'error';data:T|null;error:string|null;reload:()=>void }
export type ContextRevisionApi=Pick<ContextApi,'subscribe'|'getRevision'>
export type ContextRefreshApi=ContextRevisionApi&Pick<ContextApi,'changes'|'refresh'>
export function useMutationGuard(scopeKey?:unknown){const active=useRef(new Set<AbortController>());useEffect(()=>()=>{for(const controller of active.current)controller.abort(new DOMException('Unmounted or scope changed','AbortError'));active.current.clear()},[scopeKey]);return useCallback(async<T,>(work:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{const controller=new AbortController();active.current.add(controller);try{return await work(controller.signal)}finally{active.current.delete(controller)}},[])}
export function useApiRevision(api:ContextRevisionApi):number{return useSyncExternalStore(api.subscribe,api.getRevision,api.getRevision)}
/** Poll only the tiny change feed and invalidate visible reads when Host-side
 * capture writes behind the Client's back. Manual Client writes already call
 * api.refresh(); the signature guard makes the following poll a no-op. */
export function useLiveContextRefresh(api:ContextRefreshApi,scopeId:string,intervalMs=2500):void{
  const last=useRef<string|null>(null)
  useEffect(()=>{
    if(!scopeId)return
    const controller=new AbortController();let timer=0,busy=false,stopped=false
    const poll=async()=>{
      if(stopped||busy||document.visibilityState==='hidden')return
      busy=true
      try{
        const changes=await api.changes(scopeId,controller.signal),head=changes[0],signature=head?`${head.id}:${head.revision??''}:${head.at}`:'empty'
        if(last.current===null)last.current=signature
        else if(last.current!==signature){last.current=signature;api.refresh()}
      }catch(error){if((error as Error)?.name!=='AbortError'){/* keep the visible data and retry */}}
      finally{busy=false}
    }
    const visible=()=>{if(document.visibilityState!=='hidden')void poll()}
    void poll();timer=window.setInterval(()=>void poll(),Math.max(1000,intervalMs));document.addEventListener('visibilitychange',visible)
    return()=>{stopped=true;controller.abort(new DOMException('Unmounted','AbortError'));window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);last.current=null}
  },[api,scopeId,intervalMs])
}
export function useLoad<T>(api:ContextRevisionApi,key:string,loader:(signal:AbortSignal)=>Promise<T>):LoadState<T>{
  const revision=useApiRevision(api);const [tick,setTick]=useState(0);const [state,setState]=useState<Omit<LoadState<T>,'reload'>>({ phase:'loading',data:null,error:null })
  // L6: callers pass a fresh closure on every render, so the loader must not be
  // an effect dependency (it would reload forever). Keeping only the latest one
  // in a ref prevents the effect from awaiting a stale closure when it re-runs
  // for api/key/revision/tick reasons.
  const loaderRef=useRef(loader);loaderRef.current=loader
  useEffect(()=>{const c=new AbortController();let live=true;setState(current=>({ phase:'loading',data:current.data,error:null }));loaderRef.current(c.signal).then((data)=>{if(live)setState({ phase:'ready',data,error:null })},(e)=>{if(live&&e?.name!=='AbortError')setState(s=>({ phase:'error',data:s.data,error:e?.message??String(e) }))});return()=>{live=false;c.abort()}},[api,key,revision,tick])
  return{ ...state,reload:useCallback(()=>setTick(x=>x+1),[]) }
}
export const memoryKindLabel:Record<string,string>={ fact:'事实',decision:'决策',preference:'偏好',constraint:'约束',outcome:'产出',plan:'计划',note:'记录' }
export const memoryLayerLabel:Record<string,string>={ working:'工作',episodic:'情节',semantic:'语义',procedural:'程序' }
export const epistemicLabel:Record<string,string>={ unverified:'待核对',supported:'来源支持',contested:'存在争议',refuted:'已反驳' }
export const usageLabel:Record<ContextUsage['phase'],string>={ planned:'计划使用',committed:'已加入会话',requested:'已进入模型请求',failed:'未使用' }
function decodedScopePart(id:string,prefix:string):string{
  const value=id.slice(prefix.length)
  try{return decodeURIComponent(value)}catch{return value}
}
export function formatScopeLabel(id:string,fallback=''):string{
  if(id==='dsh-default')return'全局记忆'
  if(id==='local:default')return'默认工作区'
  if(id==='legacy:unknown')return'未归类的旧记忆'
  if(id.startsWith('local:')){const path=id.slice('local:'.length).replace(/[\\/]+$/,'');const leaf=path.split(/[\\/]/).filter(Boolean).at(-1);return leaf?`工作区 · ${leaf}`:'本地工作区'}
  if(id.startsWith('session:'))return`会话兼容 · ${decodedScopePart(id,'session:')}`
  const labels={ run:'本次会话',agent:'Agent',user:'用户',app:'应用' } as const
  for(const kind of Object.keys(labels) as Array<keyof typeof labels>){const prefix=kind+':';if(id.startsWith(prefix))return`${labels[kind]} · ${decodedScopePart(id,prefix)}`}
  return fallback||id
}
export function sourceLabel(m:ContextMemory):string{const role={ human:'用户原话',assistant:'模型整理',agent:'Agent记录',tool:'工具结果',unknown:'来源未确认' }[m.source?.actorRole]??'来源未确认';return role+(m.source?.complete?'':' · 片段')}
export function formatTime(value:number|null|undefined):string{return typeof value==='number'?new Date(value).toLocaleString():'时间未知'}
export function plainError(error:unknown):string{return error instanceof Error?error.message:'操作未完成'}
/** Minimal structural input for `eventValue`: keeps this helper independent of
 *  the optional @types/react package, which the compiled-plugin tree may omit. */
export interface ValueChangeEvent{readonly currentTarget:{readonly value:string}}
export function eventValue(e:ValueChangeEvent):string{return e.currentTarget.value}
