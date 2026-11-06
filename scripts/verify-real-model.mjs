import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createDistiller } from '../src/gateway-distill.ts'
import { createGatewayEmbeddingProvider } from '../src/gateway-embedding-provider.ts'

const key = process.env.AGENTOS_CONTEXT_API_KEY
if (!key) throw new Error('Set AGENTOS_CONTEXT_API_KEY (model gateway key) before running: node --experimental-strip-types scripts/verify-real-model.mjs')

function yamlScalar(value) {
  const text = value.trim()
  if (text.startsWith('"') && text.endsWith('"')) return JSON.parse(text)
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'")
  return text
}

async function credentialRef(name) {
  const source = await readFile(credentialsPath, 'utf8')
  const match = source.match(new RegExp(`^  ${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}:\\s*(.+)$`, 'm'))
  if (!match) throw new Error(`Credential reference ${name} is unavailable in the supplied credential file`)
  const value = yamlScalar(match[1])
  if (!value) throw new Error(`Credential reference ${name} is empty`)
  return value
}

// Public build: the gateway is configured, never compiled in. Point the
// smoke test at a deployment through the documented environment variables.
const gateway = process.env.AGENTOS_CONTEXT_EMBEDDING_BASE_URL ?? 'http://127.0.0.1:8090/llm-service/v1'
process.env.OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES ??= gateway
const credentials = { resolve: async (name) => name === 'AGENTOS_CONTEXT_API_KEY' ? { value: key } : undefined }
const started = Date.now()
const nativeFetch = globalThis.fetch
let distillWire
let chatWire
globalThis.fetch = async (...args) => {
  const response = await nativeFetch(...args)
  const init = args[1]
  try {
    const payload = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    if (payload?.model === (process.env.AGENTOS_CONTEXT_CHAT_MODEL ?? 'gpt-4o-mini') || payload?.model === (process.env.AGENTOS_CONTEXT_CHAT_MODEL ?? 'gpt-4o-mini')) {
      const data = await response.clone().json()
      const message = data?.choices?.[0]?.message ?? {}
      const summary = {
        status: response.status,
        messageKeys: Object.keys(message),
        contentPreview: String(message.content ?? '').slice(0, 240),
        reasoningPreview: String(message.reasoning_content ?? '').slice(0, 240),
        finishReason: data?.choices?.[0]?.finish_reason ?? null,
      }
      if (payload.model === (process.env.AGENTOS_CONTEXT_CHAT_MODEL ?? 'gpt-4o-mini')) distillWire = summary
      else chatWire = summary
    }
  } catch {}
  return response
}

async function post(path, body, timeoutMs = 60_000) {
  const response = await fetch(gateway + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`Gateway ${path} failed: HTTP ${response.status}, code ${data?.code ?? 'unknown'}`)
  return data
}

const chatStarted = Date.now()
const chat = await post('/chat/completions', {
  model: (process.env.AGENTOS_CONTEXT_CHAT_MODEL ?? 'gpt-4o-mini'),
  reasoning_effort: 'max',
  max_tokens: 2048,
  messages: [{ role: 'user', content: 'This is a DSH model connectivity test. Reply with exactly DSH_REAL_MODEL_OK and nothing else.' }],
})
const chatText = String(chat?.choices?.[0]?.message?.content ?? '').trim()
assert.match(chatText, /DSH_REAL_MODEL_OK/, `configured DSH chat model did not return the required marker: ${JSON.stringify(chatWire)}`)
const chatElapsedMs = Date.now() - chatStarted

const distillStarted = Date.now()
const distiller = createDistiller({ credentials }, {
  embeddingBaseUrl: gateway,
  distillBaseUrl: '',
  apiKeyEnv: 'AGENTOS_CONTEXT_API_KEY',
  distillModel: (process.env.AGENTOS_CONTEXT_CHAT_MODEL ?? 'gpt-4o-mini'),
  distillTimeoutMs: 60_000,
  distillMaxTokens: 2048,
})
const resolvedDistillModel = await distiller.resolveChatModel()
assert.equal(resolvedDistillModel, (process.env.AGENTOS_CONTEXT_CHAT_MODEL ?? 'gpt-4o-mini'))
const distilled = await distiller.distill('用户长期偏好所有项目周报使用中文，并决定今后统一在每周一上午九点汇总。')
const distillElapsedMs = Date.now() - distillStarted
assert.ok(Array.isArray(distilled) && distilled.length > 0, `distillation produced no structured long-term memory: ${JSON.stringify(distillWire)}`)

