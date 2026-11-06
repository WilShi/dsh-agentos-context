/**
 * graph-builder — 直读 SQLite 组装知识图谱节点/边（M4）。
 *
 * 数据源（与 knowledge-store/doctor 同路径约定）：
 *   memory store.db   raw_messages（type=memory，subtype=metadata.sourceType 着色分组）
 *                     memory_summaries（type=summary；source_record_ids JSON → 摘要-成员边）
 *   dsh-knowledge.db  documents（type=document）
 * 边：
 *   supersedes  metadata.supersedes（修订链，新 → 旧）
 *   summarizes  memory_summaries.source_record_ids（摘要 → 成员记忆）
 *   references  metadata.documentId（记忆 → 文档）
 * 默认 30 天窗口、5000 节点上限（超出按时间截断 + stats.truncated=true）。
 *
 * SQL 面只用 prepare().all()/get() —— 单测以 node:sqlite 驱动，生产注入 better-sqlite3。
 */

interface SqlStatement {
  all(...args: unknown[]): unknown[]
}

interface SqlDatabase {
  prepare(sql: string): SqlStatement
}

export interface GraphNode {
  id: string
  type: 'memory' | 'summary' | 'document'
  subtype?: string | undefined
  label: string
  timestamp?: number | undefined
  deprecated?: boolean | undefined
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  type: 'supersedes' | 'summarizes' | 'references' | 'session'
}

export interface GraphStats {
  truncated: boolean
  windowDays: number
  nodeCount: number
  edgeCount: number
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: GraphStats
}

export interface GraphBuilderOptions {
  days?: number
  limit?: number
  types?: Array<'memory' | 'summary' | 'document'>
}

const DAY_MS = 24 * 3600 * 1000
const LABEL_MAX = 48
/** Per-kind safety bounds; overflowing either sets stats.truncated. */
const SUMMARY_NODE_LIMIT = 1000
const DOCUMENT_NODE_LIMIT = 1000

function truncateLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > LABEL_MAX ? flat.slice(0, LABEL_MAX - 1) + '…' : flat
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string' || text.length === 0) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}

interface MemoryRow {
  readonly id: string | number
  readonly messageId: string
  readonly timestamp?: number
  readonly content: string
  readonly metadata: Record<string, unknown>
  readonly deprecated: boolean
}

function memoryRow(value: unknown): MemoryRow | undefined {
  const row = record(value)
  if (row === undefined || typeof row.message_id !== 'string') return undefined
  const id = typeof row.id === 'string' || typeof row.id === 'number' ? row.id : row.message_id
  return {
    id,
    messageId: row.message_id,
    ...(typeof row.timestamp === 'number' ? { timestamp: row.timestamp } : {}),
    content: typeof row.content === 'string' ? row.content : '',
    metadata: record(parseJson(row.metadata)) ?? {},
    deprecated: row.deprecated_at !== null && row.deprecated_at !== undefined,
  }
}

interface SummaryRow {
  readonly id: string
  readonly text: string
  readonly sourceRecordIds: unknown
  readonly createdAt?: number
}

function summaryRow(value: unknown): SummaryRow | undefined {
  const row = record(value)
  if (row === undefined || typeof row.summary_id !== 'string') return undefined
  return {
    id: row.summary_id,
    text: typeof row.summary_text === 'string' ? row.summary_text : '',
    sourceRecordIds: parseJson(row.source_record_ids),
    ...(typeof row.created_at === 'number' ? { createdAt: row.created_at } : {}),
  }
}

interface DocumentRow {
  readonly id: string
  readonly filename: string
  readonly uploadedAt?: number
}

function documentRow(value: unknown): DocumentRow | undefined {
  const row = record(value)
  if (row === undefined || typeof row.id !== 'string') return undefined
  return {
    id: row.id,
    filename: typeof row.filename === 'string' ? row.filename : row.id,
    ...(typeof row.uploadedAt === 'number' ? { uploadedAt: row.uploadedAt } : {}),
  }
}

