import { describe, expect, it } from 'vitest'
import type {
  ContextGraph,
  ContextGraphEdge,
  ContextGraphNode,
} from '../src-client/context-types.ts'
import {
  exploreGraph,
  graphNeighborhood,
  nextSearchMatch,
  shortestGraphPath,
} from '../src-client/graph-exploration.ts'

function graph(
  nodes: ContextGraphNode[],
  edges: ContextGraphEdge[] = [],
): ContextGraph {
  return {
    nodes,
    edges,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      truncated: false,
    },
  }
}

describe('context graph exploration', () => {
  it('keeps a complete 1000-node graph when no visual filter is active', () => {
    const input = graph(
      Array.from({ length: 1000 }, (_, index) => ({
        id: `memory-${index}`,
        type: 'memory',
        layer: 'semantic',
        label: `Memory ${index}`,
        scopeId: 'workspace:a',
      })),
    )

    const result = exploreGraph(input, {})

    expect(result.nodes).toHaveLength(1000)
    expect(result.matchedNodeIds).toHaveLength(1000)
    expect(result.hiddenNodeCount).toBe(0)
    expect(result.hiddenEdgeCount).toBe(0)
  })

  it('filters by node type, relation type, origin and scope without dangling edges', () => {
    const input = graph(
      [
        { id: 'a', type: 'memory', label: 'Alpha', scopeId: 'one' },
        { id: 'b', type: 'entity', label: 'Beta', scopeId: 'one' },
        { id: 'c', type: 'entity', label: 'Gamma', scopeId: 'two', legacy: true },
      ],
      [
        { id: 'ab', source: 'a', target: 'b', type: 'mentions' },
        { id: 'bc', source: 'b', target: 'c', type: 'depends_on' },
      ],
    )

    const result = exploreGraph(input, {
      nodeTypes: new Set(['memory', 'entity']),
      edgeTypes: new Set(['mentions']),
      origin: 'current',
      scopeIds: new Set(['one']),
    })

    expect(result.nodes.map(node => node.id)).toEqual(['a', 'b'])
    expect(result.edges.map(edge => edge.id)).toEqual(['ab'])
    expect(
      result.edges.every(edge =>
        result.nodes.some(
          node => node.id === edge.source || node.id === edge.target,
        ),
      ),
    ).toBe(true)
  })

  it('keeps direct search hits plus their visible one-hop context', () => {
    const input = graph(
      [
        { id: 'a', type: 'memory', label: 'Release Alpha', scopeId: 'one' },
        { id: 'b', type: 'entity', label: 'Gateway', scopeId: 'one' },
        { id: 'c', type: 'entity', label: 'Unrelated', scopeId: 'one' },
      ],
      [{ id: 'ab', source: 'a', target: 'b', type: 'mentions' }],
    )

    const result = exploreGraph(input, { query: 'alpha' })

    expect(result.matchedNodeIds).toEqual(['a'])
    expect(result.nodes.map(node => node.id)).toEqual(['a', 'b'])
    expect(result.edges.map(edge => edge.id)).toEqual(['ab'])
  })

  it('computes neighborhoods and the shortest selectable relationship path', () => {
    const input = graph(
      ['a', 'b', 'c', 'd'].map(id => ({
        id,
        type: 'entity',
        label: id.toUpperCase(),
        scopeId: 'one',
      })),
      [
        { id: 'ab', source: 'a', target: 'b', type: 'related' },
        { id: 'bc', source: 'b', target: 'c', type: 'related' },
        { id: 'ad', source: 'a', target: 'd', type: 'related' },
        { id: 'dc', source: 'd', target: 'c', type: 'related' },
      ],
    )

    expect([...graphNeighborhood(input, 'a').nodeIds].sort()).toEqual([
      'a',
      'b',
      'd',
    ])
    expect(shortestGraphPath(input, 'a', 'c')).toEqual({
      nodeIds: ['a', 'b', 'c'],
      edgeIds: ['ab', 'bc'],
    })
  })

  it('cycles search matches forward and backward', () => {
    const ids = ['a', 'b', 'c']
    expect(nextSearchMatch(ids, null, 1)).toBe('a')
    expect(nextSearchMatch(ids, 'a', 1)).toBe('b')
    expect(nextSearchMatch(ids, 'a', -1)).toBe('c')
    expect(nextSearchMatch([], 'a', 1)).toBeNull()
  })
})
