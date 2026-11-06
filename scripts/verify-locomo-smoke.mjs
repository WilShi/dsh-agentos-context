import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const key = process.env.AGENTOS_CONTEXT_API_KEY
const [datasetPath, reportPath, sampleArg = '0', perCategoryArg = '3'] = process.argv.slice(2)
if (!key || !datasetPath || !reportPath) {
  throw new Error('Usage: AGENTOS_CONTEXT_API_KEY=... node scripts/verify-locomo-smoke.mjs <locomo10.json> <report.json> [conversation-index=0] [questions-per-category=3]')
}

const sampleIndex = Number(sampleArg)
const perCategory = Number(perCategoryArg)
assert.ok(Number.isSafeInteger(sampleIndex) && sampleIndex >= 0 && sampleIndex < 10, 'conversation index must be 0..9')
assert.ok(Number.isSafeInteger(perCategory) && perCategory >= 1 && perCategory <= 20, 'questions per category must be 1..20')

// Deployment configuration comes from the environment (public build: no
// gateway URL is compiled in). Plain HTTP is limited to loopback hosts.
const gateway = process.env.AGENTOS_CONTEXT_EMBEDDING_BASE_URL ?? 'http://127.0.0.1:8090/llm-service/v1'
process.env.OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES ??= gateway
const chatModel = process.env.AGENTOS_CONTEXT_CHAT_MODEL || 'gpt-4o-mini'
const embeddingModel = process.env.AGENTOS_CONTEXT_EMBEDDING_MODEL || 'text-embedding-3-small'
const categoryNames = Object.freeze({ 1: 'multi-hop', 2: 'temporal', 3: 'open-domain', 4: 'single-hop' })

function progress(message) {
  console.error(`[locomo] ${message}`)
}

