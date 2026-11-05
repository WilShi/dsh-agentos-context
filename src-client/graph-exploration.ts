import type {
  ContextGraph,
  ContextGraphEdge,
  ContextGraphNode,
} from './context-types.ts'

export type GraphOriginFilter = 'all' | 'current' | 'legacy'

export interface GraphExploreOptions {
  query?: string
  nodeTypes?: ReadonlySet<string>
  edgeTypes?: ReadonlySet<string>
  scopeIds?: ReadonlySet<string>
  origin?: GraphOriginFilter
}

export interface ExploredGraph {
  nodes: ContextGraphNode[]
  edges: ContextGraphEdge[]
  matchedNodeIds: string[]
  hiddenNodeCount: number
  hiddenEdgeCount: number
}

export interface GraphPath {
  nodeIds: string[]
  edgeIds: string[]
}

const normalized = (value: string) =>
  value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim()

function matchesNode(node: ContextGraphNode, options: GraphExploreOptions) {
  if (options.nodeTypes?.size && !options.nodeTypes.has(node.type)) return false
  if (options.scopeIds?.size && !options.scopeIds.has(node.scopeId)) return false
  if (options.origin === 'legacy' && node.legacy !== true) return false
  if (options.origin === 'current' && node.legacy === true) return false
  return true
}

function searchableNodeText(node: ContextGraphNode) {
  return normalized(
    `${node.label} ${node.type} ${node.subtype ?? ''} ${node.layer ?? ''} ${node.scopeId}`,
  )
}

/**
 * Produces the visible graph without imposing an arbitrary presentation cap.
 * Text search keeps direct hits and their one-hop context so a result never
 * appears detached from the relationship that made it useful.
 */
export function exploreGraph(
  graph: ContextGraph,
  options: GraphExploreOptions,
): ExploredGraph {
  const filteredNodes = graph.nodes.filter(node => matchesNode(node, options))
  const candidateIds = new Set(filteredNodes.map(node => node.id))
  const candidateEdges = graph.edges.filter(
    edge =>
      candidateIds.has(edge.source) &&
      candidateIds.has(edge.target) &&
      (!options.edgeTypes?.size || options.edgeTypes.has(edge.type)),
  )
  const relationshipNodeIds = new Set(
    candidateEdges.flatMap(edge => [edge.source, edge.target]),
  )
  const candidateNodes = options.edgeTypes?.size
    ? filteredNodes.filter(node => relationshipNodeIds.has(node.id))
    : filteredNodes
  const query = normalized(options.query ?? '')
  let nodes = candidateNodes
  let edges = candidateEdges
  let matchedNodeIds = candidateNodes.map(node => node.id)

  if (query) {
    matchedNodeIds = candidateNodes
      .filter(node => searchableNodeText(node).includes(query))
      .map(node => node.id)
    const visibleIds = new Set(matchedNodeIds)
    for (const edge of candidateEdges) {
      if (visibleIds.has(edge.source) || visibleIds.has(edge.target)) {
        visibleIds.add(edge.source)
        visibleIds.add(edge.target)
      }
    }
    nodes = candidateNodes.filter(node => visibleIds.has(node.id))
    edges = candidateEdges.filter(
      edge => visibleIds.has(edge.source) && visibleIds.has(edge.target),
    )
  }

  return {
    nodes,
    edges,
    matchedNodeIds,
    hiddenNodeCount: Math.max(0, graph.nodes.length - nodes.length),
    hiddenEdgeCount: Math.max(0, graph.edges.length - edges.length),
  }
}

export function graphNeighborhood(
  graph: Pick<ContextGraph, 'nodes' | 'edges'>,
  nodeId: string,
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const nodeIds = new Set<string>()
  const edgeIds = new Set<string>()
  if (!graph.nodes.some(node => node.id === nodeId)) return { nodeIds, edgeIds }
  nodeIds.add(nodeId)
  for (const edge of graph.edges) {
    if (edge.source !== nodeId && edge.target !== nodeId) continue
    edgeIds.add(edge.id)
    nodeIds.add(edge.source)
    nodeIds.add(edge.target)
  }
  return { nodeIds, edgeIds }
}

export function shortestGraphPath(
  graph: Pick<ContextGraph, 'nodes' | 'edges'>,
  sourceId: string,
  targetId: string,
): GraphPath | null {
  const nodeIds = new Set(graph.nodes.map(node => node.id))
  if (!nodeIds.has(sourceId) || !nodeIds.has(targetId)) return null
  if (sourceId === targetId) return { nodeIds: [sourceId], edgeIds: [] }
  const adjacency = new Map<string, Array<{ nodeId: string; edgeId: string }>>()
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue
    const source = adjacency.get(edge.source) ?? []
    source.push({ nodeId: edge.target, edgeId: edge.id })
    adjacency.set(edge.source, source)
    const target = adjacency.get(edge.target) ?? []
    target.push({ nodeId: edge.source, edgeId: edge.id })
    adjacency.set(edge.target, target)
  }
  const queue = [sourceId]
  const previous = new Map<string, { nodeId: string; edgeId: string }>()
  const visited = new Set([sourceId])
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    if (current === undefined) continue
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next.nodeId)) continue
      visited.add(next.nodeId)
      previous.set(next.nodeId, { nodeId: current, edgeId: next.edgeId })
      if (next.nodeId === targetId) {
        const pathNodes = [targetId]
        const pathEdges: string[] = []
        let cursor = targetId
        while (cursor !== sourceId) {
          const step = previous.get(cursor)
          if (!step) return null
          pathEdges.push(step.edgeId)
          pathNodes.push(step.nodeId)
          cursor = step.nodeId
        }
        pathNodes.reverse()
        pathEdges.reverse()
        return { nodeIds: pathNodes, edgeIds: pathEdges }
      }
      queue.push(next.nodeId)
    }
  }
  return null
}

export function nextSearchMatch(
  ids: readonly string[],
  currentId: string | null,
  direction: 1 | -1,
): string | null {
  if (!ids.length) return null
  const current = currentId ? ids.indexOf(currentId) : -1
  if (current < 0) return (direction === 1 ? ids[0] : ids[ids.length - 1]) ?? null
  return ids[(current + direction + ids.length) % ids.length] ?? null
}
