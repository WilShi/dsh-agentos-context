import { describe, expect, it, vi } from 'vitest'
import {
  ALL_SCOPES_ID,
  withAllScopes,
} from '../src-client/context-all-scopes.ts'
import type { ContextApi } from '../src-client/context-api.ts'
import type { ContextGraph, ContextMemory } from '../src-client/context-types.ts'

const memory = (scopeId: string, id: string, recordedAt: number): ContextMemory => ({
  id,
  revision: 1,
  scopeId,
  content: `${scopeId}:${id}`,
  kind: 'fact',
  layer: 'semantic',
  importance: 0.7,
  expiresAt: null,
  promotedFrom: null,
  lifecycle: 'active',
  epistemic: 'supported',
  sourceId: `source:${id}`,
  source: {
    id: `source:${id}`,
    scopeId,
    content: `${scopeId}:${id}`,
    kind: 'test',
    actorRole: 'human',
    complete: true,
    recordedAt,
    lineageId: `lineage:${id}`,
  },
  recordedAt,
  validFrom: null,
  validTo: null,
  metadata: {},
})

function apiDouble(overrides: Partial<ContextApi>): ContextApi {
  return overrides as ContextApi
}

describe('all-scopes context API', () => {
  it('merges memories by scope and orders the newest records first', async () => {
    const memories = vi.fn(async (scopeId: string) =>
      scopeId === 'old' ? [memory('old', 'same', 10)] : [memory('new', 'same', 20)],
    )
    const base = apiDouble({ memories })
    const api = withAllScopes(base, ['old', 'new'])
    const rows = await api.memories(ALL_SCOPES_ID, { limit: 10 })
    expect(rows.map(row => `${row.scopeId}:${row.recordedAt}`)).toEqual([
      'new:20',
      'old:10',
    ])
    expect(memories).toHaveBeenCalledTimes(2)
  })

  it('forwards Chinese literal searches to every scope before merging results', async () => {
    const product = {
      ...memory('product', 'p1', 20),
      content: '产品交付社区验证记忆',
    }
    const quality = {
      ...memory('quality', 'q1', 10),
      content: '质量保障社区验证记忆',
    }
    const memories = vi.fn(async (scopeId: string, options?: { query?: string }) => {
      const row = scopeId === 'product' ? product : quality
      return options?.query && !row.content.includes(options.query) ? [] : [row]
    })
    const base = apiDouble({ memories })

    const rows = await withAllScopes(base, ['product', 'quality']).memories(
      ALL_SCOPES_ID,
      { query: '产品交付', limit: 120 },
    )

    expect(rows.map(row => row.content)).toEqual(['产品交付社区验证记忆'])
    expect(memories).toHaveBeenCalledWith(
      'product',
      expect.objectContaining({ query: '产品交付', limit: 500 }),
      undefined,
    )
    expect(memories).toHaveBeenCalledWith(
      'quality',
      expect.objectContaining({ query: '产品交付', limit: 500 }),
      undefined,
    )
  })

  it('keeps graph identities isolated across workspaces', async () => {
    const graphSource = vi.fn(async (scopeId: string): Promise<ContextGraph> => ({
      nodes: [{ id: 'm1', type: 'memory', label: scopeId, scopeId }],
      edges: [],
      stats: { nodeCount: 1, edgeCount: 0, truncated: false },
    }))
    const base = apiDouble({ graph: graphSource })
    const graph = await withAllScopes(base, ['p', 'q']).graph(
      ALL_SCOPES_ID,
      {},
    )
    expect(graph.nodes).toHaveLength(2)
    expect(new Set(graph.nodes.map(node => node.id)).size).toBe(2)
    expect(graph.nodes.map(node => node.nativeId)).toEqual(['m1', 'm1'])
  })

  it('collapses the aggregate graph into one navigable community per scope', async () => {
    const graphSource = vi.fn(async (scopeId: string): Promise<ContextGraph> => ({
      nodes: [
        { id: 'memory', type: 'memory', label: `${scopeId} memory`, scopeId, timestamp: 20 },
        { id: 'source', type: 'source', label: `${scopeId} source`, scopeId, timestamp: 10 },
      ],
      edges: [{ id: 'evidence', source: 'memory', target: 'source', type: 'source' }],
      communities: [{
        id: 'community:native',
        label: `${scopeId} native`,
        summary: 'native community',
        nodeIds: ['memory', 'source'],
        size: 2,
        edgeCount: 1,
        externalEdgeCount: 0,
        topNodeIds: ['memory'],
        typeCounts: { memory: 1, source: 1 },
        scopeId,
      }],
      communityEdges: [],
      stats: { nodeCount: 2, edgeCount: 1, truncated: false, communityCount: 1 },
    }))
    const base = apiDouble({ graph: graphSource })

    const graph = await withAllScopes(base, ['workspace:a', 'workspace:b']).graph(
      ALL_SCOPES_ID,
      {},
    )

    expect(graph.communities).toHaveLength(2)
    expect(graph.communities?.map(row => row.scopeId)).toEqual([
      'workspace:a',
      'workspace:b',
    ])
    expect(graph.communities?.map(row => row.size)).toEqual([2, 2])
    expect(new Set(graph.nodes.map(node => node.communityId))).toEqual(
      new Set(graph.communities?.map(row => row.id)),
    )
    expect(graph.communityEdges ?? []).toEqual([])
    expect(graph.stats.communityCount).toBe(2)
  })
})
