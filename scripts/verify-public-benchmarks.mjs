import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const key = process.env.AGENTOS_CONTEXT_API_KEY
const [financeBenchArg] = process.argv.slice(2)
const financeBenchPath = financeBenchArg ?? process.env.AGENTOS_FINANCEBENCH_PATH
if (!key || !financeBenchPath) {
  throw new Error('Usage: AGENTOS_CONTEXT_API_KEY=... node --experimental-strip-types scripts/verify-public-benchmarks.mjs <financebench_open_source.jsonl>')
}
function progress(message) {
  console.error(message)
  if (process.env.AGENTOS_BENCH_REPORT) writeFileSync(`${process.env.AGENTOS_BENCH_REPORT}.progress`, `${message}\n`, { encoding: 'utf8', flag: 'a' })
}
progress('[benchmark] loading public fixtures')

function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function numericTokens(value) {
  return [...String(value ?? '').matchAll(/(?<![\p{L}\p{N}])\$?(-?\d[\d,]*(?:\.\d+)?)(?:%|\b)(?![\p{L}])/gu)]
    .map(match => Number(match[1].replaceAll(',', '')))
    .filter(Number.isFinite)
}

function answerMatches(answer, expected) {
  const actual = normalized(answer)
  const target = normalized(expected)
  if (target && actual.includes(target)) return true
  const expectedPolarity = String(expected).trim().match(/^(yes|no)\b/iu)?.[1]?.toLocaleLowerCase()
  const actualPolarity = String(answer).trim().match(/^(yes|no)\b/iu)?.[1]?.toLocaleLowerCase()
  if (expectedPolarity && expectedPolarity !== actualPolarity) return false
  const expectedNumbers = numericTokens(expected)
  const actualNumbers = numericTokens(answer)
  return expectedNumbers.length > 0 && expectedNumbers.every(value => actualNumbers.some(candidate => Math.abs(candidate - value) < 1e-9))
}

