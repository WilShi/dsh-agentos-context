/**
 * Structural mirror of `@deepseek-ai/dsh-client-connection/client`.
 *
 * The host provides that package at runtime; this source tree does not install
 * its type declarations, and importing the module here made the whole client
 * untypable. Only the single method this API uses is declared, so the contract
 * stays checked at the call sites below.
 */
type ConnectionRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false
      readonly error: {
        readonly code: string
        readonly message: string
        readonly details?: unknown
      }
    }
interface ClientConnectionRpc {
  call(
    base: string,
    method: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<ConnectionRpcResult>
}
import type {
  ContextBootstrap,
  ContextMemory,
  ContextEntity,
  ContextRelation,
  ContextGraph,
  ContextSchema,
  ContextChange,
  ContextUsage,
  UsagePolicy,
  MemoryQuery,
  GraphQuery,
  SaveMemory,
  ReviseMemory,
  CreateRelation,
  ContextDocument,
  ContextDocumentHit,
  ContextDocumentChunk,
} from './context-types.ts'
const PREFIX = 'agentos-context/v1/'
export class ContextApiError extends Error {
  code: string
  field?: string
  constructor(code: string, message: string, field?: string) {
    super(message)
    this.name = 'ContextApiError'
    this.code = code
    if (field !== undefined) this.field = field
  }
}
export interface ContextApi {
  bootstrap(
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<ContextBootstrap>
  memories(
    scopeId: string,
    options?: MemoryQuery,
    signal?: AbortSignal,
  ): Promise<ContextMemory[]>
  memory(
    scopeId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<ContextMemory>
  versions(
    scopeId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<ContextMemory[]>
  entities(
    scopeId: string,
    query?: string,
    signal?: AbortSignal,
  ): Promise<ContextEntity[]>
  graph(
    scopeId: string,
    options?: GraphQuery,
    signal?: AbortSignal,
  ): Promise<ContextGraph>
  reviews(scopeId: string, signal?: AbortSignal): Promise<ContextRelation[]>
  schema(signal?: AbortSignal): Promise<ContextSchema>
  changes(scopeId: string, signal?: AbortSignal): Promise<ContextChange[]>
  usage(
    scopeId: string,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ items: ContextUsage[]; policy: UsagePolicy }>
  documents(
    scopeId: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<ContextDocument[]>
  searchDocuments(
    scopeId: string,
    query: string,
    options?: { limit?: number; threshold?: number; searchMode?: 'hybrid'|'semantic'|'keyword'; documentIds?: string[]; metadata?: Record<string,unknown> },
    signal?: AbortSignal,
  ): Promise<ContextDocumentHit[]>
  documentChunks(scopeId:string,id:string,signal?:AbortSignal):Promise<{ document:ContextDocument|null;chunks:ContextDocumentChunk[] }>
  uploadDocument(
    input: {
      scopeId: string
      filename: string
      mimeType: string
      content?: string
      dataBase64?: string
      metadata?: Record<string, unknown>
    },
    signal?: AbortSignal,
  ): Promise<{
    documentId: string
    chunks: number
    sourceFormat?: string
    sourceBytes?: number
    warningCodes?: string[]
    semanticIndexed?: boolean
    semanticPending?: boolean
    semanticErrorCode?: string | null
  }>
  deleteDocument(
    scopeId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<boolean>
  reindexDocument(
    scopeId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<{
    reindexed: boolean
    chunks: number
    semanticIndexed?: boolean
    semanticPending?: boolean
    semanticErrorCode?: string | null
  }>
  deleteDocuments(scopeId:string,ids:string[],signal?:AbortSignal):Promise<{ deleted:number;requested:number }>
  saveMemory(input: SaveMemory, signal?: AbortSignal): Promise<ContextMemory>
  reviseMemory(
    input: ReviseMemory,
    signal?: AbortSignal,
  ): Promise<ContextMemory>
  transitionMemory(
    input: {
      scopeId: string
      id: string
      expectedRevision: number
      layer: import('./context-types.ts').MemoryLayer
      importance?: number
      expiresAt?: number | null
      reason: string
    },
    signal?: AbortSignal,
  ): Promise<ContextMemory>
  retireMemory(
    input: {
      scopeId: string
      id: string
      expectedRevision: number
      reason: string
    },
    signal?: AbortSignal,
  ): Promise<ContextMemory>
  createEntity(
    input: { scopeId: string; name: string; type: string; aliases?: string[] },
    signal?: AbortSignal,
  ): Promise<ContextEntity>
  mergeEntities(
    input: {
      scopeId: string
      keepId: string
      mergeId: string
      keepRevision: number
      mergeRevision: number
      reason: string
    },
    signal?: AbortSignal,
  ): Promise<ContextEntity>
  createRelation(
    input: CreateRelation,
    signal?: AbortSignal,
  ): Promise<ContextRelation>
  reviewRelation(
    input: {
      scopeId: string
      id: string
      expectedRevision: number
      decision: 'confirm' | 'reject'
      reason: string
    },
    signal?: AbortSignal,
  ): Promise<ContextRelation>
  checkRelation(
    input: Omit<CreateRelation, 'sourceMemoryId'>,
    signal?: AbortSignal,
  ): Promise<{
    ok: boolean
    errors: Array<{ field: string; code: string; message: string }>
  }>
  setUsagePolicy(
    input: {
      sessionId: string
      scopeId: string
      memoryId?: string
      mode?: 'exclude' | 'prefer' | 'normal'
      paused?: boolean
      expectedRevision?: number
    },
    signal?: AbortSignal,
  ): Promise<UsagePolicy>
  subscribe(listener: () => void): () => void
  getRevision(): number
  refresh(): void
  dispose(): void
}
/** M4: bounded RPC waits, so a wedged host cannot leave the UI spinning. */
const READ_TIMEOUT_MS = 15_000
const WRITE_TIMEOUT_MS = 30_000
/** Document parsing/indexing is a long host job (knowledgeUploadTimeoutMs default 10 min). */
const KNOWLEDGE_JOB_TIMEOUT_MS = 600_000

export function createContextApi(rpc: ClientConnectionRpc): ContextApi {
  let revision = 0,
    disposed = false
  const listeners = new Set<() => void>(),
    active = new Set<AbortController>()
  const refresh = () => {
    if (disposed) return
    revision++
    for (const f of listeners)
      try {
        f()
      } catch {}
  }
  async function call<T>(
    endpoint: string,
    payload: object,
    signal?: AbortSignal,
    write = false,
    timeoutMs = write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS,
  ): Promise<T> {
    if (disposed) throw new ContextApiError('DISPOSED', '记忆界面已关闭')
    const controller = new AbortController()
    const limit = Math.max(1_000, timeoutMs)
    let timedOut = false
    // M4: a stalled Connection RPC used to hang the pane forever. Time out with
    // a distinguishable code; the caller's own abort still wins when it fires.
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('Timed out', 'TimeoutError'))
    }, limit)
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    active.add(controller)
    try {
      const result = await rpc.call(
        '/api',
        PREFIX + endpoint,
        payload,
        controller.signal,
      )
      if (!result.ok) {
        const details = result.error.details as
          | Record<string, unknown>
          | undefined
        throw new ContextApiError(
          result.error.code,
          result.error.message,
          typeof details?.field === 'string' ? details.field : undefined,
        )
      }
      if (write) refresh()
      return result.value as T
    } catch (error) {
      if (timedOut)
        throw new ContextApiError(
          'TIMEOUT',
          `请求超过 ${Math.round(limit / 1_000)} 秒未响应，已取消；请确认 DSH 主机状态后重试`,
        )
      if (controller.signal.aborted)
        throw (
          controller.signal.reason ?? new DOMException('Aborted', 'AbortError')
        )
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      active.delete(controller)
    }
  }
  return {
    bootstrap: (sessionId, signal) =>
      call('bootstrap', { ...(sessionId ? { sessionId } : {}) }, signal),
    memories: async (scopeId, options = {}, signal) =>
      (
        await call<{ items: ContextMemory[] }>(
          'memories',
          { scopeId, ...options },
          signal,
        )
      ).items,
    memory: async (scopeId, id, signal) =>
      (await call<{ item: ContextMemory }>('memory', { scopeId, id }, signal))
        .item,
    versions: async (scopeId, id, signal) =>
      (
        await call<{ items: ContextMemory[] }>(
          'versions',
          { scopeId, id },
          signal,
        )
      ).items,
    entities: async (scopeId, query, signal) =>
      (
        await call<{ items: ContextEntity[] }>(
          'entities',
          { scopeId, ...(query ? { query } : {}) },
          signal,
        )
      ).items,
    graph: (scopeId, options = {}, signal) =>
      call('graph', { scopeId, ...options }, signal),
    reviews: async (scopeId, signal) =>
      (await call<{ items: ContextRelation[] }>('reviews', { scopeId }, signal))
        .items,
    schema: signal => call('schema', {}, signal),
    changes: async (scopeId, signal) =>
      (await call<{ items: ContextChange[] }>('changes', { scopeId }, signal))
        .items,
    usage: (scopeId, sessionId, signal) =>
      call('usage', { scopeId, sessionId }, signal),
    documents: async (scopeId, limit = 100, signal) =>
      (
        await call<{ items: ContextDocument[] }>(
          'documents',
          { scopeId, limit },
          signal,
        )
      ).items,
    searchDocuments: async (scopeId, query, options = {}, signal) =>
      (
        await call<{ items: ContextDocumentHit[] }>(
          'documents/search',
          { scopeId, query, ...options },
          signal,
        )
      ).items,
    documentChunks: (scopeId,id,signal) => call('document/chunks',{ scopeId,id },signal),
    uploadDocument: async (input, signal) =>
      (
        await call<{ item: { documentId: string; chunks: number } }>(
          'document/upload',
          input,
          signal,
          true,
          KNOWLEDGE_JOB_TIMEOUT_MS,
        )
      ).item,
    deleteDocument: async (scopeId, id, signal) =>
      (
        await call<{ deleted: boolean }>(
          'document/delete',
          { scopeId, id },
          signal,
          true,
        )
      ).deleted,
    reindexDocument: (scopeId,id,signal) => call('document/reindex',{ scopeId,id },signal,true,KNOWLEDGE_JOB_TIMEOUT_MS),
    deleteDocuments: (scopeId,ids,signal) => call('documents/delete',{ scopeId,ids },signal,true),
    saveMemory: async (input, signal) =>
      (await call<{ item: ContextMemory }>('memory/save', input, signal, true))
        .item,
    reviseMemory: async (input, signal) =>
      (
        await call<{ item: ContextMemory }>(
          'memory/revise',
          input,
          signal,
          true,
        )
      ).item,
    transitionMemory: async (input, signal) =>
      (
        await call<{ item: ContextMemory }>(
          'memory/transition',
          input,
          signal,
          true,
        )
      ).item,
    retireMemory: async (input, signal) =>
      (
        await call<{ item: ContextMemory }>(
          'memory/retire',
          input,
          signal,
          true,
        )
      ).item,
    createEntity: async (input, signal) =>
      (
        await call<{ item: ContextEntity }>(
          'entity/create',
          input,
          signal,
          true,
        )
      ).item,
    mergeEntities: async (input, signal) =>
      (await call<{ item: ContextEntity }>('entity/merge', input, signal, true))
        .item,
    createRelation: async (input, signal) =>
      (
        await call<{ item: ContextRelation }>(
          'relation/create',
          input,
          signal,
          true,
        )
      ).item,
    reviewRelation: async (input, signal) =>
      (
        await call<{ item: ContextRelation }>(
          'relation/review',
          input,
          signal,
          true,
        )
      ).item,
    checkRelation: (input, signal) => call('schema/check', input, signal),
    setUsagePolicy: async (input, signal) =>
      (await call<{ policy: UsagePolicy }>('usage/policy', input, signal, true))
        .policy,
    subscribe: f => (listeners.add(f), () => listeners.delete(f)),
    getRevision: () => revision,
    refresh,
    dispose() {
      if (disposed) return
      disposed = true
      for (const c of active)
        c.abort(new DOMException('Disposed', 'AbortError'))
      active.clear()
      listeners.clear()
    },
  }
}
