export const DISPLAY_NAME = 'agentOS context'
export type MemoryKind = 'fact' | 'decision' | 'preference' | 'constraint' | 'outcome' | 'plan' | 'note'
export type MemoryLayer = 'working' | 'episodic' | 'semantic' | 'procedural'
export type ContextScopeKind = 'run' | 'agent' | 'workspace' | 'user' | 'app' | 'global' | 'unknown'

export interface ContextScope {
  id: string
  label: string
  count: number
  knowledgeCount?: number
  knowledgeChunks?: number
}

export interface CurrentContextScope { id: string; kind: ContextScopeKind }

export interface ContextSource {
  id: string
  scopeId: string
  content: string
  kind: string
  actorRole: 'human' | 'assistant' | 'agent' | 'tool' | 'unknown'
  complete: boolean
  recordedAt: number | null
  lineageId: string
}

export interface ContextMemory {
  id: string
  revision: number
  scopeId: string
  content: string
  kind: MemoryKind
  layer: MemoryLayer
  importance: number
  expiresAt: number | null
  promotedFrom: MemoryLayer | null
  lifecycle: 'active' | 'candidate' | 'retired'
  epistemic: 'unverified' | 'supported' | 'contested' | 'refuted'
  sourceId: string
  source: ContextSource
  recordedAt: number | null
  validFrom: number | null
  validTo: number | null
  metadata: Record<string, unknown>
  legacy?: boolean
  score?: number
}

export interface ContextEntity {
  id: string
  revision: number
  scopeId: string
  name: string
  type: string
  aliases: string[]
  recordedAt: number
}

export interface ContextRelation {
  id: string
  revision: number
  scopeId: string
  subjectId: string
  predicate: string
  objectId: string
  sourceId: string | null
  quote: string | null
  status: 'pending' | 'confirmed' | 'rejected'
  validFrom: number | null
  validTo: number | null
  recordedAt: number
}

export interface ContextGraphNode {
  id: string
  nativeId?: string
  type: string
  subtype?: string
  layer?: MemoryLayer
  importance?: number
  label: string
  status?: string
  timestamp?: number
  scopeId: string
  communityId?: string
  legacy?: boolean
}

export interface ContextGraphEdge {
  id: string
  source: string
  target: string
  type: string
  status?: string
  relationId?: string
  sourceId?: string
  quote?: string
  weight?: number
}

export interface ContextCommunity {
  id: string
  label: string
  summary: string
  nodeIds: string[]
  size: number
  edgeCount: number
  externalEdgeCount: number
  topNodeIds: string[]
  typeCounts: Record<string, number>
  scopeId: string
}

export interface ContextCommunityEdge { id: string; source: string; target: string; count: number; types: string[] }

export interface ContextGraph {
  nodes: ContextGraphNode[]
  edges: ContextGraphEdge[]
  communities?: ContextCommunity[]
  communityEdges?: ContextCommunityEdge[]
  stats: {
    nodeCount: number
    edgeCount: number
    truncated: boolean
    communityCount?: number
    totalNodeCount?: number
    totalEdgeCount?: number
  }
}

export interface ContextSchema {
  version: number
  memoryLayers: Array<{ id: MemoryLayer; label: string }>
  types: Array<{ id: string; label: string }>
  relations: Array<{ id: string; label: string; domain: string[]; range: string[] }>
}

export interface UsagePolicy {
  revision: number
  scopeId?: string
  paused: boolean
  excludedIds: string[]
  preferredIds: string[]
}

export interface ContextUsage {
  id: string
  sessionId: string
  scopeId: string
  messageId?: string
  turn?: number
  step?: number
  phase: 'planned' | 'committed' | 'requested' | 'failed'
  items: Array<{
    id: string
    scopeId?: string
    revision: number
    content: string
    sourceId?: string
    kind?: string
    truncated?: boolean
    legacy?: boolean
  }>
  recordedAt?: number
  at?: number
}

export interface ContextBootstrap {
  displayName: string
  scopes: ContextScope[]
  defaultScope: string
  sessionScope: string | null
  globalScope?: string | null
  currentScopes?: CurrentContextScope[]
  recallOrder?: string[]
  compatibilityScopes?: string[]
  features: { ontology: boolean; recall: boolean; capture: boolean }
  memoryLayers: MemoryLayer[]
  legacyScopeScanLimit: number
  /** Legacy plain-text diagnostics; kept for hosts older than warningDetails. */
  warnings: string[]
  /**
   * Structured form of the same diagnostics. Clients prefer this (stable code +
   * params, localizable) and fall back to `warnings` when a host omits it.
   */
  warningDetails?: ContextWarningDetail[]
}

/** Stable codes carried by {@link ContextBootstrap.warningDetails}. */
export type ContextWarningCode =
  | 'LEGACY_READ_FAILED'
  | 'LEGACY_PAGING_UNSUPPORTED'
  | 'LEGACY_SCAN_TRUNCATED'

/** One host-side diagnostic in machine-readable form. */
export interface ContextWarningDetail {
  code: ContextWarningCode | string
  message: string
  params?: Record<string, unknown>
}

export interface ContextChange { id: string; action: string; targetId: string; reason?: string; at: number; revision?: number }

export interface ContextDocument {
  id: string
  scopeId: string
  filename: string
  mimeType: string
  uploadedAt: number | null
  chunks: number
  metadata: Record<string, unknown>
  semanticIndexed?: boolean
  semanticPending?: boolean
  semanticModel?: string | null
  semanticDimensions?: number | null
}

export interface ContextDocumentHit {
  id: string
  scopeId?: string
  documentId: string
  documentName: string
  content: string
  chunkIndex: number
  score: number
  metadata: Record<string, unknown>
}

export interface ContextDocumentChunk {
  id: string
  scopeId: string
  documentId: string
  content: string
  chunkIndex: number
  metadata: Record<string, unknown>
}

export interface MemoryQuery {
  query?: string
  lifecycle?: string
  epistemic?: string
  layer?: MemoryLayer
  limit?: number
  knownAt?: number
  validAt?: number
}

export interface GraphQuery {
  rootId?: string
  depth?: number
  includePending?: boolean
  limit?: number
  knownAt?: number
  validAt?: number
}

export interface SaveMemory {
  scopeId: string
  content: string
  kind?: MemoryKind
  layer?: MemoryLayer
  importance?: number
  expiresAt?: number | null
  metadata?: Record<string, unknown>
  idempotencyKey?: string
  validFrom?: number | null
  validTo?: number | null
  entityIds?: string[]
}

export interface ReviseMemory {
  scopeId: string
  id: string
  expectedRevision: number
  content: string
  reason: string
  kind?: MemoryKind
  layer?: MemoryLayer
  importance?: number
  expiresAt?: number | null
  validFrom?: number | null
  validTo?: number | null
}

export interface CreateRelation {
  scopeId: string
  subjectId: string
  predicate: string
  objectId: string
  sourceId?: string
  sourceMemoryId?: string
  quote?: string
  validFrom?: number | null
  validTo?: number | null
}