const embeddingStarted = Date.now()
const embedding = createGatewayEmbeddingProvider({ credentials }, {
  embeddingBaseUrl: gateway,
  embeddingModel: 'bgem3-embedding',
  apiKeyEnv: 'AGENTOS_CONTEXT_API_KEY',
  embeddingBatchSize: 8,
  embeddingTimeoutMs: 60_000,
})
const vectors = await embedding.embedDocuments([
  'agentOS context real model validation document alpha',
  'agentOS context real model validation document beta',
])
const query = await embedding.embedQuery('agentOS context validation query')
assert.equal(vectors.length, 2, 'embedding batch response count mismatch')
assert.ok(vectors.every(vector => Array.isArray(vector) && vector.length > 0 && vector.every(Number.isFinite)), 'embedding batch contains an invalid vector')
assert.ok(Array.isArray(query) && query.length === vectors[0].length && query.every(Number.isFinite), 'embedding query vector is invalid')
const embeddingElapsedMs = Date.now() - embeddingStarted

const integrationStarted = Date.now()
const dataHome = await mkdtemp(path.join(os.tmpdir(), 'agentos-context-real-chain-'))
let service
let legacy
let memoryResult
let knowledgeResult
try {
  console.error('[real-model-check] integration: imports')
  process.env.OPENCONTEXT_HOME = dataHome
  const compat = await import('../src/web-runtime-compat.js')
  const [{ LibKnowledgeStore }, { createContextStore }, { createContextService }, { createContextVectorIndex }] = await Promise.all([
    import('../src/knowledge-store.js'),
    import('../src/context/store.js'),
    import('../src/context/service.js'),
    import('../src/context/vector-index.js'),
  ])
  compat.restoreNativeReadableStream()
  console.error('[real-model-check] integration: stores')
  const scopeId = 'local:real-model-validation'
  await mkdir(path.join(dataHome, 'agentos-context'), { recursive: true })
  const store = createContextStore({ dbPath: path.join(dataHome, 'agentos-context', 'context.db') })
  const vectorIndex = createContextVectorIndex({ dbPath: path.join(dataHome, 'agentos-context', 'context.db.vectors'), provider: embedding })
  const knowledge = new LibKnowledgeStore({ provider: embedding })
  legacy = {
    list: async () => [],
    get: async () => [],
    search: async () => [],
    uploadDocument: input => knowledge.uploadDocument(input),
    listDocuments: input => knowledge.listDocuments(input),
    searchKnowledge: input => knowledge.searchKnowledge(input),
    deleteDocument: input => knowledge.deleteDocument(input),
    dispose: () => knowledge.close(),
  }
  service = createContextService({ store, legacy, vectorIndex, config: { recallEnabled: true, ontologyEnabled: true }, defaultScope: () => scopeId })

  console.error('[real-model-check] integration: memory save/search')
  const saved = service.saveMemory({ scopeId, content: distilled[0], kind: 'preference' }, { actorRole: 'human', kind: 'real-model-validation' })
  const memoryHits = await service.search({ scopeId, query: '项目汇报采用什么语言', limit: 5, threshold: 0.1 })
  const matched = memoryHits.find(row => row.id === saved.id)
  assert.ok(matched, 'the real embedding did not retrieve the saved memory')
  memoryResult = { saved: true, retrieved: true, searchMode: matched.metadata?.searchMode ?? null, score: matched.score }

  console.error('[real-model-check] integration: knowledge upload/search/delete')
  const filename = 'agentos-context-real-model-validation.txt'
  const documentText = '质量门禁规定：发布记忆插件之前，必须完成真实模型、文档解析和语义检索验证。'
  const uploaded = await service.uploadDocument({ scopeId, filename, mimeType: 'text/plain', content: documentText, metadata: { source: 'real-model-validation' } })
  const documentHits = await service.searchDocuments({ scopeId, query: '发布前需要完成哪些质量验证', limit: 5, threshold: 0.1 })
  assert.ok(documentHits.some(row => row.documentId === uploaded.documentId), 'the real embedding did not retrieve the uploaded document')
  const deleted = await service.deleteDocument({ scopeId, id: uploaded.documentId })
  assert.equal(deleted.deleted, true, 'temporary knowledge document was not deleted')
  knowledgeResult = { uploaded: true, chunks: uploaded.chunks, retrieved: true, deleted: true }
} finally {
  console.error('[real-model-check] integration: cleanup')
  await Promise.allSettled([service?.close?.(), legacy?.dispose?.()])
  await rm(dataHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
const integrationElapsedMs = Date.now() - integrationStarted

console.log(JSON.stringify({
  ok: true,
  models: { chat: (process.env.AGENTOS_CONTEXT_CHAT_MODEL ?? 'gpt-4o-mini'), distill: resolvedDistillModel, embedding: embedding.getModelName() },
  chat: { markerObserved: true, outputPreview: chatText.slice(0, 120), wire: chatWire, elapsedMs: chatElapsedMs },
  distill: { memories: distilled.length, preview: distilled.map(item => item.slice(0, 120)), wire: distillWire, elapsedMs: distillElapsedMs },
  embedding: { documents: vectors.length, dimensions: query.length, elapsedMs: embeddingElapsedMs },
  integration: { memory: memoryResult, knowledge: knowledgeResult, temporaryDataRemoved: true, elapsedMs: integrationElapsedMs },
  elapsedMs: Date.now() - started,
}, null, 2))