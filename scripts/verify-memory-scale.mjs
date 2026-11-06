import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createContextStore } from '../src/context/store.js'
import { createContextService } from '../src/context/service.js'

const requested = Number(process.argv[2] ?? 10_000)
const recordCount = Number.isSafeInteger(requested) && requested >= 1_000 && requested <= 100_000 ? requested : 10_000
const primaryScope = 'workspace:scale-primary'
const foreignScope = 'workspace:scale-foreign'
const dataHome = await mkdtemp(path.join(os.tmpdir(), 'agentos-context-scale-'))
const store = createContextStore({ dbPath: path.join(dataHome, 'context.db') })
const legacy = {
  list: async () => [],
  get: async () => [],
  search: async () => [],
}
const service = createContextService({
  store,
  legacy,
  config: { recallEnabled: true, ontologyEnabled: false, memoryLayeringEnabled: true },
  defaultScope: () => primaryScope,
})

function marker(index) {
  return `PERF-${String(index).padStart(6, '0')}`
}

function percentile(values, quantile) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]
}

async function timedSearch(index) {
  const startedAt = performance.now()
  const hits = await service.search({ scopeId: primaryScope, query: marker(index), limit: 8, threshold: 0.3 })
  const elapsedMs = performance.now() - startedAt
  assert.ok(hits.some(hit => hit.content.includes(marker(index))), `record ${index} was not recalled`)
  assert.ok(hits.every(hit => hit.scopeId === primaryScope), `record ${index} leaked from another scope`)
  return elapsedMs
}

try {
  const insertStartedAt = performance.now()
  const records = []
  for (let index = 0; index < recordCount; index++) {
    records.push(service.saveMemory({
      scopeId: primaryScope,
      content: `性能回归记录 ${index}，唯一检索标识 ${marker(index)}，用于验证长历史中的早期与近期记忆都可召回。`,
      kind: 'fact',
      idempotencyKey: `scale-${index}`,
      metadata: { benchmark: 'memory-scale', index },
    }, { actorRole: 'human', kind: 'benchmark-fixture' }))
  }
  service.saveMemory({
    scopeId: foreignScope,
    content: `另一个工作区中的隔离探针 ${marker(0)}`,
    kind: 'fact',
    idempotencyKey: 'foreign-probe',
  }, { actorRole: 'human', kind: 'benchmark-fixture' })
  const insertMs = performance.now() - insertStartedAt

  const probeIndexes = [0, 1, Math.floor(recordCount / 4), Math.floor(recordCount / 2), recordCount - 2, recordCount - 1]
  const serialLatencies = []
  for (let round = 0; round < 4; round++) {
    for (const index of probeIndexes) serialLatencies.push(await timedSearch(index))
  }

  const concurrency = {}
  for (const width of [1, 10, 20]) {
    const indexes = Array.from({ length: width }, (_, offset) => (offset * 997 + 17) % recordCount)
    const startedAt = performance.now()
    const latencies = await Promise.all(indexes.map(timedSearch))
    const elapsedMs = performance.now() - startedAt
    concurrency[width] = {
      requests: width,
      elapsedMs,
      throughputPerSecond: width / Math.max(elapsedMs / 1000, 0.001),
      p50Ms: percentile(latencies, .5),
      p95Ms: percentile(latencies, .95),
    }
  }

  const revisionTarget = records[Math.floor(recordCount / 2)]
  const revisedMarker = 'PERF-REVISED-CURRENT'
  const revised = await service.reviseMemory({
    scopeId: primaryScope,
    id: revisionTarget.id,
    expectedRevision: revisionTarget.revision,
    content: `修订后的唯一事实 ${revisedMarker}`,
    reason: 'scale benchmark revision probe',
  }, { actorRole: 'human' })
  const revisedHits = await service.search({ scopeId: primaryScope, query: revisedMarker, limit: 8, threshold: 0.3 })
  assert.ok(revisedHits.some(hit => hit.id === revised.id && hit.revision === revised.revision), 'current revision was not recalled')
  const staleHits = await service.search({ scopeId: primaryScope, query: marker(Math.floor(recordCount / 2)), limit: 8, threshold: 0.3 })
  assert.ok(staleHits.every(hit => hit.id !== revised.id
    || (hit.revision === revised.revision && !hit.content.includes(marker(Math.floor(recordCount / 2))))), 'stale revision remained searchable')

  const retiredTarget = records[Math.floor(recordCount / 3)]
  await service.retireMemory({
    scopeId: primaryScope,
    id: retiredTarget.id,
    expectedRevision: retiredTarget.revision,
    reason: 'scale benchmark retirement probe',
  })
  const retiredHits = await service.search({ scopeId: primaryScope, query: marker(Math.floor(recordCount / 3)), limit: 8, threshold: 0.3 })
  assert.ok(retiredHits.every(hit => hit.id !== retiredTarget.id), 'retired memory remained searchable')

  const result = {
    ok: true,
    records: recordCount,
    insertMs,
    serial: {
      requests: serialLatencies.length,
      p50Ms: percentile(serialLatencies, .5),
      p95Ms: percentile(serialLatencies, .95),
      maxMs: Math.max(...serialLatencies),
    },
    concurrency,
    checks: {
      oldestRecordRecall: true,
      newestRecordRecall: true,
      workspaceIsolation: true,
      staleRevisionHidden: true,
      retiredMemoryHidden: true,
    },
  }
  console.log(JSON.stringify(result, null, 2))
  assert.ok(result.serial.p95Ms < 2_000, `serial search p95 ${result.serial.p95Ms}ms exceeded the 2000ms regression ceiling`)
  assert.ok(result.concurrency[20].elapsedMs < 15_000, `20-query batch ${result.concurrency[20].elapsedMs}ms exceeded the 15000ms regression ceiling`)
} finally {
  await service.close().catch(() => {})
  await rm(dataHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
