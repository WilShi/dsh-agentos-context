import type {
  ConnectionFetchRoute,
  ConnectionRpcResult,
} from '@deepseek-ai/dsh-client-connection'
interface ContextClientRequest {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}
function parseClientRequest(value: unknown): ContextClientRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    record.type !== 'client-request' ||
    typeof record.rpcId !== 'string' ||
    typeof record.method !== 'string' ||
    !Object.hasOwn(record, 'payload')
  ) return null
  return {
    type: 'client-request',
    rpcId: record.rpcId,
    method: record.method,
    payload: record.payload,
  }
}
type ContextRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<ConnectionRpcResult<unknown>>
export const MAX_CONTEXT_RPC_REQUEST_BYTES = 36 * 1024 * 1024
export const CONTEXT_RPC_PREFIX = 'agentos-context/v1/'
export const CONTEXT_RPC_ENDPOINTS = [
  'bootstrap',
  'scopes',
  'memories',
  'memory',
  'versions',
  'entities',
  'graph',
  'reviews',
  'schema',
  'usage',
  'changes',
  'documents',
  'documents/search',
  'document/chunks',
  'document/upload',
  'document/reindex',
  'document/delete',
  'documents/delete',
  'memory/save',
  'memory/revise',
  'memory/transition',
  'memory/retire',
  'entity/create',
  'entity/merge',
  'relation/create',
  'relation/review',
  'schema/check',
  'usage/policy',
  'verify-key',
  'models',
] as const
async function readBody(request: Request) {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_CONTEXT_RPC_REQUEST_BYTES)
    return null
  if (!request.body) return ''
  const reader = request.body.getReader(),
    chunks = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_CONTEXT_RPC_REQUEST_BYTES) {
        try {
          await reader.cancel('request limit exceeded')
        } catch (_error) {
          // Cancellation is best-effort after the request limit has already won.
        }
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(x => Buffer.from(x))).toString('utf8')
}
const response = (rpcId: string, result: ConnectionRpcResult<unknown>) =>
  Response.json({ type: 'server-response', rpcId, result })
export function createContextRpcRoute(
  endpoint: string,
  handler: ContextRpcHandler,
): ConnectionFetchRoute {
  const method = CONTEXT_RPC_PREFIX + endpoint
  return {
    path: '/api/' + method,
    methods: ['POST'],
    requestBody: 'streaming',
    async fetch(request) {
      if (
        request.headers
          .get('content-type')
          ?.split(';', 1)[0]
          ?.trim()
          .toLowerCase() !== 'application/json'
      )
        return new Response('content type must be application/json', {
          status: 415,
        })
      let text
      try {
        text = await readBody(request)
      } catch {
        return new Response('body read failed', { status: 400 })
      }
      if (text === null)
        return new Response('request too large', { status: 413 })
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const parsed = parseClientRequest(raw)
      if (parsed === null)
        return new Response('invalid client request', { status: 400 })
      if (parsed.method !== method)
        return response(parsed.rpcId, {
          ok: false,
          error: {
            code: 'gateway/bad-request',
            message: 'RPC method does not match route',
            details: {},
          },
        })
      return response(
        parsed.rpcId,
        await handler(endpoint, parsed.payload, request.signal),
      )
    },
  }
}
