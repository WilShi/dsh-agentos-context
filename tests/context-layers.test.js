import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createContextStore } from '../src/context/store.js'
import { createContextService } from '../src/context/service.js'
import { createBackendBridge } from '../src/context/backend-bridge.js'

const scopeId = 'local:layers'
const source = content => ({ content, kind: 'test', actorRole: 'human', complete: true })

test('3+1 layers are stored independently from memory kind and can be filtered', t => {
  let now = 1_000
  const store = createContextStore({ dbPath: ':memory:', now: () => now })
  t.after(() => store.close())
  const working = store.saveMemory({ scopeId, content: 'temporary task state', kind: 'note', layer: 'working', importance: 0.3, expiresAt: 2_000, source: source('temporary task state') })
  const semantic = store.saveMemory({ scopeId, content: 'stable user preference', kind: 'preference', layer: 'semantic', importance: 0.9, source: source('stable user preference') })
  assert.equal(working.layer, 'working')
  assert.equal(semantic.layer, 'semantic')
  assert.deepEqual(store.listMemories({ scopeId, layer: 'working' }).map(x => x.id), [working.id])
  assert.deepEqual(store.listMemories({ scopeId, layer: 'semantic' }).map(x => x.id), [semantic.id])
  now = 3_000
  assert.equal(store.listMemories({ scopeId, layer: 'working' }).length, 0)
  const expired = store.expireMemories({ scopeId, at: now })
  assert.equal(expired.length, 1)
  assert.equal(store.getMemory(scopeId, working.id).lifecycle, 'retired')
})

test('promotion and reinforcement preserve source attribution without overwriting revisions', t => {
  let now = 1_000
  const store = createContextStore({ dbPath: ':memory:', now: () => ++now })
  t.after(() => store.close())
  const first = store.saveMemory({ scopeId, content: 'repeatable deployment lesson', kind: 'constraint', layer: 'working', importance: 0.4, expiresAt: 20_000, source: source('first observation') })
  const reinforced = store.reinforceMemory({ scopeId, id: first.id, expectedRevision: 1, layer: 'episodic', importance: 0.6, expiresAt: 30_000, source: source('second observation') })
  assert.equal(reinforced.revision, 2)
  assert.equal(reinforced.layer, 'episodic')
  assert.equal(reinforced.promotedFrom, 'working')
  assert.equal(reinforced.epistemic, 'supported')
  assert.equal(reinforced.metadata.evidenceCount, 2)
  assert.notEqual(reinforced.sourceId, first.sourceId)
  const promoted = store.transitionMemory({ scopeId, id: first.id, expectedRevision: 2, layer: 'procedural', importance: 0.85, expiresAt: null, reason: 'Reusable workflow confirmed.' })
  assert.equal(promoted.layer, 'procedural')
  assert.equal(promoted.expiresAt, null)
  assert.equal(promoted.sourceId, reinforced.sourceId)
  assert.deepEqual(store.versions(scopeId, first.id).map(x => x.layer), ['working', 'episodic', 'procedural'])
})

test('exact repeated evidence promotes working memory through episodic to semantic without embeddings', async t => {
  const store = createContextStore({ dbPath: ':memory:' })
  const legacy = { list: async () => [], get: async () => [], search: async () => [], dispose: async () => {} }
  const config = { memoryLayeringEnabled: true, autoConsolidate: true, dedupEnabled: true, workingMemoryHours: 24, episodicMemoryDays: 90 }
  const service = createContextService({ store, legacy, config, defaultScope: () => scopeId })
  const bridge = createBackendBridge({ service, legacy, config, defaultScope: () => scopeId })
  t.after(() => bridge.dispose())
  const write = lineageId => bridge.captureSource({ scopeId, content: 'repeatable operational fact', kind: 'fact', sourceType: 'user_input', metadata: { captureId: lineageId, sessionId: 'session-1' } }, { captureOrigin: { actorRole: 'human', sourceActorRole: 'human', sourceContent: 'repeatable operational fact', complete: true, lineageId, layer: 'working', importance: .4 } })
  const first = await write('message-1')
  await write('message-2')
  assert.equal(store.getMemory(scopeId, first.id).layer, 'episodic')
  await write('message-3')
  const promoted = store.getMemory(scopeId, first.id)
  assert.equal(promoted.layer, 'semantic')
  assert.equal(promoted.expiresAt, null)
  assert.equal(promoted.metadata.evidenceCount, 3)
})

