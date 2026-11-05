import type { ContextApi } from './context-api.ts'
import type {
  ContextChange,
  ContextCommunity,
  ContextCommunityEdge,
  ContextDocument,
  ContextEntity,
  ContextGraph,
  ContextGraphEdge,
  ContextGraphNode,
  ContextMemory,
  ContextRelation,
} from './context-types.ts'
import { formatScopeLabel } from './context-ui-helpers.tsx'

/** UI-only scope used to browse every durable scope without changing recall. */
export const ALL_SCOPES_ID = 'agentos-context:all-scopes'

const distinct = (scopeIds: string[]) =>
  [...new Set(scopeIds.filter(value => value && value !== ALL_SCOPES_ID))]

const scopedKey = (row: { scopeId?: string; id: string }) =>
  `${row.scopeId ?? ''}\u0000${row.id}`

function uniqueByScope<T extends { scopeId?: string; id: string }>(rows: T[]): T[] {
  return [...new Map(rows.map(row => [scopedKey(row), row])).values()]
}

function newest<T extends { recordedAt?: number | null }>(rows: T[]): T[] {
  return rows.sort((a, b) => (b.recordedAt ?? 0) - (a.recordedAt ?? 0))
}

function newestDocuments(rows: ContextDocument[]): ContextDocument[] {
  return rows.sort((a, b) => (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0))
}

const graphId = (scopeId: string, id: string) =>
  `all|${encodeURIComponent(scopeId)}|${encodeURIComponent(id)}`
const graphCommunityId = (scopeId: string, id: string) =>
  `community:${graphId(scopeId, id)}`
const scopeCommunityId = (scopeId: string) =>
  `community:scope:${encodeURIComponent(scopeId)}`

function decodeGraphId(value: string): { scopeId: string; id: string } | null {
  if (!value.startsWith('all|')) return null
  const parts = value.split('|')
  if (parts.length !== 3) return null
  const encodedScopeId = parts[1]
  const encodedId = parts[2]
  if (encodedScopeId === undefined || encodedId === undefined) return null
  try {
    return { scopeId: decodeURIComponent(encodedScopeId), id: decodeURIComponent(encodedId) }
  } catch {
    return null
  }
}

function qualifyGraph(scopeId: string, graph: ContextGraph): ContextGraph {
  const qualify = (id: string) => graphId(scopeId, id)
  const qualifyCommunity = (id: string) => graphCommunityId(scopeId, id)
  const nodes: ContextGraphNode[] = graph.nodes.map(node => ({
    ...node,
    id: qualify(node.id),
    nativeId: node.id,
    scopeId: node.scopeId || scopeId,
    ...(node.communityId
      ? { communityId: qualifyCommunity(node.communityId) }
      : {}),
  }))
  const edges: ContextGraphEdge[] = graph.edges.map(edge => ({
    ...edge,
    id: qualify(edge.id),
    source: qualify(edge.source),
    target: qualify(edge.target),
  }))
  const communities = graph.communities?.map(community => ({
    ...community,
    id: qualifyCommunity(community.id),
    nodeIds: community.nodeIds.map(qualify),
    topNodeIds: community.topNodeIds.map(qualify),
    scopeId: community.scopeId || scopeId,
  }))
  const communityEdges = graph.communityEdges?.map(edge => ({
    ...edge,
    id: qualify(edge.id),
    source: qualifyCommunity(edge.source),
    target: qualifyCommunity(edge.target),
  }))
  return {
    nodes,
    edges,
    ...(communities ? { communities } : {}),
    ...(communityEdges ? { communityEdges } : {}),
    stats: { ...graph.stats, nodeCount: nodes.length, edgeCount: edges.length },
  }
}