async function postChat(gateway, key, model, question, evidence) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(`${gateway}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        reasoning_effort: 'medium',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: [
            'Answer the question using only the evidence below. Give a short direct answer. If the evidence is insufficient, say insufficient evidence.',
            '',
            ...evidence.map((item, index) => `[${index + 1}] ${item}`),
            '',
            `Question: ${question}`,
          ].join('\n'),
        }],
      }),
      signal: AbortSignal.timeout(60_000),
      redirect: 'error',
    })
    const data = await response.json().catch(() => ({}))
    const content = String(data?.choices?.[0]?.message?.content ?? '').trim()
    if (response.ok && content) return content
    const retryable = response.ok || [408, 425, 429, 500, 502, 503, 504].includes(response.status)
    if (!retryable || attempt === 3) {
      if (!response.ok) throw new Error(`Gateway chat failed: HTTP ${response.status}, code ${data?.code ?? 'unknown'}`)
      throw new Error('Gateway chat returned an empty answer after 3 attempts')
    }
    await new Promise(resolve => setTimeout(resolve, 500 * attempt))
  }
  throw new Error('Gateway chat retry loop ended unexpectedly')
}

function financeRows(source) {
  const rows = source.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line))
    .filter(row => Array.isArray(row.evidence) && row.evidence.length && typeof row.doc_name === 'string' && row.doc_name)
  const answerSample = []
  const documents = new Set()
  for (const row of rows) {
    if (row.question_reasoning !== 'Information extraction'
      || !/^\$?[\d,.]+%?$/u.test(String(row.answer).trim())) continue
    if (documents.has(row.doc_name)) continue
    documents.add(row.doc_name)
    answerSample.push(row)
    if (answerSample.length >= 6) break
  }
  assert.equal(answerSample.length, 6, 'FinanceBench did not provide six distinct numeric-answer documents')
  return { rows, answerSample }
}

function financeDocuments(rows) {
  const documents = new Map()
  for (const row of rows) {
    const document = documents.get(row.doc_name) ?? { company: row.company, pages: new Map(), questionIds: [] }
    document.questionIds.push(row.financebench_id)
    for (const evidence of row.evidence) {
      const text = String(evidence.evidence_text_full_page ?? evidence.evidence_text ?? '').trim()
      if (!text) continue
      const page = String(evidence.evidence_page_num ?? 'unknown')
      const key = `${page}\0${text}`
      if (!document.pages.has(key)) document.pages.set(key, { page, text })
    }
    documents.set(row.doc_name, document)
  }
  return documents
}

function percentile(values, quantile) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]
}

function deterministicVector(text, dimensions = 512) {
  const vector = new Array(dimensions).fill(0)
  const terms = String(text).normalize('NFKC').toLocaleLowerCase().match(/[a-z0-9][a-z0-9._%-]*|[\p{Script=Han}]/gu) ?? []
  for (const term of terms) {
    let hash = 2166136261
    for (const character of term) {
      hash ^= character.codePointAt(0)
      hash = Math.imul(hash, 16777619) >>> 0
    }
    vector[hash % dimensions] += 1
  }
  const norm = Math.hypot(...vector) || 1
  return vector.map(value => value / norm)
}

const fixture = JSON.parse(await readFile(path.join(here, '..', 'tests', 'fixtures', 'public-benchmarks', 'memoryagentbench-longmemeval.json'), 'utf8'))
let finance = financeRows(await readFile(financeBenchPath, 'utf8'))
const maxFinanceDocuments = Number(process.env.AGENTOS_BENCH_MAX_DOCUMENTS || 0)
if (Number.isSafeInteger(maxFinanceDocuments) && maxFinanceDocuments > 0) {
  const selectedDocuments = new Set()
  for (const row of finance.rows) {
    selectedDocuments.add(row.doc_name)
    if (selectedDocuments.size >= maxFinanceDocuments) break
  }
  const rows = finance.rows.filter(row => selectedDocuments.has(row.doc_name))
  finance = { rows, answerSample: finance.answerSample.filter(row => selectedDocuments.has(row.doc_name)) }
}
progress(`[benchmark] parsed ${finance.rows.length} FinanceBench questions`)
// Deployment configuration comes from the environment (public build: no
// gateway URL is compiled in). Plain HTTP is limited to loopback hosts.
const gateway = process.env.AGENTOS_CONTEXT_EMBEDDING_BASE_URL ?? 'http://127.0.0.1:8090/llm-service/v1'
process.env.OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES ??= gateway
const chatModel = process.env.AGENTOS_CONTEXT_CHAT_MODEL ?? 'gpt-4o-mini'
progress('[benchmark] resolved local model credential')
const deterministic = process.env.AGENTOS_BENCH_DETERMINISTIC === '1'
const skipChat = process.env.AGENTOS_BENCH_SKIP_CHAT === '1'
let embeddingDimensions
const embedding = {
  getModelName: () => deterministic ? 'deterministic-lexical-hash-512' : 'bgem3-embedding',
  getDimensions: () => embeddingDimensions,
  async embedDocuments(texts) {
    if (deterministic) {
      embeddingDimensions = 512
      return texts.map(text => deterministicVector(text, embeddingDimensions))
    }
    const vectors = []
    for (let index = 0; index < texts.length; index += 8) {
      const batch = texts.slice(index, index + 8)
      let response
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          response = await fetch(`${gateway}/bge/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({ model: 'bgem3-embedding', input: batch }),
            signal: AbortSignal.timeout(60_000),
            redirect: 'error',
          })
          if (response.ok || ![408, 425, 429, 500, 502, 503, 504].includes(response.status)) break
        } catch (error) {
          if (attempt === 3) throw error
        }
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 500 * attempt))
      }
      const data = await response?.json().catch(() => ({})) ?? {}
      if (!response) throw new Error('Embedding gateway failed without a response')
      if (!response.ok) throw new Error(`Embedding gateway failed: HTTP ${response.status}, code ${data?.code ?? 'unknown'}`)
      const rows = (data.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(row => row.embedding)
      assert.equal(rows.length, batch.length, 'embedding gateway returned the wrong vector count')
      assert.ok(rows.every(row => Array.isArray(row) && row.length && row.every(Number.isFinite)), 'embedding gateway returned an invalid vector')
      embeddingDimensions = rows[0].length
      vectors.push(...rows)
    }
    return vectors
  },
  async embedQuery(text) {
    return (await embedding.embedDocuments([text]))[0]
  },
}