async function gatewayJson(pathname, key, body, timeoutMs = 60_000) {
  const response = await fetch(`${gateway}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`Gateway request failed: HTTP ${response.status}, code ${data?.code ?? 'unknown'}`)
  return data
}

async function postChat(key, messages, maxTokens = 320, reasoningEffort = 'medium') {
  const data = await gatewayJson('/chat/completions', key, {
    model: chatModel,
    reasoning_effort: reasoningEffort,
    max_tokens: maxTokens,
    temperature: 0,
    messages,
  })
  return String(data?.choices?.[0]?.message?.content ?? '').trim()
}

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/\b(a|an|the)\b/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function tokenF1(actual, expected) {
  const a = normalize(actual).split(/\s+/u).filter(Boolean)
  const e = normalize(expected).split(/\s+/u).filter(Boolean)
  if (!a.length || !e.length) return Number(a.length === e.length)
  const counts = new Map()
  for (const token of e) counts.set(token, (counts.get(token) ?? 0) + 1)
  let overlap = 0
  for (const token of a) {
    const remaining = counts.get(token) ?? 0
    if (remaining > 0) {
      overlap++
      counts.set(token, remaining - 1)
    }
  }
  if (!overlap) return 0
  const precision = overlap / a.length
  const recall = overlap / e.length
  return 2 * precision * recall / (precision + recall)
}

function evidenceIds(value) {
  return [...String(value ?? '').matchAll(/D\d+:\d+/gu)].map(match => match[0])
}

function conversationChunks(conversation, maxChars = 1_600) {
  const chunks = []
  const sessionKeys = Object.keys(conversation)
    .filter(key => /^session_\d+$/u.test(key))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)))
  for (const sessionKey of sessionKeys) {
    const number = sessionKey.slice(8)
    const date = String(conversation[`session_${number}_date_time`] ?? 'unknown date')
    const messages = Array.isArray(conversation[sessionKey]) ? conversation[sessionKey] : []
    let lines = []
    let ids = []
    const flush = () => {
      if (!lines.length) return
      chunks.push({
        content: [`Conversation date: ${date}`, ...lines].join('\n'),
        dialogueIds: [...ids],
        session: Number(number),
        date,
      })
      lines = []
      ids = []
    }
    for (const message of messages) {
      const caption = typeof message.blip_caption === 'string' && message.blip_caption.trim()
        ? ` [Image: ${message.blip_caption.trim()}]`
        : ''
      const line = `${message.speaker ?? 'Unknown'} (${message.dia_id ?? '?'}): ${message.text ?? ''}${caption}`
      const projected = [`Conversation date: ${date}`, ...lines, line].join('\n').length
      if (lines.length && projected > maxChars) flush()
      lines.push(line)
      for (const id of evidenceIds(message.dia_id)) ids.push(id)
    }
    flush()
  }
  return chunks
}

function evenlySelect(rows, count) {
  if (rows.length <= count) return [...rows]
  if (count === 1) return [rows[Math.floor(rows.length / 2)]]
  return Array.from({ length: count }, (_, index) => rows[Math.round(index * (rows.length - 1) / (count - 1))])
}

function percentile(values, quantile) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]
}

const dataset = JSON.parse(await readFile(datasetPath, 'utf8'))
assert.equal(dataset.length, 10, 'official LoCoMo dataset should contain ten conversations')
const sample = dataset[sampleIndex]
const selected = []
for (const category of [1, 2, 3, 4]) {
  const rows = sample.qa.filter(item => Number(item.category) === category)
  selected.push(...evenlySelect(rows, perCategory).map(item => ({ ...item, category })))
}
const chunks = conversationChunks(sample.conversation)
progress(`loaded ${dataset.length} conversations; selected ${sample.sample_id} with ${chunks.length} chunks and ${selected.length} questions`)

const benchmarkTempRoot = process.env.AGENTOS_BENCH_TMPDIR || os.tmpdir()
await mkdir(benchmarkTempRoot, { recursive: true })
const dataHome = await mkdtemp(path.join(benchmarkTempRoot, 'agentos-context-locomo-'))
let vectorIndex
let service
try {
  process.env.OPENCONTEXT_HOME = dataHome
  const compat = await import('../src/web-runtime-compat.js')
  const [{ createContextStore }, { createContextService }, { createContextVectorIndex }] = await Promise.all([
    import('../src/context/store.js'),
    import('../src/context/service.js'),
    import('../src/context/vector-index.js'),
  ])
  compat.restoreNativeReadableStream()
  await mkdir(path.join(dataHome, 'agentos-context'), { recursive: true })

  let embeddingDimensions
  const embedding = {
    getModelName: () => embeddingModel,
    getDimensions: () => embeddingDimensions,
    async embedQuery(text) {
      const data = await gatewayJson('/bge/embeddings', key, { model: embeddingModel, input: [String(text)] })
      const vector = data?.data?.[0]?.embedding
      assert.ok(Array.isArray(vector) && vector.length && vector.every(Number.isFinite), 'embedding gateway returned an invalid vector')
      embeddingDimensions = vector.length
      return vector
    },
  }

  const scopeId = `benchmark:locomo:${sample.sample_id}`
  const dbPath = path.join(dataHome, 'agentos-context', 'context.db')
  const store = createContextStore({ dbPath })
  vectorIndex = createContextVectorIndex({ dbPath: `${dbPath}.vectors`, provider: embedding })
  const legacy = {
    list: async () => [],
    get: async () => [],
    search: async () => [],
    dispose: () => {},
  }
  service = createContextService({
    store,
    legacy,
    vectorIndex,
    config: { recallEnabled: true, ontologyEnabled: false, memoryLayeringEnabled: true },
    defaultScope: () => scopeId,
  })

  const chunkEvidence = new Map()
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]
    const saved = service.saveMemory({
      scopeId,
      content: chunk.content,
      kind: 'episode',
      layer: 'semantic',
      idempotencyKey: `locomo:${sample.sample_id}:chunk:${index}`,
      metadata: { benchmark: 'LoCoMo', sampleId: sample.sample_id, session: chunk.session, date: chunk.date },
    }, { actorRole: 'human', sourceActorRole: 'human', kind: 'benchmark-source', sourceContent: chunk.content, complete: true })
    chunkEvidence.set(saved.id, new Set(chunk.dialogueIds))
  }
  progress(`queued ${chunks.length} source-backed memory chunks for real embedding`)

  const results = []
  const searchLatencies = []
  const answerLatencies = []
  for (let index = 0; index < selected.length; index++) {
    const item = selected[index]
    const searchStarted = performance.now()
    const hits = await service.search({ scopeId, query: item.question, limit: 10, threshold: 0.05 })
    searchLatencies.push(performance.now() - searchStarted)
    const expectedIds = new Set((item.evidence ?? []).flatMap(evidenceIds))
    const retrievedIds = new Set(hits.flatMap(hit => [...(chunkEvidence.get(hit.id) ?? [])]))
    const expectedFound = [...expectedIds].filter(id => retrievedIds.has(id))

    const answerStarted = performance.now()
    const answerMessages = [{
      role: 'user',
      content: [
        'Answer the question using only the retrieved conversation excerpts.',
        'Give only a short direct answer. Use the conversation dates when temporal reasoning is needed.',
        '',
        ...hits.map((hit, hitIndex) => `[${hitIndex + 1}] ${hit.content}`),
        '',
        `Question: ${item.question}`,
        'Short answer:',
      ].join('\n'),
    }]
    let answer = await postChat(key, answerMessages)
    if (!answer) answer = await postChat(key, answerMessages)
    answerLatencies.push(performance.now() - answerStarted)

    const expected = String(item.answer)
    const judgeExpected = item.category === 3 && expected.includes(';') ? expected.split(';')[0].trim() : expected
    const f1 = tokenF1(answer, expected)
    const judgeMessages = [{
      role: 'system',
      content: 'You are evaluating conversational AI memory recall. Return JSON only with the format requested.',
    }, {
      role: 'user',
      content: [
        'Label the generated answer as CORRECT or WRONG.',
        'Rules:',
        '1. If the generated answer includes at least one correct item from a gold-answer list, mark CORRECT. Partial credit counts.',
        '2. Paraphrases and semantically equivalent emotions or concepts count as CORRECT.',
        '3. Extra detail is fine when the gold answer core fact is present.',
        '4. Dates within 14 days and durations within 50% count as CORRECT.',
        '5. Only mark WRONG when the generated answer contains zero correct gold items or addresses a different topic.',
        `Question: ${item.question}`,
        `Gold answer: ${judgeExpected}`,
        `Generated answer: ${answer}`,
        'Return JSON with "reasoning" (one sentence) and "label" (CORRECT or WRONG).',
      ].join('\n'),
    }]
    let judge = await postChat(key, judgeMessages, 256, 'low')
    if (!judge) judge = await postChat(key, judgeMessages, 256, 'low')
    const verdicts = [...judge.matchAll(/\b(CORRECT|WRONG)\b/giu)]
    const judgeVerdict = verdicts.at(-1)?.[1]?.toLocaleUpperCase() ?? 'UNPARSEABLE'
    const judgeCorrect = judgeVerdict === 'CORRECT'
    results.push({
      category: item.category,
      categoryName: categoryNames[item.category],
      question: item.question,
      expected,
      answer,
      f1,
      judgeCorrect,
      judgeVerdict,
      judgeOutput: judge.slice(0, 500),
      expectedEvidence: [...expectedIds],
      retrievedEvidence: expectedFound,
      evidenceRecall: expectedIds.size ? expectedFound.length / expectedIds.size : null,
      retrievedMemoryIds: hits.map(hit => hit.id),
    })
    progress(`completed question ${index + 1}/${selected.length}: category ${item.category}, judge=${judgeCorrect ? 'correct' : 'wrong'}, f1=${f1.toFixed(3)}`)
  }

  const judged = results.filter(item => typeof item.judgeCorrect === 'boolean')
  const evidenceRows = results.filter(item => item.evidenceRecall !== null)
  const report = {
    ok: true,
    protocol: 'LoCoMo smoke test; one complete conversation; stratified categories 1-4; DSH memory retrieval; model judge',
    comparableToPublishedFullRun: false,
    dataset: {
      source: 'https://github.com/snap-research/locomo',
      mirror: 'https://www.modelscope.cn/datasets/evalscope/locomo',
      revision: '9b7296cb7c8e4954581fb5b77e90e347c831e3bf',
      totalConversations: dataset.length,
      totalQuestions: dataset.reduce((sum, row) => sum + row.qa.length, 0),
      standardQuestions: dataset.reduce((sum, row) => sum + row.qa.filter(item => Number(item.category) <= 4).length, 0),
      sampleIndex,
      sampleId: sample.sample_id,
      sampledQuestions: results.length,
      chunks: chunks.length,
    },
    models: { chat: chatModel, judge: chatModel, embedding: embeddingModel },
    scores: {
      judgeAccuracy: judged.filter(item => item.judgeCorrect).length / judged.length,
      meanTokenF1: results.reduce((sum, item) => sum + item.f1, 0) / results.length,
      evidenceRecall: evidenceRows.reduce((sum, item) => sum + item.evidenceRecall, 0) / evidenceRows.length,
      evidenceHitRate: evidenceRows.filter(item => item.evidenceRecall > 0).length / evidenceRows.length,
      byCategory: Object.fromEntries([1, 2, 3, 4].map(category => {
        const rows = results.filter(item => item.category === category)
        return [categoryNames[category], {
          questions: rows.length,
          judgeAccuracy: rows.filter(item => item.judgeCorrect).length / rows.length,
          meanTokenF1: rows.reduce((sum, item) => sum + item.f1, 0) / rows.length,
        }]
      })),
    },
    latencyMs: {
      searchP50: percentile(searchLatencies, 0.5),
      searchP95: percentile(searchLatencies, 0.95),
      answerP50: percentile(answerLatencies, 0.5),
      answerP95: percentile(answerLatencies, 0.95),
    },
    results,
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ report: reportPath, ...report.scores, latencyMs: report.latencyMs }, null, 2))
} finally {
  await Promise.allSettled([vectorIndex?.close?.(), service?.close?.()])
  await rm(dataHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}