function mergeGraphs(graphs: ContextGraph[], limit = 2000): ContextGraph {
  const allNodes = graphs.flatMap(graph => graph.nodes)
  const nodes = allNodes
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .slice(0, Math.max(1, limit))
  const nodeIds = new Set(nodes.map(node => node.id))
  const allEdges = graphs.flatMap(graph => graph.edges)
  const edges = allEdges
    .filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target))
  const nodesByScope = new Map<string, ContextGraphNode[]>()
  for (const node of nodes) {
    const members = nodesByScope.get(node.scopeId) ?? []
    members.push(node)
    nodesByScope.set(node.scopeId, members)
  }
  const communities: ContextCommunity[] = [...nodesByScope]
    .map(([scopeId, members]) => {
      const memberIds = new Set(members.map(node => node.id))
      const internalEdges = edges.filter(
        edge => memberIds.has(edge.source) && memberIds.has(edge.target),
      )
      const externalEdges = edges.filter(
        edge => memberIds.has(edge.source) !== memberIds.has(edge.target),
      )
      const typeCounts: Record<string, number> = {}
      for (const node of members)
        typeCounts[node.type] = (typeCounts[node.type] ?? 0) + 1
      const ranked = [...members].sort(
        (a, b) =>
          (b.importance ?? 0) - (a.importance ?? 0) ||
          (b.timestamp ?? 0) - (a.timestamp ?? 0) ||
          a.id.localeCompare(b.id),
      )
      return {
        id: scopeCommunityId(scopeId),
        label: formatScopeLabel(scopeId, scopeId),
        summary: `聚合这个范围内的 ${members.length} 个节点和 ${internalEdges.length} 条关系。`,
        nodeIds: members.map(node => node.id),
        size: members.length,
        edgeCount: internalEdges.length,
        externalEdgeCount: externalEdges.length,
        topNodeIds: ranked.slice(0, 5).map(node => node.id),
        typeCounts,
        scopeId,
      }
    })
    .sort(
      (a, b) =>
        b.size - a.size ||
        b.edgeCount - a.edgeCount ||
        a.scopeId.localeCompare(b.scopeId),
    )
  const communityByNode = new Map<string, string>()
  for (const community of communities)
    for (const id of community.nodeIds) communityByNode.set(id, community.id)
  const mergedNodes = nodes.map(node => ({
    ...node,
    communityId: scopeCommunityId(node.scopeId),
  }))
  const communityEdgeMap = new Map<string, ContextCommunityEdge>()
  for (const edge of edges) {
    const source = communityByNode.get(edge.source)
    const target = communityByNode.get(edge.target)
    if (!source || !target || source === target) continue
    const [left, right] = source < target ? [source, target] : [target, source]
    const key = `${left}\u0000${right}`
    const current = communityEdgeMap.get(key)
    if (current) {
      communityEdgeMap.set(key, {
        ...current,
        count: current.count + 1,
        types: [...new Set([...current.types, edge.type])].sort(),
      })
    } else {
      communityEdgeMap.set(key, {
        id: `community-edge:scope:${encodeURIComponent(key)}`,
        source: left,
        target: right,
        count: 1,
        types: [edge.type],
      })
    }
  }
  const communityEdges = [...communityEdgeMap.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  )
  return {
    nodes: mergedNodes,
    edges,
    ...(communities.length ? { communities } : {}),
    ...(communityEdges.length ? { communityEdges } : {}),
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      totalNodeCount: graphs.reduce(
        (sum, graph) => sum + (graph.stats.totalNodeCount ?? graph.nodes.length),
        0,
      ),
      totalEdgeCount: graphs.reduce(
        (sum, graph) => sum + (graph.stats.totalEdgeCount ?? graph.edges.length),
        0,
      ),
      truncated:
        graphs.some(graph => graph.stats.truncated) || allNodes.length > nodes.length,
      communityCount: communities.length,
    },
  }
}

/**
 * Adds an aggregate read-only scope on top of the existing authenticated API.
 * Writes continue to use real scope ids chosen by the calling component.
 */
