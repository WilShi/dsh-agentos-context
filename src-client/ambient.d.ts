declare module '*.module.css' { const classes: Readonly<Record<string,string>>; export default classes }
declare module 'cytoscape-fcose' { const extension: any; export default extension }
declare module 'cytoscape-dagre' { const extension: any; export default extension }
declare module 'three';
declare module 'three/addons/controls/OrbitControls.js';
declare module 'three/addons/lines/Line2.js';
declare module 'three/addons/lines/LineGeometry.js';
declare module 'three/addons/lines/LineMaterial.js';

// ---------------------------------------------------------------------------
// Shell-provided client modules.
//
// The DSH client packages are published as browser ModuleLoader bundles and do
// not ship .d.ts files; the shell supplies the same modules through its module
// table at runtime. These declarations describe only the surfaces this plugin
// consumes, so the typecheck is real for our code without pretending to model
// the whole shell.
// ---------------------------------------------------------------------------
declare module '@deepseek-ai/dsh-client-connection' {
  export type ConnectionRpcResult<T = unknown> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string; readonly code?: string; readonly details?: unknown } }
  export interface ConnectionFetchRoute {
    readonly path: string
    readonly methods: readonly string[]
    readonly requestBody?: 'streaming' | 'json'
    fetch(request: Request): Promise<Response>
  }
}
declare module '@deepseek-ai/dsh-client-connection/client' {
  export type ConnectionRpcResult<T = unknown> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details?: unknown } }
  export interface ClientConnectionRpc {
    call(base: string, method: string, payload: unknown, signal?: AbortSignal): Promise<ConnectionRpcResult<unknown>>
  }
  export interface ConnectionHandle {
    readonly rpc: ClientConnectionRpc
  }
}
declare module '@deepseek-ai/dsh-api-remotes/client' {
  export type RemoteResult<T = unknown> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } }
  export interface ClientRemote {
    readonly credentials: {
      describe(refs: readonly string[]): Promise<RemoteResult<Record<string, { configured?: boolean; writable?: boolean }>>>
      set(ref: string, value: string): Promise<RemoteResult<unknown>>
    }
    $on(event: string, listener: (ref: string) => void): () => void
  }
}
declare module '@deepseek-ai/dsh-client-locale/client' {}
declare module '@deepseek-ai/dsh-client-ui-renderer/client' {}
declare module '@deepseek-ai/dsh-client-ui-settings-plugins/client' {}
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  export interface ConvViewProps {
    readonly sessionId: string
    readonly [key: string]: unknown
  }
}
declare module '@deepseek-ai/dsh-client-ui-settings/client' {
  export interface ConfigFormSnapshot<T> {
    readonly status: string
    readonly value: T
    readonly base: T
    readonly user: T
    readonly revision: number
    readonly writable: boolean
    readonly [key: string]: unknown
  }
  export interface ConfigForm<T> {
    subscribe(listener: () => void): () => void
    getSnapshot(): ConfigFormSnapshot<T>
    set(value: Partial<T>): Promise<boolean>
    unset(key: string): Promise<boolean>
    mutate(fn: (draft: T) => void): Promise<boolean>
  }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** Slot contract table; owners extend it through declaration merging. */
  export interface SlotMap {}
  export interface SlotRegistration {
    readonly name: string
    readonly id?: string
    readonly key?: string
    readonly order?: number
    readonly priority?: number
    readonly label?: () => string
    readonly locale?: string
    readonly inject?: (...args: never[]) => object
    readonly children?: Record<string, unknown>
  }
  export interface SlotEntry {
    readonly options: SlotRegistration
    readonly component: unknown
  }
  export interface SlotsService {
    inject(key: string, callback: () => unknown): unknown
    register(options: SlotRegistration, component: unknown): () => void
    entries(key: string): readonly SlotEntry[]
  }
  export interface LocaleService {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(namespace: string): (key: string) => string
  }
  export interface ConfigFormsService {
    get<T>(namespace: string): ConfigForm<T>
  }
}