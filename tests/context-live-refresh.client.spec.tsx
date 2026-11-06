// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { useApiRevision,useLiveContextRefresh,useLoad,type ContextRefreshApi } from '../src-client/context-ui-helpers.tsx'
import type { ContextChange } from '../src-client/context-types.ts'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT=true

function makeApi(): {
  api: ContextRefreshApi
  refresh: () => void
  setChanges: (value: ContextChange[]) => void
} {
  let revision=0,changes:ContextChange[]=[];const listeners=new Set<()=>void>()
  const refresh = vi.fn(()=>{revision++;for(const listener of listeners)listener()})
  const api: ContextRefreshApi = {
    changes:vi.fn(async()=>changes),
    subscribe:(listener:()=>void)=>(listeners.add(listener),()=>listeners.delete(listener)),
    getRevision:()=>revision,
    refresh,
  }
  return { api, refresh, setChanges: (value:ContextChange[])=>{changes=value} }
}

function Probe({ api }:{ api:ContextRefreshApi }){useLiveContextRefresh(api,'p',1000);const revision=useApiRevision(api);return <span data-revision>{revision}</span>}
function LoadProbe({ api,loader }:{ api:ContextRefreshApi;loader:(signal:AbortSignal)=>Promise<string> }){const state=useLoad(api,'p',loader);return <><span data-phase>{state.phase}</span><span data-value>{state.data??''}</span></>}

describe('live context refresh',()=>{
  afterEach(()=>{vi.useRealTimers();document.body.innerHTML=''})
  it('invalidates visible readers only when the Host-side change head advances',async()=>{
    vi.useFakeTimers();const { api, refresh, setChanges }=makeApi(),host=document.createElement('div');document.body.append(host);const root=createRoot(host)
    await act(async()=>{root.render(<Probe api={api}/>);await Promise.resolve()})
    expect(refresh).not.toHaveBeenCalled()
    setChanges([{ id:'change:1',action:'memory.save',targetId:'m1',at:1,revision:1 }])
    await act(async()=>{await vi.advanceTimersByTimeAsync(1000)})
    expect(refresh).toHaveBeenCalledTimes(1);expect(host.querySelector('[data-revision]')?.textContent).toBe('1')
    await act(async()=>{await vi.advanceTimersByTimeAsync(1000)})
    expect(refresh).toHaveBeenCalledTimes(1)
    await act(async()=>{root.unmount()})
  })
  it('keeps already-rendered data mounted while a live refresh is loading',async()=>{
    const { api, refresh }=makeApi(),host=document.createElement('div');document.body.append(host);const root=createRoot(host)
    let finishReload:(value:string)=>void=()=>{}
    let initialLoad = true
    const loader=vi.fn((_signal: AbortSignal): Promise<string> => {
      if (initialLoad) {
        initialLoad = false
        return Promise.resolve('existing memory')
      }
      return new Promise<string>((resolve)=>{finishReload=resolve})
    })
    await act(async()=>{root.render(<LoadProbe api={api} loader={loader}/>);await Promise.resolve();await Promise.resolve()})
    expect(host.querySelector('[data-phase]')?.textContent).toBe('ready')
    expect(host.querySelector('[data-value]')?.textContent).toBe('existing memory')
    await act(async()=>{refresh();await Promise.resolve()})
    expect(host.querySelector('[data-phase]')?.textContent).toBe('loading')
    expect(host.querySelector('[data-value]')?.textContent).toBe('existing memory')
    await act(async()=>{finishReload('refreshed memory');await Promise.resolve()})
    expect(host.querySelector('[data-phase]')?.textContent).toBe('ready')
    expect(host.querySelector('[data-value]')?.textContent).toBe('refreshed memory')
    await act(async()=>{root.unmount()})
  })
})