test('manual layer changes receive configured retention defaults when no expiry is supplied', async t => {
  const store = createContextStore({ dbPath: ':memory:' })
  t.after(() => store.close())
  const service = createContextService({ store, legacy: { list: async () => [], get: async () => [], search: async () => [] }, config: { workingMemoryHours: 12, episodicMemoryDays: 45 }, defaultScope: () => scopeId })
  const memory = service.saveMemory({ scopeId, content: 'manual memory', kind: 'fact' }, { actorRole: 'human', kind: 'manual' })
  const working = await service.transitionMemory({ scopeId, id: memory.id, expectedRevision: memory.revision, layer: 'working', reason: 'Bound it to the current task.' })
  assert.ok(working.expiresAt > Date.now() + 11 * 60 * 60 * 1000)
  const procedural = await service.transitionMemory({ scopeId, id: memory.id, expectedRevision: working.revision, layer: 'procedural', reason: 'Confirmed reusable procedure.' })
  assert.equal(procedural.expiresAt, null)
})

test('schema exposes the 3+1 hierarchy without weakening ontology types', t => {
  const store = createContextStore({ dbPath: ':memory:' })
  t.after(() => store.close())
  const schema = store.getSchema()
  assert.equal(schema.version, 2)
  assert.deepEqual(schema.memoryLayers.map(x => x.id), ['working', 'episodic', 'semantic', 'procedural'])
  assert.ok(schema.types.some(x => x.id === 'Project'))
  assert.ok(schema.relations.some(x => x.id === 'depends_on'))
})

test('a real schema-v1 database migrates additively without rewriting historical JSON', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agentos-context-v1-'))
  const dbPath = path.join(dir, 'context.db')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let store = createContextStore({ dbPath, now: () => 10_000 })
  const original = store.saveMemory({ scopeId, content: 'legacy schema record', kind: 'fact', source: source('legacy schema record') })
  store.close()

  let db = new DatabaseSync(dbPath)
  db.exec('DROP TRIGGER ctx_memory_revisions_immutable_update')
  const oldRecord = JSON.parse(db.prepare('SELECT record_json FROM ctx_memory_revisions WHERE scope_id=? AND id=?').get(scopeId, original.id).record_json)
  delete oldRecord.layer
  delete oldRecord.importance
  delete oldRecord.expiresAt
  delete oldRecord.promotedFrom
  const oldJson = JSON.stringify(oldRecord)
  db.prepare('UPDATE ctx_memory_revisions SET record_json=? WHERE scope_id=? AND id=?').run(oldJson, scopeId, original.id)
  db.exec('DROP INDEX ctx_memory_layer; ALTER TABLE ctx_memory_revisions DROP COLUMN expires_at; ALTER TABLE ctx_memory_revisions DROP COLUMN importance; ALTER TABLE ctx_memory_revisions DROP COLUMN layer; PRAGMA user_version=1;')
  db.close()

  store = createContextStore({ dbPath, now: () => 20_000 })
  const migrated = store.getMemory(scopeId, original.id)
  assert.equal(migrated.layer, 'semantic')
  assert.equal(migrated.importance, 0.5)
  assert.equal(migrated.expiresAt, null)
  const added = store.saveMemory({ scopeId, content: 'new layered record', kind: 'note', layer: 'working', importance: .4, expiresAt: 30_000, source: source('new layered record') })
  assert.equal(added.layer, 'working')
  store.close()

  db = new DatabaseSync(dbPath)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2)
  assert.deepEqual(db.prepare('PRAGMA table_info(ctx_memory_revisions)').all().filter(row => ['layer', 'importance', 'expires_at'].includes(row.name)).map(row => row.name), ['layer', 'importance', 'expires_at'])
  assert.equal(db.prepare('SELECT record_json FROM ctx_memory_revisions WHERE scope_id=? AND id=?').get(scopeId, original.id).record_json, oldJson)
  db.close()
})