function scalarKey(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

export function buildGraph(
  memoryDb: SqlDatabase,
  knowledgeDb: SqlDatabase | undefined,
  options: GraphBuilderOptions = {},
): GraphData {
  const days = Math.max(1, options.days ?? 30)
  const limit = Math.max(1, Math.min(options.limit ?? 5000, 5000))
  const types = new Set(options.types ?? ['memory', 'summary', 'document'])
  const cutoffMs = Date.now() - days * DAY_MS

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  let truncated = false

  // ---- 记忆节点（窗口内按时间倒序，限量）----
  const rawMemoryRows = types.has('memory')
    ? memoryDb.prepare(
      `SELECT id, message_id, timestamp, content, metadata, deprecated_at
       FROM raw_messages
       WHERE timestamp >= ?
       ORDER BY timestamp DESC
       LIMIT ?`,
    ).all(cutoffMs, limit + 1)
    : []
  if (rawMemoryRows.length > limit) {
    truncated = true
    rawMemoryRows.length = limit
  }
  const memoryRows = rawMemoryRows.flatMap((value) => {
    const row = memoryRow(value)
    return row === undefined ? [] : [row]
  })
  const memoryIds = new Set<string>()
  // 摘要的 source_record_ids 存的是 raw_messages.id（整数行号，facade
  // toRawMessage.id=row.id 实证）；message_id 形态一并兼容。
  const memberKeyToNodeId = new Map<string, string>()
  for (const row of memoryRows) {
    memoryIds.add(row.messageId)
    memberKeyToNodeId.set(String(row.id), row.messageId)
    memberKeyToNodeId.set(row.messageId, row.messageId)
    nodes.push({
      id: row.messageId,
      type: 'memory',
      subtype: typeof row.metadata.sourceType === 'string' ? row.metadata.sourceType : undefined,
      label: truncateLabel(row.content),
      timestamp: row.timestamp,
      deprecated: row.deprecated,
    })
  }

  // ---- 摘要节点 ----
  if (types.has('summary')) {
    const summaryRows = memoryDb.prepare(
      `SELECT summary_id, end_timestamp, summary_text, source_record_ids, created_at
       FROM memory_summaries
       WHERE created_at >= ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(Math.floor(cutoffMs / 1000), SUMMARY_NODE_LIMIT + 1).flatMap((value) => {
      const row = summaryRow(value)
      return row === undefined ? [] : [row]
    })
    if (summaryRows.length > SUMMARY_NODE_LIMIT) {
      // Summary overflow is a real cut and must be reported like memory overflow.
      truncated = true
      summaryRows.length = SUMMARY_NODE_LIMIT
    }
    for (const row of summaryRows) {
      nodes.push({
        id: row.id,
        type: 'summary',
        label: truncateLabel(row.text),
        timestamp: row.createdAt === undefined ? undefined : row.createdAt * 1000,
      })
      if (Array.isArray(row.sourceRecordIds)) {
        for (const memberId of row.sourceRecordIds) {
          const key = scalarKey(memberId)
          if (key === undefined) continue
          const nodeId = memberKeyToNodeId.get(key)
          // 成员不在当前节点集（出窗/被截断）则不留 dangling 边
          if (nodeId === undefined) continue
          edges.push({ id: `${row.id}->${nodeId}:summarizes`, source: row.id, target: nodeId, type: 'summarizes' })
        }
      }
    }
  }

  // ---- 文档节点（knowledge 库）----
  const documentIds = new Set<string>()
  if (types.has('document') && knowledgeDb !== undefined) {
    const documentRows = knowledgeDb.prepare(
      `SELECT id, filename, uploadedAt, chunkCount, metadata
       FROM documents
       WHERE uploadedAt >= ?
       ORDER BY uploadedAt DESC
       LIMIT ?`,
    ).all(cutoffMs, DOCUMENT_NODE_LIMIT + 1).flatMap((value) => {
      const row = documentRow(value)
      return row === undefined ? [] : [row]
    })
    if (documentRows.length > DOCUMENT_NODE_LIMIT) {
      truncated = true
      documentRows.length = DOCUMENT_NODE_LIMIT
    }
    for (const row of documentRows) {
      documentIds.add(row.id)
      nodes.push({
        id: row.id,
        type: 'document',
        label: row.filename,
        timestamp: row.uploadedAt,
      })
    }
  }

  // ---- 修订链与文档引用边（源必须在本轮节点集内）----
  // 同会话时序链边（capture 写入 metadata.sessionId；相邻两条按时间序连接）
  const sessionChains = new Map<string, string[]>()
  for (const row of memoryRows) {
    const metadata = row.metadata
    if (typeof metadata.supersedes === 'string' && memoryIds.has(metadata.supersedes)) {
      edges.push({
        id: `${row.messageId}->${metadata.supersedes}:supersedes`,
        source: row.messageId,
        target: metadata.supersedes,
        type: 'supersedes',
      })
    }
    if (typeof metadata.documentId === 'string' && documentIds.has(metadata.documentId)) {
      edges.push({
        id: `${row.messageId}->${metadata.documentId}:references`,
        source: row.messageId,
        target: metadata.documentId,
        type: 'references',
      })
    }
    if (typeof metadata.sessionId === 'string' && metadata.sessionId.length > 0) {
      const chain = sessionChains.get(metadata.sessionId) ?? []
      chain.push(row.messageId)
      sessionChains.set(metadata.sessionId, chain)
    }
  }
  for (const chain of sessionChains.values()) {
    if (chain.length < 2) continue
    // memoryRows 已按 timestamp DESC 排列 —— 链内顺序为 新→旧，反转得 旧→新
    const chronological = [...chain].reverse()
    for (let i = 1; i < chronological.length; i++) {
      const source = chronological[i - 1]
      const target = chronological[i]
      if (source === undefined || target === undefined) continue
      edges.push({
        id: `${source}->${target}:session`,
        source,
        target,
        type: 'session',
      })
    }
  }

  return {
    nodes,
    edges,
    stats: {
      truncated,
      windowDays: days,
      nodeCount: nodes.length,
      edgeCount: edges.length,
    },
  }
}
