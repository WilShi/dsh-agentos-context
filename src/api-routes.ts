/**
 * /opencontext-api data routes — UI 数据通路（M3 列表/M4 图谱共用）+ M1 E2E 驱动面。
 *
 * Prefix router on the loopback webServer（webServer.register kind:'prefix'）。
 * 业务结果一律 200 JSON（{ok:true,...} | {ok:false,code,hint}）；
 * 404 未知子路径、405 方法不符、415/400 请求体问题。密钥永不经过这里。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { createContextHandler } from './context/routes.js'

const ROUTE_PREFIX = '/opencontext-api'
const MAX_BODY_BYTES = 2 * 1024 * 1024

interface Backend {
  remember(input: Record<string, unknown>, opts?: unknown): Promise<{ ids: string[] }>
  search(input: Record<string, unknown>, opts?: unknown): Promise<unknown[]>
  list(input: Record<string, unknown>, opts?: unknown): Promise<unknown[]>
  uploadDocument(input: Record<string, unknown>, opts?: unknown): Promise<Record<string, unknown>>
  searchKnowledge(input: Record<string, unknown>, opts?: unknown): Promise<Record<string, unknown>>
  listDocuments(input: Record<string, unknown>, opts?: unknown): Promise<Record<string, unknown>>
  revise(input: Record<string, unknown>, opts?: unknown): Promise<{ deprecatedId: string; newId: string }>
  retire(input: Record<string, unknown>, opts?: unknown): Promise<{ ok: boolean }>
  get(input: { ids: string[] }, opts?: unknown): Promise<unknown[]>
}

type NodeRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

interface ApiRouteContext extends Context {
  readonly webServer: {
    register(route: {
      readonly kind: 'prefix'
      readonly path: string
      readonly handler: NodeRouteHandler
    }): () => void
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function send(res: ServerResponse, status: number, payload?: unknown): void {
  if (payload === undefined) {
    res.statusCode = status
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function sendError(res: ServerResponse, error: unknown): void {
  const details = record(error)
  const code = typeof details?.code === 'string' ? details.code : 'INTERNAL'
  const hint = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '操作未完成，请稍后重试。'
  const applyUrl = typeof details?.applyUrl === 'string' ? details.applyUrl : undefined
  send(res, 200, {
    ok: false,
    code,
    hint,
    ...(applyUrl === undefined ? {} : { applyUrl }),
  })
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += bytes.byteLength
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(bytes)
  }
  if (chunks.length === 0) return {}
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return record(value)
  } catch {
    return undefined
  }
}

function clampLimit(raw: string | null, fallback: number, max: number): number {
  const n = raw === null ? NaN : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

function isGraphType(value: string): value is 'memory' | 'summary' | 'document' {
  return value === 'memory' || value === 'summary' || value === 'document'
}

interface GraphSourceOptions {
  days?: number
  types?: Array<'memory' | 'summary' | 'document'>
  limit?: number
}

type GraphSource = (options: GraphSourceOptions) => object

/** Pure handler factory — the cordis wrapper below only wires services. */
export function createApiRoutesHandler(deps: { backend: Backend; graphSource?: GraphSource; contextService?: object }) {
  const { backend, graphSource } = deps
  const contextHandler = deps.contextService === undefined
    ? undefined
    : createContextHandler(deps.contextService) as NodeRouteHandler
  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    if (contextHandler !== undefined && (sub === '/context' || sub.startsWith('/context/'))) {
      await contextHandler(req, res)
      return
    }

    // GET /memories/:id — 单条详情（图谱节点点击的详情卡数据源）
    const getMatch = sub.match(/^\/memories\/([^/]+)$/)
    if (getMatch && req.method === 'GET') {
      const id = getMatch[1]
      if (id === undefined) { send(res, 404); return }
      try {
        const items = await backend.get({ ids: [id] })
        const item = items[0]
        if (item === undefined) {
          send(res, 200, { ok: false, code: 'NOT_FOUND', hint: `记忆 ${id} 不存在或已废弃` })
          return
        }
        send(res, 200, { ok: true, item })
      } catch (error) { sendError(res, error) }
      return
    }

    // /memories/:id/revise | /memories/:id/retire — id 是 message_id（dsh-前缀十六进制）
    const actionMatch = sub.match(/^\/memories\/([^/]+)\/(revise|retire)$/)
    if (actionMatch) {
      if (req.method !== 'POST') { send(res, 405); return }
      const ct = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
      if (ct !== 'application/json') { send(res, 415); return }
      const body = await readJsonBody(req)
      if (body === undefined) { send(res, 400); return }
      const id = actionMatch[1]
      const action = actionMatch[2]
      if (id === undefined || action === undefined) { send(res, 404); return }
      try {
        if (action === 'revise') {
          if (typeof body.content !== 'string' || body.content.length === 0) { send(res, 400); return }
          const out = await backend.revise({ id, content: body.content, reason: body.reason })
          send(res, 200, { ...out, ok: true })
        } else {
          const out = await backend.retire({ id, reason: body.reason })
          send(res, 200, { ...out, ok: true })
        }
      } catch (error) { sendError(res, error) }
      return
    }

    if (sub === '/memories') {
      if (req.method === 'POST') {
        const ct = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
        if (ct !== 'application/json') { send(res, 415); return }
        const body = await readJsonBody(req)
        if (body === undefined) { send(res, 400); return }
        if (typeof body.content !== 'string' || body.content.length === 0) { send(res, 400); return }
        try {
          const out = await backend.remember({
            content: body.content,
            sourceType: body.sourceType,
            metadata: body.metadata,
            userId: body.userId,
            botId: body.botId,
          })
          send(res, 200, { ok: true, ids: out.ids })
        } catch (error) { sendError(res, error) }
        return
      }
      if (req.method === 'GET') {
        const query = url.searchParams.get('query')?.trim()
        const limit = clampLimit(url.searchParams.get('limit'), 20, 200)
        const thresholdRaw = Number(url.searchParams.get('threshold'))
        try {
          const items = query
            ? await backend.search({
              query,
              limit,
              userId: url.searchParams.get('userId') ?? undefined,
              ...(Number.isFinite(thresholdRaw) ? { threshold: thresholdRaw } : {}),
            })
            : await backend.list({ limit, userId: url.searchParams.get('userId') ?? undefined })
          send(res, 200, { ok: true, items })
        } catch (error) { sendError(res, error) }
        return
      }
      send(res, 405)
      return
    }

    if (sub === '/documents') {
      if (req.method === 'POST') {
        const ct = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
        if (ct !== 'application/json') { send(res, 415); return }
        const body = await readJsonBody(req)
        if (body === undefined) { send(res, 400); return }
        if (typeof body.content !== 'string' || body.content.length === 0) { send(res, 400); return }
        if (typeof body.filename !== 'string' || body.filename.length === 0) { send(res, 400); return }
        try {
          const out = await backend.uploadDocument({
            content: body.content,
            filename: body.filename,
            mimeType: body.mimeType ?? 'text/markdown',
            metadata: body.metadata,
            scopeId: body.scopeId,
            userId: body.userId,
          })
          send(res, 200, { ...out, ok: true })
        } catch (error) { sendError(res, error) }
        return
      }
      if (req.method === 'GET') {
        const limit = clampLimit(url.searchParams.get('limit'), 50, 500)
        try {
          const out = await backend.listDocuments({ limit })
          send(res, 200, { ...out, ok: true })
        } catch (error) { sendError(res, error) }
        return
      }
      send(res, 405)
      return
    }

    if (sub === '/graph') {
      if (req.method !== 'GET') { send(res, 405); return }
      if (graphSource === undefined) {
        send(res, 200, { ok: false, code: 'GRAPH_UNAVAILABLE', hint: 'graph source not wired' })
        return
      }
      const days = clampLimit(url.searchParams.get('days'), 30, 365)
      const typesRaw = url.searchParams.get('types')
      const types = typesRaw !== null && typesRaw.length > 0
        ? typesRaw.split(',').map(type => type.trim()).filter(isGraphType)
        : undefined
      try {
        const graph = graphSource({ days, ...(types !== undefined ? { types } : {}) })
        send(res, 200, { ok: true, ...graph })
      } catch (error) { sendError(res, error) }
      return
    }

    if (sub === '/documents/search') {
      if (req.method !== 'GET') { send(res, 405); return }
      const query = url.searchParams.get('query')?.trim()
      if (!query) { send(res, 400); return }
      const limit = clampLimit(url.searchParams.get('limit'), 8, 50)
      const thresholdRaw = Number(url.searchParams.get('threshold'))
      try {
        const out = await backend.searchKnowledge({
          query,
          limit,
          threshold: Number.isFinite(thresholdRaw) ? thresholdRaw : 0.3,
        })
        send(res, 200, { ...out, ok: true })
      } catch (error) { sendError(res, error) }
      return
    }

    send(res, 404)
  }
}

/** Cordis sub-plugin: index.js does `ctx.plugin(createApiRoutesPlugin({backend, graphSource}))`. */
export function createApiRoutesPlugin(deps: { backend: Backend; graphSource?: GraphSource; contextService?: object }) {
  return {
    name: 'dsh-opencontext-api-routes',
    inject: ['webServer'],
    apply(ctx: ApiRouteContext) {
      const handler = createApiRoutesHandler(deps)
      ctx.effect(() => ctx.webServer.register({
        kind: 'prefix' as const,
        path: ROUTE_PREFIX,
        handler,
      }), 'dsh-opencontext: api routes')
    },
  }
}
