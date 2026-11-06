import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const key = process.env.AGENTOS_CONTEXT_API_KEY
if (!key) throw new Error('Set AGENTOS_CONTEXT_API_KEY (model gateway key) before running <Electron with ELECTRON_RUN_AS_NODE=1> scripts/verify-real-model-electron.mjs')

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}
function zip(files) {
  const localParts = [], centralParts = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name), data = Buffer.from(text), checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26)
    localParts.push(local, filename, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42)
    centralParts.push(central, filename); offset += local.length + filename.length + data.length
  }
  const directory = Buffer.concat(centralParts), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, directory, end])
}
const contentTypes = overrides => `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`
const relationship = (type, target) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${type}" Target="${target}"/></Relationships>`
const officeRelationship = target => relationship('http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target)
function docx() { return zip({
  '[Content_Types].xml': contentTypes('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'),
  '_rels/.rels': officeRelationship('word/document.xml'),
  'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word quality gate amber telescope</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
}) }
function xlsx() { return zip({
  '[Content_Types].xml': contentTypes('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'),
  '_rels/.rels': officeRelationship('xl/workbook.xml'),
  'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': relationship('http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet', 'worksheets/sheet1.xml'),
  'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Excel release matrix cobalt harbor</t></is></c></row></sheetData></worksheet>',
}) }
function pptx() { return zip({
  '[Content_Types].xml': contentTypes('<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'),
  '_rels/.rels': officeRelationship('ppt/presentation.xml'),
  'ppt/presentation.xml': '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
  'ppt/_rels/presentation.xml.rels': relationship('http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', 'slides/slide1.xml'),
  'ppt/slides/slide1.xml': '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/><p:sp><p:nvSpPr/><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>PowerPoint roadmap violet compass</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
}) }
function pdf() {
  const parts = ['%PDF-1.4\n'], offsets = [0], objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  for (const body of objects) { offsets.push(Buffer.byteLength(parts.join(''))); parts.push(`${offsets.length - 1} 0 obj\n${body}\nendobj\n`) }
  const stream = 'BT /F1 12 Tf 72 720 Td (PDF audit trail silver lantern) Tj ET'
  offsets.push(Buffer.byteLength(parts.join(''))); parts.push(`5 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`)
  const xref = Buffer.byteLength(parts.join(''))
  parts.push('xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(value => String(value).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.from(parts.join(''))
}
// Public build: the gateway is configured, never compiled in. Point the
// smoke test at a deployment through the documented environment variables.
const gateway = process.env.AGENTOS_CONTEXT_EMBEDDING_BASE_URL ?? 'http://127.0.0.1:8090/llm-service/v1'
process.env.OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES ??= gateway
let dimensions
const provider = {
  getModelName: () => 'bgem3-embedding',
  getDimensions: () => dimensions,
  async embedDocuments(texts) {
    const response = await fetch(gateway + '/bge/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'bgem3-embedding', input: texts }),
      signal: AbortSignal.timeout(60_000),
      redirect: 'error',
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`Embedding gateway failed: HTTP ${response.status}, code ${data?.code ?? 'unknown'}`)
    const vectors = (data.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(row => row.embedding)
    if (vectors.length !== texts.length || vectors.some(vector => !Array.isArray(vector) || !vector.length || vector.some(value => !Number.isFinite(value)))) throw new Error('Embedding gateway returned an invalid vector batch')
    dimensions = vectors[0].length
    return vectors
  },
  async embedQuery(text) {
    return (await provider.embedDocuments([text]))[0]
  },
}

const validationTempRoot = process.env.AGENTOS_BENCH_TMPDIR || os.tmpdir()
await mkdir(validationTempRoot, { recursive: true })
const home = await mkdtemp(path.join(validationTempRoot, 'agentos-context-electron-real-chain-'))
let service
let knowledge
try {
  console.error('[real-model-electron] imports')
  process.env.OPENCONTEXT_HOME = home
  const compat = await import('../src/web-runtime-compat.js')
  const [{ LibKnowledgeStore }, { createContextStore }, { createContextService }, { createContextVectorIndex }] = await Promise.all([
    import('../src/knowledge-store.js'),
    import('../src/context/store.js'),
    import('../src/context/service.js'),
    import('../src/context/vector-index.js'),
  ])
  compat.restoreNativeReadableStream()
  console.error('[real-model-electron] stores')
  const scopeId = 'local:electron-real-model-validation'
  await mkdir(path.join(home, 'agentos-context'), { recursive: true })
  const store = createContextStore({ dbPath: path.join(home, 'agentos-context', 'context.db') })
  const vectorIndex = createContextVectorIndex({ dbPath: path.join(home, 'agentos-context', 'context.db.vectors'), provider })
  knowledge = new LibKnowledgeStore({ provider })
  const legacy = {
    list: async () => [], get: async () => [], search: async () => [],
    uploadDocument: input => knowledge.uploadDocument(input),
    listDocuments: input => knowledge.listDocuments(input),
    searchKnowledge: input => knowledge.searchKnowledge(input),
    deleteDocument: input => knowledge.deleteDocument(input),
  }
  service = createContextService({ store, legacy, vectorIndex, config: { recallEnabled: true, ontologyEnabled: true }, defaultScope: () => scopeId })

  console.error('[real-model-electron] memory save/search')
  const memory = service.saveMemory({ scopeId, content: '用户偏好所有项目周报使用中文。', kind: 'preference' }, { actorRole: 'human', kind: 'real-model-validation' })
  const memoryHits = await service.search({ scopeId, query: '项目汇报应该采用什么语言', limit: 5, threshold: 0.1 })
  const memoryHit = memoryHits.find(row => row.id === memory.id)
  assert.ok(memoryHit, 'saved memory was not retrieved through the real embedding index')

  console.error('[real-model-electron] knowledge upload/search/delete')
  const uploaded = await service.uploadDocument({
    scopeId,
    filename: 'agentos-context-real-model-validation.txt',
    mimeType: 'text/plain',
    content: '质量门禁规定：发布记忆插件之前，必须完成真实模型、文档解析和语义检索验证。',
    metadata: { source: 'real-model-validation' },
  })
  const documentHits = await service.searchDocuments({ scopeId, query: '发布前需要完成哪些质量验证', limit: 5, threshold: 0.1 })
  assert.ok(documentHits.some(row => row.documentId === uploaded.documentId), 'uploaded document was not retrieved through the real embedding index')
  const formatFixtures = [
    ['docx', docx(), 'Word quality gate amber telescope'],
    ['xlsx', xlsx(), 'Excel release matrix cobalt harbor'],
    ['pptx', pptx(), 'PowerPoint roadmap violet compass'],
    ['pdf', pdf(), 'PDF audit trail silver lantern'],
  ]
  const formatResults = []
  for (const [extension, bytes, query] of formatFixtures) {
    const item = await service.uploadDocument({ scopeId, filename: `real-chain.${extension}`, mimeType: 'application/octet-stream', dataBase64: bytes.toString('base64'), metadata: { source: 'real-model-binary-validation' } })
    const hits = await service.searchDocuments({ scopeId, query, limit: 10, threshold: 0.05 })
    assert.ok(hits.some(row => row.documentId === item.documentId), `${extension} was parsed but not retrieved through the real embedding index`)
    formatResults.push({ extension, sourceFormat: item.sourceFormat, chunks: item.chunks, retrieved: true, documentId: item.documentId })
  }
  const listed = await service.listDocuments({ scopeId, limit: 20 })
  assert.equal(listed.length, formatResults.length + 1, 'knowledge list omitted an uploaded document')
  for (const documentId of [uploaded.documentId, ...formatResults.map(row => row.documentId)]) {
    const deleted = await service.deleteDocument({ scopeId, id: documentId })
    assert.equal(deleted.deleted, true, 'temporary document was not deleted')
  }
  assert.equal((await service.listDocuments({ scopeId, limit: 20 })).length, 0, 'temporary knowledge documents remain after cleanup')

  console.log(JSON.stringify({
    ok: true,
    embeddingModel: provider.getModelName(),
    dimensions,
    memory: { saved: true, retrieved: true, searchMode: memoryHit.metadata?.searchMode ?? null, score: memoryHit.score },
    knowledge: { uploaded: true, chunks: uploaded.chunks, retrieved: true, listed: true, deleted: true, binaryFormats: formatResults.map(({ documentId: _id, ...row }) => row) },
  }, null, 2))
} catch (error) {
  console.error('[real-model-electron] failure', error)
  throw error
} finally {
  console.error('[real-model-electron] cleanup')
  await Promise.allSettled([service?.close?.(), Promise.resolve().then(() => knowledge?.close?.())])
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}