const benchmarkTempRoot = process.env.AGENTOS_BENCH_TMPDIR || os.tmpdir()
await mkdir(benchmarkTempRoot, { recursive: true })
const dataHome = await mkdtemp(path.join(benchmarkTempRoot, 'agentos-context-public-benchmark-'))
let vectorIndex
let service
let legacy
try {
  process.env.OPENCONTEXT_HOME = dataHome
  const compat = await import('../src/web-runtime-compat.js')
  const [{ LibKnowledgeStore }, { createContextStore }, { createContextService }, { createContextVectorIndex }] = await Promise.all([
    import('../src/knowledge-store.js'),
    import('../src/context/store.js'),
    import('../src/context/service.js'),
    import('../src/context/vector-index.js'),
  ])
  progress('[benchmark] loaded Electron-native stores')
  compat.restoreNativeReadableStream()
  await mkdir(path.join(dataHome, 'agentos-context'), { recursive: true })
  const scopeId = 'local:public-benchmark-validation'
  const contextDb = path.join(dataHome, 'agentos-context', 'context.db')
  const store = createContextStore({ dbPath: contextDb })
  vectorIndex = createContextVectorIndex({ dbPath: `${contextDb}.vectors`, provider: embedding })
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
  service = createContextService({
    store,
    legacy,
    vectorIndex,
    config: { recallEnabled: true, ontologyEnabled: true, memoryLayeringEnabled: true },
    defaultScope: () => scopeId,
  })
  progress('[benchmark] initialized temporary memory and knowledge stores')

  const distractors = [
    'The user prefers window seats when flying internationally.',
    'The project release meeting takes place every Thursday afternoon.',
    'The old aquarium filter was replaced with a quieter model last winter.',
    'The user uses brown sugar in a separate banana bread recipe.',
  ]
  distractors.forEach((content, index) => service.saveMemory({
    scopeId,
    content,
    kind: 'fact',
    idempotencyKey: `public-benchmark-distractor-${index}`,
  }, { actorRole: 'human', kind: 'benchmark-fixture', sourceContent: content }))

  const memoryCases = []
  for (const item of fixture.retrievalCases) {
    const saved = item.evidence.map((content, index) => service.saveMemory({
      scopeId,
      content,
      kind: item.questionType.includes('preference') ? 'preference' : 'fact',
      idempotencyKey: `${item.id}-${index}`,
      metadata: { benchmark: fixture.benchmark, caseId: item.id, questionType: item.questionType },
    }, { actorRole: 'human', kind: 'benchmark-fixture', sourceContent: content }))
    const hits = await service.search({ scopeId, query: item.question, limit: 6, threshold: 0.05 })
    const ranks = saved.map(row => hits.findIndex(hit => hit.id === row.id) + 1)
    const recalled = ranks.filter(rank => rank > 0).length
    const response = deterministic || skipChat ? null : await postChat(gateway, key, chatModel, item.question, hits.map(hit => hit.content))
    memoryCases.push({
      id: item.id,
      questionType: item.questionType,
      expectedEvidence: saved.length,
      recalledEvidence: recalled,
      evidenceRanks: ranks,
      answer: response,
      expectedAnswer: item.answer,
      answerCorrect: response === null ? null : answerMatches(response, item.answer),
    })
    progress(`[benchmark] completed memory case ${memoryCases.length}/${fixture.retrievalCases.length}`)
  }

  const revision = fixture.revisionCase
  const initial = service.saveMemory({
    scopeId,
    content: revision.initial,
    kind: 'fact',
    idempotencyKey: revision.id,
    metadata: { benchmark: fixture.benchmark, caseId: revision.id, questionType: revision.questionType },
  }, { actorRole: 'human', kind: 'benchmark-fixture', sourceContent: revision.initial })
  const updated = await service.reviseMemory({
    scopeId,
    id: initial.id,
    expectedRevision: initial.revision,
    content: revision.updated,
    reason: 'MemoryAgentBench knowledge-update fixture',
  }, { actorRole: 'human' })
  const revisionHits = await service.search({ scopeId, query: revision.question, limit: 6, threshold: 0.05 })
  const revisionResponse = deterministic || skipChat ? null : await postChat(gateway, key, chatModel, revision.question, revisionHits.map(hit => hit.content))
  const revisionResult = {
    id: revision.id,
    revision: updated.revision,
    updatedValueVisible: revisionHits.some(hit => hit.id === updated.id && hit.revision === updated.revision && hit.content === revision.updated),
    staleValueVisible: revisionHits.some(hit => hit.id === initial.id && hit.revision === initial.revision),
    answer: revisionResponse,
    expectedAnswer: revision.answer,
    answerCorrect: revisionResponse === null ? null : answerMatches(revisionResponse, revision.answer),
  }
  progress('[benchmark] memory retrieval and revision cases complete')

  const financeDocumentIds = new Map()
  const uploadedIds = []
  const financeCorpus = financeDocuments(finance.rows)
  let uploadedDocumentCount = 0
  for (const [docName, document] of financeCorpus) {
    const content = [...document.pages.values()].map((page, index) => [
      `FinanceBench evidence page ${index + 1}`,
      `Company: ${document.company}`,
      `Document: ${docName}`,
      `Page: ${page.page}`,
      page.text,
    ].join('\n')).join('\n\n')
    const uploaded = await service.uploadDocument({
      scopeId,
      filename: `${docName}.txt`,
      mimeType: 'text/plain',
      content,
      metadata: { benchmark: 'FinanceBench', docName, questionIds: document.questionIds, source: 'public-open-source' },
    })
    uploadedIds.push(uploaded.documentId)
    financeDocumentIds.set(docName, { documentId: uploaded.documentId, chunks: uploaded.chunks })
    uploadedDocumentCount++
    if (uploadedDocumentCount % 20 === 0 || uploadedDocumentCount === financeCorpus.size) progress(`[benchmark] indexed ${uploadedDocumentCount}/${financeCorpus.size} FinanceBench documents`)
  }

  const retrievalCases = []
  const retrievalEvidence = new Map()
  const retrievalLatencies = []
  for (const row of finance.rows) {
    const startedAt = performance.now()
    const hits = await service.searchDocuments({ scopeId, query: row.question, limit: 10, threshold: 0.05, searchMode: deterministic ? 'keyword' : 'hybrid' })
    retrievalLatencies.push(performance.now() - startedAt)
    const expected = financeDocumentIds.get(row.doc_name)
    const rank = hits.findIndex(hit => hit.documentId === expected.documentId) + 1
    retrievalEvidence.set(row.financebench_id, hits.slice(0, 8).map(hit => hit.content))
    retrievalCases.push({
      id: row.financebench_id,
      document: row.doc_name,
      reasoning: row.question_reasoning ?? 'unspecified',
      rank,
      expectedChunks: expected.chunks,
      topDocuments: hits.slice(0, 5).map(hit => hit.documentName),
    })
    if (retrievalCases.length % 50 === 0 || retrievalCases.length === finance.rows.length) progress(`[benchmark] queried ${retrievalCases.length}/${finance.rows.length} FinanceBench cases`)
  }

  const answerCases = []
  if (!deterministic && !skipChat) {
    for (const row of finance.answerSample) {
      const answer = await postChat(gateway, key, chatModel, row.question, retrievalEvidence.get(row.financebench_id) ?? [])
      answerCases.push({
        id: row.financebench_id,
        question: row.question,
        rank: retrievalCases.find(item => item.id === row.financebench_id)?.rank ?? 0,
        answer,
        expectedAnswer: row.answer,
        answerCorrect: answerMatches(answer, row.answer),
      })
    }
  }

  const totalEvidence = memoryCases.reduce((sum, item) => sum + item.expectedEvidence, 0)
  const recalledEvidence = memoryCases.reduce((sum, item) => sum + item.recalledEvidence, 0)
  const memoryEvidenceRecall = recalledEvidence / totalEvidence
  const memoryAnswerAccuracy = deterministic || skipChat ? null : memoryCases.filter(item => item.answerCorrect).length / memoryCases.length
  const hitAt1 = retrievalCases.filter(item => item.rank === 1).length / retrievalCases.length
  const hitAt3 = retrievalCases.filter(item => item.rank > 0 && item.rank <= 3).length / retrievalCases.length
  const hitAt5 = retrievalCases.filter(item => item.rank > 0 && item.rank <= 5).length / retrievalCases.length
  const meanReciprocalRank = retrievalCases.reduce((sum, item) => sum + (item.rank > 0 ? 1 / item.rank : 0), 0) / retrievalCases.length
  const knowledgeAnswerAccuracy = answerCases.length ? answerCases.filter(item => item.answerCorrect).length / answerCases.length : null

  for (const id of uploadedIds) {
    const deleted = await service.deleteDocument({ scopeId, id })
    assert.equal(deleted.deleted, true, `temporary FinanceBench document ${id} was not deleted`)
  }
  progress(`[benchmark] deleted ${uploadedIds.length} temporary FinanceBench documents`)
  const report = {
    ok: memoryEvidenceRecall >= 0.8
      && (memoryAnswerAccuracy === null || memoryAnswerAccuracy >= 0.75)
      && revisionResult.updatedValueVisible
      && !revisionResult.staleValueVisible
      && (revisionResult.answerCorrect === null || revisionResult.answerCorrect)
      && hitAt3 >= 0.8
      && (knowledgeAnswerAccuracy === null || knowledgeAnswerAccuracy >= 0.66),
    models: { chat: deterministic || skipChat ? null : chatModel, embedding: embedding.getModelName() },
    datasets: {
      memory: { name: fixture.benchmark, source: fixture.source, license: fixture.license, cases: memoryCases.length + 1 },
      knowledge: { name: 'FinanceBench', source: 'https://github.com/patronus-ai/financebench', license: 'CC BY-NC 4.0', retrievalCases: retrievalCases.length, answerCases: answerCases.length, documents: financeDocumentIds.size },
    },
    memory: { evidenceRecall: memoryEvidenceRecall, answerAccuracy: memoryAnswerAccuracy, cases: memoryCases, revision: revisionResult },
    knowledge: {
      hitAt1,
      hitAt3,
      hitAt5,
      meanReciprocalRank,
      answerAccuracy: knowledgeAnswerAccuracy,
      latencyMs: { p50: percentile(retrievalLatencies, .5), p95: percentile(retrievalLatencies, .95), max: Math.max(...retrievalLatencies) },
      missesAt5: retrievalCases.filter(item => item.rank === 0 || item.rank > 5),
      answerCases,
    },
    temporaryDataRemoved: true,
  }
  const reportJson = JSON.stringify(report, null, 2)
  if (process.env.AGENTOS_BENCH_REPORT) await writeFile(process.env.AGENTOS_BENCH_REPORT, reportJson + '\n', 'utf8')
  progress('[benchmark] report written')
  console.log(reportJson)

  assert.ok(memoryEvidenceRecall >= 0.8, `MemoryAgentBench evidence recall ${memoryEvidenceRecall} is below 0.8`)
  if (memoryAnswerAccuracy !== null) assert.ok(memoryAnswerAccuracy >= 0.75, `MemoryAgentBench answer accuracy ${memoryAnswerAccuracy} is below 0.75`)
  assert.equal(revisionResult.updatedValueVisible, true, 'revised memory is not retrievable')
  assert.equal(revisionResult.staleValueVisible, false, 'stale memory revision leaked into retrieval')
  if (revisionResult.answerCorrect !== null) assert.equal(revisionResult.answerCorrect, true, 'model did not answer from the updated memory value')
  assert.ok(hitAt3 >= 0.8, `FinanceBench Hit@3 ${hitAt3} is below 0.8`)
  if (knowledgeAnswerAccuracy !== null) assert.ok(knowledgeAnswerAccuracy >= 0.66, `FinanceBench answer accuracy ${knowledgeAnswerAccuracy} is below 0.66`)
} finally {
  await Promise.allSettled([vectorIndex?.close?.(), service?.close?.(), legacy?.dispose?.()])
  await rm(dataHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}