export function withAllScopes(api: ContextApi, inputScopeIds: string[]): ContextApi {
  const scopeIds = distinct(inputScopeIds)
  const all = (scopeId: string) => scopeId === ALL_SCOPES_ID
  const onlyScope = scopeIds.length === 1 ? scopeIds[0] : null
  return {
    ...api,
    memories: async (scopeId, options = {}, signal) => {
      if (!all(scopeId)) return api.memories(scopeId, options, signal)
      if (onlyScope) return api.memories(onlyScope, options, signal)
      const requestedLimit = options.limit ?? 100
      const rows = await Promise.all(
        scopeIds.map(id => api.memories(id, { ...options, limit: 500 }, signal)),
      )
      return newest(uniqueByScope(rows.flat())).slice(0, requestedLimit)
    },
    memory: async (scopeId, id, signal) => {
      if (!all(scopeId)) return api.memory(scopeId, id, signal)
      if (onlyScope) return api.memory(onlyScope, id, signal)
      const decoded = decodeGraphId(id)
      if (decoded) return api.memory(decoded.scopeId, decoded.id, signal)
      const results = await Promise.allSettled(
        scopeIds.map(candidate => api.memory(candidate, id, signal)),
      )
      const hit = results.find(
        (result): result is PromiseFulfilledResult<ContextMemory> => result.status === 'fulfilled',
      )
      if (hit) return hit.value
      throw new Error('没有找到这条记忆。')
    },
    versions: async (scopeId, id, signal) => {
      if (!all(scopeId)) return api.versions(scopeId, id, signal)
      if (onlyScope) return api.versions(onlyScope, id, signal)
      const decoded = decodeGraphId(id)
      if (decoded) return api.versions(decoded.scopeId, decoded.id, signal)
      const rows = await Promise.all(scopeIds.map(candidate => api.versions(candidate, id, signal)))
      return newest(uniqueByScope(rows.flat()))
    },
    entities: async (scopeId, query, signal) => {
      if (!all(scopeId)) return api.entities(scopeId, query, signal)
      if (onlyScope) return api.entities(onlyScope, query, signal)
      const rows = await Promise.all(scopeIds.map(id => api.entities(id, query, signal)))
      return newest(uniqueByScope(rows.flat()) as ContextEntity[])
    },
    graph: async (scopeId, options = {}, signal) => {
      if (!all(scopeId)) return api.graph(scopeId, options, signal)
      if (onlyScope) return api.graph(onlyScope, options, signal)
      const decodedRoot = options.rootId ? decodeGraphId(options.rootId) : null
      const targets = decodedRoot ? [decodedRoot.scopeId] : scopeIds
      const graphs = await Promise.all(
        targets.map(async id =>
          qualifyGraph(
            id,
            await api.graph(
              id,
              {
                ...options,
                ...((decodedRoot?.id ?? options.rootId) !== undefined
                  ? { rootId: decodedRoot?.id ?? options.rootId }
                  : {}),
              },
              signal,
            ),
          ),
        ),
      )
      return mergeGraphs(graphs, options.limit ?? 2000)
    },
    reviews: async (scopeId, signal) => {
      if (!all(scopeId)) return api.reviews(scopeId, signal)
      if (onlyScope) return api.reviews(onlyScope, signal)
      const rows = await Promise.all(scopeIds.map(id => api.reviews(id, signal)))
      return newest(uniqueByScope(rows.flat()) as ContextRelation[])
    },
    changes: async (scopeId, signal) => {
      if (!all(scopeId)) return api.changes(scopeId, signal)
      if (onlyScope) return api.changes(onlyScope, signal)
      const rows = await Promise.all(scopeIds.map(id => api.changes(id, signal)))
      return (rows.flat() as ContextChange[]).sort((a, b) => b.at - a.at)
    },
    documents: async (scopeId, limit = 100, signal) => {
      if (!all(scopeId)) return api.documents(scopeId, limit, signal)
      if (onlyScope) return api.documents(onlyScope, limit, signal)
      const rows = await Promise.all(scopeIds.map(id => api.documents(id, 200, signal)))
      return newestDocuments(uniqueByScope(rows.flat()) as ContextDocument[]).slice(0, limit)
    },
    searchDocuments: async (scopeId, query, options = {}, signal) => {
      if (!all(scopeId)) return api.searchDocuments(scopeId, query, options, signal)
      if (onlyScope) return api.searchDocuments(onlyScope, query, options, signal)
      const limit = options.limit ?? 12
      const rows = await Promise.all(
        scopeIds.map(async id =>
          (await api.searchDocuments(id, query, { ...options, limit: 50 }, signal))
            .map(hit => ({ ...hit, scopeId: id })),
        ),
      )
      return uniqueByScope(rows.flat())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    },
  }
}
