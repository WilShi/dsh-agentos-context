import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createDistiller } from '../src/gateway-distill.ts'
import { createContextStore } from '../src/context/store.js'
import { createContextService } from '../src/context/service.js'

const key = process.env.AGENTOS_CONTEXT_API_KEY
if (!key) throw new Error('Set AGENTOS_CONTEXT_API_KEY (model gateway key) before running: node --experimental-strip-types scripts/verify-real-ontology.mjs')

const sourceText = '请长期记住这个项目事实：服务 Alpha 依赖 API Beta。'
// Public build: the gateway is configured, never compiled in. Point the
// smoke test at a deployment through the documented environment variables.
const gateway = process.env.AGENTOS_CONTEXT_EMBEDDING_BASE_URL ?? 'http://127.0.0.1:8090/llm-service/v1'
process.env.OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES ??= gateway
const distiller = createDistiller({ credentials: { resolve: async name => name === 'AGENTOS_CONTEXT_API_KEY' ? { value: key } : undefined } }, {
  embeddingBaseUrl: gateway,
  distillBaseUrl: '',
  apiKeyEnv: 'AGENTOS_CONTEXT_API_KEY',
  distillModel: process.env.AGENTOS_CONTEXT_CHAT_MODEL ?? 'gpt-4o-mini',
  distillTimeoutMs: 60_000,
  distillMaxTokens: 2048,
})
const envelope = await distiller.distillEnvelope(sourceText)
assert.ok(envelope && envelope.memories.length > 0, 'real model did not return a memory')
assert.ok(envelope.entities.length >= 2, 'real model did not return two typed entities')
assert.ok(envelope.relations.length > 0, 'real model did not return a source-backed relation')
assert.ok(envelope.relations.every(row => sourceText.includes(row.quote)), 'real model relation survived without an exact source quote')

const store = createContextStore({ dbPath: ':memory:' })
try {
  const scopeId = 'local:real-ontology-validation'
  const service = createContextService({ store, legacy: { list: async () => [], get: async () => [], search: async () => [] }, config: { ontologyEnabled: true }, defaultScope: () => scopeId })
  const memory = service.saveMemory({ scopeId, ...envelope.memories[0] }, { actorRole: 'assistant', sourceActorRole: 'human', kind: 'derived-capture', sourceContent: sourceText, complete: true })
  const result = await service.captureOntologyCandidates({ scopeId, sourceMemoryId: memory.id, entities: envelope.entities, relations: envelope.relations })
  assert.ok(result.relations.length > 0, 'real model candidates failed ontology/evidence validation')
  assert.ok(result.relations.every(row => row.status === 'pending'), 'real model relation was trusted without human review')
  console.log(JSON.stringify({ ok: true, model: process.env.AGENTOS_CONTEXT_CHAT_MODEL ?? 'gpt-4o-mini', memories: envelope.memories.length, entities: result.entities.length, pendingRelations: result.relations.length, exactQuotes: true }, null, 2))
} finally {
  store.close()
}