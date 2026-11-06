import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button, Tag } from './ui-primitives.tsx'
import type { ContextApi } from './context-api.ts'
import type {
  ContextCommunity,
  ContextGraph as GraphData,
  ContextGraphEdge,
  ContextGraphNode,
  ContextMemory,
  MemoryLayer,
} from './context-types.ts'
import {
  formatScopeLabel,
  formatTime,
  memoryKindLabel,
  memoryLayerLabel,
  sourceLabel,
  useLoad,
} from './context-ui-helpers.tsx'
import { ContextGraph3D } from './ContextGraph3D.tsx'
import { useForceLayout } from './graph-force.ts'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { GraphLayoutMode, GraphSelectIntent } from './ContextGraph3D.tsx'
import {
  exploreGraph,
  graphNeighborhood,
  nextSearchMatch,
  shortestGraphPath,
} from './graph-exploration.ts'
import { ALL_SCOPES_ID } from './context-all-scopes.ts'
import styles from './Context.module.css'
import { localized, t } from './i18n.ts'

const LAYERS: MemoryLayer[] = ['working', 'episodic', 'semantic', 'procedural']
const EDGE_LABEL = localized<'summarizes'|'supersedes'|'references'|'mentions'|'source'|'session'|'relation'>('graph.edge')
const GLYPHS: Record<string, string> = { working: '◆', episodic: '●', semantic: '■', procedural: '▲', entity: '◇', document: '▣', source: '○', summary: '✦', community: '◉' }
const TONE_LABELS = localized<'working'|'episodic'|'semantic'|'procedural'|'entity'|'document'|'source'|'summary'|'community'>('graph.tone')
function nodeTone(node: { type: string; layer?: string; subtype?: string }): string {
  if (node.type !== 'memory') return node.type
  if (node.layer && (LAYERS as string[]).includes(node.layer)) return node.layer
  const subtype = node.subtype ?? ''
  if (/user_request|capture/iu.test(subtype)) return 'working'
  if (/assistant|reply/iu.test(subtype)) return 'semantic'
  if (/conversation|chat|seed/iu.test(subtype)) return 'episodic'
  return 'semantic'
}
const typeLabelMap = localized<'memory'|'entity'|'document'|'source'|'community'>('graph.nodeType')
const typeLabels: Record<string, string> = new Proxy({} as Record<string, string>, { get: (_target, key) => key === 'memory' ? t('nav') : typeof key === 'string' ? typeLabelMap[key as 'entity'|'document'|'source'|'community'] : undefined })
const VIEW_WIDTH = 960,
  VIEW_HEIGHT = 500,
  COMMUNITY_THRESHOLD = 12
const NODE_RENDER_CAP = 240
type GraphMode = 'overview' | 'workbench'
type GraphDimension = '2d' | '3d'
type Selected = { kind: 'node' | 'edge' | 'community'; id: string } | null
type VisualNode = ContextGraphNode & { community?: ContextCommunity }
type VisualEdge = ContextGraphEdge & { count?: number; types?: string[] }
type VisualGraph = {
  nodes: VisualNode[]
  edges: VisualEdge[]
  truncated: boolean
  matchedNodeIds: string[]
  hiddenNodeCount: number
  hiddenEdgeCount: number
}

function savedDimension(): GraphDimension {
  try {
    return window.localStorage.getItem('agentos-context.graph-dimension-v2') === '3d'
      ? '3d'
      : '2d'
  } catch {
    return '2d'
  }
}
function rememberDimension(value: GraphDimension) {
  try {
    window.localStorage.setItem('agentos-context.graph-dimension-v2', value)
  } catch {
    /* Storage is optional. */
  }
}

/** 全局贪心标签排布：按 degree 降序，逐个尝试 8 个候选位，与已放置标签矩形 + 节点圆碰撞；放不下则放弃（hover 仍会显示）。 */
export function placeLabelsGreedy(
  candidates: Array<{ id: string; label: string }>,
  positions: Map<string, { x: number; y: number }>,
  degreeOf: (id: string) => number,
  radiusOf: (id: string) => number,
  zoom: number,
  viewBoxParts: number[],
): Map<string, { x: number; y: number; text: string }> {
  const layout = new Map<string, { x: number; y: number; text: string }>()
  const ranked = [...candidates].sort((left, right) => degreeOf(right.id) - degreeOf(left.id) || left.id.localeCompare(right.id))
  const budget = zoom < 0.8 ? Math.min(6, Math.max(3, Math.ceil(candidates.length * 0.15))) : zoom > 1.5 ? Math.min(60, candidates.length) : Math.min(10, Math.max(5, Math.ceil(candidates.length * 0.4)))
  const placed: number[][] = []
  const circles = candidates.map(node => { const point = positions.get(node.id); return point ? { x: point.x, y: point.y, r: radiusOf(node.id) + 5 } : null }).filter((circle): circle is { x: number; y: number; r: number } => circle !== null)
  const minX = (viewBoxParts[0] ?? 0) + 6
  const minY = (viewBoxParts[1] ?? 0) + 6
  const maxX = (viewBoxParts[0] ?? 0) + (viewBoxParts[2] ?? 960) - 6
  const maxY = (viewBoxParts[1] ?? 0) + (viewBoxParts[3] ?? 500) - 6
  const overlaps = (rect: number[], other: number[]) => rect[0]! < other[2]! && rect[2]! > other[0]! && rect[1]! < other[3]! && rect[3]! > other[1]!
  for (const node of ranked.slice(0, budget)) {
    const point = positions.get(node.id)
    if (!point) continue
    const radius = radiusOf(node.id)
    const text = node.label.length > 16 ? node.label.slice(0, 15) + '…' : node.label
    const width = Math.min(220, Array.from(text).reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 10 : 6), 0) + 10)
    const height = 16
    const offsets = [
      { dx: radius + 7, dy: 4 },
      { dx: -radius - 7 - width, dy: 4 },
      { dx: -width / 2, dy: -radius - 10 },
      { dx: -width / 2, dy: radius + 18 },
      { dx: radius * 0.75 + 6, dy: -radius * 0.75 - 4 },
      { dx: -radius * 0.75 - 6 - width, dy: -radius * 0.75 - 4 },
      { dx: radius * 0.75 + 6, dy: radius * 0.75 + 13 },
      { dx: -radius * 0.75 - 6 - width, dy: radius * 0.75 + 13 },
    ]
    for (const offset of offsets) {
      const x = point.x + offset.dx
      const y = point.y + offset.dy
      const rect = [x - 6, y - height + 4, x + width + 6, y + 4]
      if (rect[0]! < minX || rect[2]! > maxX || rect[1]! < minY || rect[3]! > maxY) continue
      if (placed.some(other => overlaps(rect, other))) continue
      if (circles.some(circle => circle.x + circle.r > rect[0]! && circle.x - circle.r < rect[2]! && circle.y + circle.r > rect[1]! && circle.y - circle.r < rect[3]!)) continue
      placed.push(rect)
      layout.set(node.id, { x, y, text })
      break
    }
  }
  return layout
}
function convexHull(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (points.length < 3) return points
  const sorted = [...points].sort((left, right) => left.x - right.x || left.y - right.y)
  const cross = (origin: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
  const lower: Array<{ x: number; y: number }> = []
  for (const point of sorted) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop(); lower.push(point) }
  const upper: Array<{ x: number; y: number }> = []
  for (let index = sorted.length - 1; index >= 0; index -= 1) { const point = sorted[index]!; while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop(); upper.push(point) }
  upper.pop(); lower.pop()
  return lower.concat(upper)
}
function graphPositions(
  graph: VisualGraph | undefined,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  if (!graph?.nodes.length) return positions
  const degree = new Map(graph.nodes.map(node => [node.id, 0]))
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }
  if (graph.nodes.length > 0 && graph.nodes.every(node => node.type === 'community')) {
    const spacing = graph.nodes.length >= 5 ? 240 : 300
    const start = -((graph.nodes.length - 1) * spacing) / 2
    graph.nodes.forEach((node, index) => {
      positions.set(node.id, { x: VIEW_WIDTH / 2 + start + index * spacing, y: VIEW_HEIGHT / 2 })
    })
    return positions
  }
  const ranked = [...graph.nodes].sort(
    (a, b) =>
      (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
      Number(b.type === 'community') - Number(a.type === 'community') ||
      Number(b.type === 'entity') - Number(a.type === 'entity') ||
      (b.importance ?? 0) - (a.importance ?? 0) ||
      (b.timestamp ?? 0) - (a.timestamp ?? 0) ||
      a.id.localeCompare(b.id),
  )
  const rings = [
    { capacity: 1, rx: 0, ry: 0, offset: 0 },
    { capacity: 6, rx: 175, ry: 85, offset: -Math.PI / 2 },
    { capacity: 12, rx: 310, ry: 160, offset: -Math.PI / 2 + Math.PI / 12 },
    { capacity: 24, rx: 420, ry: 218, offset: -Math.PI / 2 },
    { capacity: 48, rx: 455, ry: 235, offset: -Math.PI / 2 + Math.PI / 48 },
  ]
  let cursor = 0
  for (const ring of rings) {
    const count = Math.min(ring.capacity, ranked.length - cursor)
    for (let index = 0; index < count; index++) {
      const node = ranked[cursor++]
      if (!node) continue
      const angle = count === 1 ? 0 : ring.offset + (index / count) * Math.PI * 2
      positions.set(node.id, {
        x: VIEW_WIDTH / 2 + Math.cos(angle) * ring.rx,
        y: VIEW_HEIGHT / 2 + Math.sin(angle) * ring.ry,
      })
    }
    if (cursor >= ranked.length) break
  }
  // The previous implementation stopped after 91 positions. A complete
  // workspace graph can contain 1k+ nodes, so keep assigning deterministic
  // Fermat-spiral positions for the 2D fallback instead of producing missing
  // coordinates (and crashing while rendering them).
  const remaining = ranked.length - cursor
  for (let index = 0; index < remaining; index += 1) {
    const node = ranked[cursor + index]
    if (!node) continue
    const ratio = (index + 1) / Math.max(1, remaining)
    const radius = 245 + Math.sqrt(ratio) * 225
    const angle = index * 2.399963229728653
    positions.set(node.id, {
      x: VIEW_WIDTH / 2 + Math.cos(angle) * radius,
      y: VIEW_HEIGHT / 2 + Math.sin(angle) * radius * 0.52,
    })
  }
  return positions
}

function graphDegrees(graph: VisualGraph | undefined): Map<string, number> {
  const degrees = new Map(graph?.nodes.map(node => [node.id, 0]) ?? [])
  for (const edge of graph?.edges ?? []) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1)
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1)
  }
  return degrees
}

function compactNodeRadius(node: VisualNode, degree: number): number {
  if (node.type === 'community') return 20
  const tier = degree >= 5 ? 21 : degree >= 2 ? 14 : 8
  return tier + (node.importance ?? 0.5) * 2
}
function displayLabel(value: string): string {
  return value
    .replace(/<\/?(?:path|file|url|workspace)>/giu, '')
    .replace(/\s+/g, ' ')
    .trim()
}
function shortLabel(value: string, maxUnits = 18): string {
  const flat = displayLabel(value)
  let units = 0,
    out = ''
  for (const char of flat) {
    const width = /[^\u0000-\u00ff]/u.test(char) ? 2 : 1
    if (units + width > maxUnits) return out + '…'
    out += char
    units += width
  }
  return out
}
function nodeDescriptor(node: VisualNode): string {
  if (node.type === 'community')
    return t('graph.node.communitySize', { count: node.community?.size ?? 0 })
  if (node.type === 'memory')
    return t('graph.node.memoryLayer', { layer: memoryLayerLabel[node.layer ?? 'semantic'], percent: Math.round((node.importance ?? 0.5) * 100) })
  if (node.type === 'entity') return t('graph.node.entity', { subtype: node.subtype ?? t('graph.subtype.uncategorized') })
  if (node.type === 'document') return t('graph.tone.document')
  if (node.type === 'source') return t('graph.tone.source')
  return `${node.type}${node.subtype ? ` · ${node.subtype}` : ''}`
}
function filteredNodeGraph(
  graph: GraphData,
  options: {
    query: string
    nodeType: string
    edgeType: string
    origin: 'all' | 'current' | 'legacy'
    scopeId: string
  },
): VisualGraph {
  const explored = exploreGraph(graph, {
    query: options.query,
    ...(options.nodeType === 'all' ? {} : { nodeTypes: new Set([options.nodeType]) }),
    ...(options.edgeType === 'all' ? {} : { edgeTypes: new Set([options.edgeType]) }),
    origin: options.origin,
    ...(options.scopeId === 'all' ? {} : { scopeIds: new Set([options.scopeId]) }),
  })
  return {
    ...explored,
    truncated: graph.stats.truncated,
  }
}
function communityGraph(
  graph: GraphData,
  expanded: Set<string>,
): VisualGraph {
  const communities = graph.communities ?? [],
    byNode = new Map<string, ContextCommunity>()
  for (const community of communities)
    for (const id of community.nodeIds) byNode.set(id, community)
  const ranked = [...communities].sort(
    (a, b) =>
      Number(expanded.has(b.id)) - Number(expanded.has(a.id)) ||
      b.size - a.size ||
      b.edgeCount - a.edgeCount ||
      a.id.localeCompare(b.id),
  )
  const included = ranked,
    includedIds = new Set(included.map(row => row.id)),
    nodeMap = new Map<string, VisualNode>()
  for (const community of included) {
    if (expanded.has(community.id)) {
      for (const id of community.nodeIds) {
        const node = graph.nodes.find(item => item.id === id)
        if (node) nodeMap.set(node.id, node)
      }
    } else if (community.size === 1) {
      const node = graph.nodes.find(item => item.id === community.nodeIds[0])
      if (node) nodeMap.set(node.id, node)
    } else
      nodeMap.set(community.id, {
        id: community.id,
        type: 'community',
        label: community.label,
        scopeId: community.scopeId,
        communityId: community.id,
        community,
      })
  }
  const endpoint = (id: string) => {
    const community = byNode.get(id)
    if (!community || !includedIds.has(community.id)) return null
    if (expanded.has(community.id) || community.size === 1) return id
    return community.id
  }
  const edgeMap = new Map<string, VisualEdge>()
  for (const edge of graph.edges) {
    const source = endpoint(edge.source),
      target = endpoint(edge.target)
    if (!source || !target || source === target) continue
    const aggregate =
      source.startsWith('community:') || target.startsWith('community:')
    const key = aggregate ? [source, target].sort().join('\0') : edge.id,
      previous = edgeMap.get(key)
    if (previous) {
      previous.count = (previous.count ?? 1) + 1
      previous.types = [
        ...new Set([...(previous.types ?? [previous.type]), edge.type]),
      ].sort()
    } else
      edgeMap.set(
        key,
        aggregate
          ? {
            id: 'aggregate:' + key,
            source,
            target,
            type: t('graph.crossCommunity'),
            count: 1,
            types: [edge.type],
          }
          : edge,
      )
  }
  return {
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
    truncated: graph.stats.truncated,
    matchedNodeIds: [...nodeMap.keys()],
    hiddenNodeCount: 0,
    hiddenEdgeCount: Math.max(0, graph.edges.length - edgeMap.size),
  }
}

export function ContextGraph({
  api,
  scopeId,
  mode = 'workbench',
}: {
  api: ContextApi
  scopeId: string
  mode?: GraphMode
}) {
  const overview = mode === 'overview'
  const graphHost = useRef<HTMLDivElement>(null)
  const [viewportSize, setViewportSize] = useState({ width: 960, height: 420 })
  useEffect(() => {
    const element = graphHost.current
    if (!element) return
    const update = () => setViewportSize({ width: Math.max(320, element.clientWidth || 960), height: Math.max(280, element.clientHeight || 420) })
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => update())
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const fullscreenRequested = useRef(false)
  const pathAnchorId = useRef<string | null>(null)
  const [rootId, setRootId] = useState(''),
    [filter, setFilter] = useState(''),
    [nodeType, setNodeType] = useState('all'),
    [edgeType, setEdgeType] = useState('all'),
    [origin, setOrigin] = useState<'all' | 'current' | 'legacy'>('all'),
    [nodeScope, setNodeScope] = useState('all'),
    [zoom, setZoom] = useState(1),
    [depth, setDepth] = useState(2),
    [pending, setPending] = useState(false),
    [known, setKnown] = useState(''),
    [valid, setValid] = useState(''),
    [selected, setSelected] = useState<Selected>(null),
    [viewMode, setViewMode] = useState<'auto' | 'communities' | 'nodes'>('nodes'),
    [expanded, setExpanded] = useState<Set<string>>(() => new Set()),
    [dimension, setDimension] = useState<GraphDimension>(savedDimension),
    [layerFilter, setLayerFilter] = useState<MemoryLayer | null>(null),
    [hovered, setHovered] = useState<{ kind: 'node' | 'edge'; id: string; title: string; meta: string; x?: number | string; y?: number | string; left?: string; top?: string } | null>(null),
    [layoutMode, setLayoutMode] = useState<GraphLayoutMode>('community'),
    [threeError, setThreeError] = useState(''),
    [fullscreen, setFullscreen] = useState(false),
    [focusNodeId, setFocusNodeId] = useState<string | null>(null),
    [focusRevision, setFocusRevision] = useState(0),
    [path, setPath] = useState<{ nodeIds: string[]; edgeIds: string[] } | null>(
      null,
    )
  const requestLimit = 1500,
    knownAt = known ? Date.parse(known) : undefined,
    validAt = valid ? Date.parse(valid) : undefined
  const state = useLoad(
    api,
    `graph:${scopeId}:${rootId}:${depth}:${pending}:${known}:${valid}:${requestLimit}`,
    signal =>
      api.graph(
        scopeId,
        {
          ...(rootId ? { rootId } : {}),
          depth,
          includePending: pending,
          limit: requestLimit,
          ...(knownAt !== undefined && Number.isFinite(knownAt)
            ? { knownAt }
            : {}),
          ...(validAt !== undefined && Number.isFinite(validAt)
            ? { validAt }
            : {}),
        },
        signal,
      ),
  )
  const communityCapable =
    !!state.data?.communities &&
    state.data.nodes.length >= COMMUNITY_THRESHOLD &&
    state.data.communities.some(row => row.size > 1) &&
    state.data.communities.length < state.data.nodes.length
  const communityAutoCapable =
    communityCapable &&
    (scopeId === ALL_SCOPES_ID ||
      state.data!.communities!.length * 4 <= state.data!.nodes.length ||
      (state.data!.nodes.length > 180 &&
        state.data!.communities!.length < state.data!.nodes.length * 0.75))
  const hasVisualFilters =
    !!filter.trim() ||
    nodeType !== 'all' ||
    edgeType !== 'all' ||
    origin !== 'all' ||
    nodeScope !== 'all'
  const showCommunities =
    !hasVisualFilters &&
    (viewMode === 'communities' || (viewMode === 'auto' && communityAutoCapable))
  const graph = useMemo(
    () =>
      state.data
        ? showCommunities
          ? communityGraph(state.data, expanded)
          : filteredNodeGraph(state.data, {
            query: filter,
            nodeType,
            edgeType,
            origin,
            scopeId: nodeScope,
          })
        : undefined,
    [
      state.data,
      showCommunities,
      expanded,
      filter,
      nodeType,
      edgeType,
      origin,
      nodeScope,
    ],
  )
  const nodeTypes = useMemo(
      () => [...new Set(state.data?.nodes.map(node => node.type) ?? [])].sort(),
      [state.data],
    ),
    edgeTypes = useMemo(
      () => [...new Set(state.data?.edges.map(edge => edge.type) ?? [])].sort(),
      [state.data],
    ),
    nodeScopes = useMemo(
      () => [...new Set(state.data?.nodes.map(node => node.scopeId) ?? [])].sort(),
      [state.data],
    )
  const degrees = useMemo(() => graphDegrees(graph), [graph])
  const toneCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const node of (state.data?.nodes ?? graph?.nodes ?? [])) { if (node.type === 'community') continue; const tone = nodeTone(node); counts[tone] = (counts[tone] ?? 0) + 1 }
    return counts
  }, [graph])
  const communityStats = useMemo(() => {
    const map = new Map<string, { nodes: number; internal: number; cross: number }>()
    const nodes = state.data?.nodes ?? []
    const keyOf = new Map(nodes.map(node => [node.id, node.communityId ?? node.scopeId ?? 'all']))
    for (const node of nodes) { const key = node.communityId ?? node.scopeId ?? 'all'; const entry = map.get(key) ?? { nodes: 0, internal: 0, cross: 0 }; entry.nodes += 1; map.set(key, entry) }
    for (const edge of state.data?.edges ?? []) { const left = keyOf.get(edge.source); const right = keyOf.get(edge.target); if (!left || !right) continue; if (left === right) { const entry = map.get(left); if (entry) entry.internal += 1 } else { const a = map.get(left); const b = map.get(right); if (a) a.cross += 1; if (b) b.cross += 1 } }
    return map
  }, [state.data])

  const radiusById = useMemo(
    () => new Map((graph?.nodes ?? []).map(node => [node.id, compactNodeRadius(node, degrees.get(node.id) ?? 0) + 8] as const)),
    [graph, degrees],
  )
  const hubThreshold = useMemo(() => {
    const values = [...degrees.values()].sort((left, right) => right - left)
    return Math.max(4, values[Math.min(values.length - 1, Math.floor(values.length * 0.15))] ?? 4)
  }, [degrees])
  const forceEnabled = dimension === '2d' && !showCommunities
  const livePositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  const nodeElementRef = useRef(new Map<string, SVGGElement>())
  const forceAnimatingRef = useRef(false)
  const applyForceFrame = (next: Map<string, { x: number; y: number }>) => {
    livePositionsRef.current = next
    forceAnimatingRef.current = true
    for (const [id, point] of next) {
      const element = nodeElementRef.current.get(id)
      if (!element) continue
      element.setAttribute('transform', element.dataset.compact === 'true' ? `translate(${point.x},${point.y})` : `translate(${point.x - 64},${point.y - 26})`)
    }
  }
  const settleForce = (next: Map<string, { x: number; y: number }>) => {
    livePositionsRef.current = next
    forceAnimatingRef.current = false
  }
  const force = useForceLayout(
    (graph?.nodes ?? []).map(node => ({ id: node.id, communityId: node.communityId ?? node.community?.id, scopeId: node.scopeId, subcluster: (node.communityId ?? node.community?.id ?? node.scopeId ?? 'all') + ':' + nodeTone(node) })),
    (graph?.edges ?? []).map(edge => ({ source: edge.source, target: edge.target })),
    { radiusOf: node => radiusById.get(node.id) ?? 10, enabled: forceEnabled, onFrame: applyForceFrame, onSettle: settleForce },
  )
  const fittedPositions = useMemo(() => {
    const points = [...force.positions.values()]
    if (points.length === 0) return force.positions
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const point of points) { minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y) }
    const cx = (minX + maxX) / 2
    const contentAspect = Math.max(0.2, (maxX - minX) / Math.max(1, maxY - minY))
    const targetAspect = Math.max(0.6, viewportSize.width / Math.max(1, viewportSize.height))
    const stretchX = Math.max(1, Math.min(2.1, targetAspect / contentAspect))
    const stretchY = Math.max(1, Math.min(1.8, 200 / Math.max(60, maxY - minY)))
    const result = new Map<string, { x: number; y: number }>()
    const cy = (minY + maxY) / 2
    for (const [id, point] of force.positions) result.set(id, { x: cx + (point.x - cx) * stretchX, y: cy + (point.y - cy) * stretchY })
    return result
  }, [force.positions, viewportSize])
  const fallbackPositions = useMemo(() => graphPositions(graph), [graph])
  const positions = forceEnabled ? fittedPositions : fallbackPositions,
    layerVisible = useMemo(() => (node: VisualNode) => {
    if (layerFilter === null) return true
    if (node.type !== 'memory') return true
    if (!node.layer) return nodeTone(node) === layerFilter
    return node.layer === layerFilter
  }, [layerFilter]),
    viewBox = useMemo(() => {
    const points = [...positions.values()]
    if (points.length === 0) return `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const point of points) { minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y) }
    const pad = 70
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const contentWidth = Math.max(360, maxX - minX + pad * 2)
    const contentHeight = Math.max(240, maxY - minY + pad * 2)
    const aspect = Math.max(0.4, viewportSize.width / viewportSize.height)
    let width = contentWidth, height = contentHeight
    if (contentWidth / contentHeight > aspect) height = contentWidth / aspect
    else width = contentHeight * aspect
    width /= 0.85; height /= 0.85
    return (cx - width / 2) + ' ' + (cy - height / 2) + ' ' + width + ' ' + height
  }, [positions, viewportSize]),
    viewBoxParts = useMemo(() => viewBox.split(' ').map(Number), [viewBox]),
    hoverPercent = (point: { x: number; y: number }) => {
    const [x = 0, y = 0, width = VIEW_WIDTH, height = VIEW_HEIGHT] = viewBoxParts
    return { left: `${Math.max(4, Math.min(88, ((point.x - x) / width) * 100))}%`, top: `${Math.max(4, Math.min(84, ((point.y - y) / height) * 100))}%` }
  }
  const [showAllNodes, setShowAllNodes] = useState(false)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [legendHover, setLegendHover] = useState<string | null>(null)
  const visibleNodeIds = useMemo(() => {
    const all = (graph?.nodes ?? []).filter(node => layerVisible(node))
    if (showCommunities || showAllNodes || all.length <= NODE_RENDER_CAP) return new Set(all.map(node => node.id))
    const ranked = [...all].sort((left, right) => (degrees.get(right.id) ?? 0) - (degrees.get(left.id) ?? 0) || left.id.localeCompare(right.id))
    const keep = new Set(ranked.slice(0, NODE_RENDER_CAP).map(node => node.id))
    if (selected?.kind === 'node') keep.add(selected.id)
    return keep
  }, [graph, layerVisible, showCommunities, showAllNodes, degrees, selected])
  if (!forceAnimatingRef.current) livePositionsRef.current = positions
  useEffect(() => {
    if (!force.settled) return
    livePositionsRef.current = positions
    forceAnimatingRef.current = false
  }, [force.settled, positions])
  const firstVisibleNodeId = useMemo(() => {
    const list = (graph?.nodes ?? []).filter(node => node.type !== 'community' && layerVisible(node) && visibleNodeIds.has(node.id))
    return list[0]?.id
  }, [graph, layerVisible, visibleNodeIds])
  useEffect(() => { setShowAllNodes(false) }, [graph])
  const subclusterBubbles = useMemo(() => {
    const map = new Map<string, { key: string; x: number; y: number; count: number; tone: string }>()
    for (const node of graph?.nodes ?? []) {
      if (node.type === 'community') continue
      if (!visibleNodeIds.has(node.id)) continue
      const point = positions.get(node.id)
      if (!point) continue
      const tone = nodeTone(node)
      const key = (node.communityId ?? node.scopeId ?? 'all') + ':' + tone
      const entry = map.get(key) ?? { key, x: 0, y: 0, count: 0, tone }
      entry.x += point.x
      entry.y += point.y
      entry.count += 1
      map.set(key, entry)
    }
    return [...map.values()].map(entry => ({ ...entry, x: entry.x / entry.count, y: entry.y / entry.count, radius: 10 + Math.sqrt(entry.count) * 2.8 }))
  }, [graph, positions, visibleNodeIds])
  const communityHulls = useMemo(() => {
    if (showCommunities) return [] as Array<{ id: string; label: string; count: number; d: string; x: number; y: number; chipWidth: number }>
    const communityLabels = new Map<string, string>()
    for (const node of graph?.nodes ?? []) if (node.type === 'community' && node.label) communityLabels.set(node.id, node.label)
    const groups = new Map<string, { label: string; scopeId: string; nodes: VisualNode[] }>()
    for (const node of graph?.nodes ?? []) {
      if (node.type === 'community') continue
      const key = node.communityId ?? node.scopeId ?? 'all'
      const bucket = groups.get(key) ?? { label: '', scopeId: node.scopeId, nodes: [] }
      bucket.nodes.push(node)
      const communityLabel = communityLabels.get(key) ?? (node as VisualNode).community?.label
      if (!bucket.label && communityLabel) bucket.label = communityLabel
      groups.set(key, bucket)
    }
    const hulls: Array<{ id: string; label: string; count: number; d: string; x: number; y: number; chipWidth: number }> = []
    let index = 0
    for (const [id, group] of groups) {
      const points = group.nodes.filter(node => visibleNodeIds.has(node.id)).map(node => positions.get(node.id)).filter((point): point is { x: number; y: number } => point !== undefined)
      if (points.length < 3) continue
      const hull = convexHull(points)
      if (hull.length < 3) continue
      const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length
      const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length
      const padded = hull.map(point => { const dx = point.x - cx; const dy = point.y - cy; const length = Math.max(1, Math.hypot(dx, dy)); return { x: point.x + (dx / length) * 26, y: point.y + (dy / length) * 26 } })
      const d = padded.map((point, pointIndex) => (pointIndex === 0 ? 'M' : 'L') + point.x.toFixed(1) + ' ' + point.y.toFixed(1)).join(' ') + ' Z'
      const minY = Math.min(...padded.map(point => point.y))
      const maxY = Math.max(...padded.map(point => point.y))
      let label = group.label
      if (!label) {
        try { label = formatScopeLabel(group.scopeId) } catch { label = '' }
      }
      if (!label || label.includes("scope:") || label.includes("%")) {
        const raw = group.scopeId ?? id
        const text = raw.includes("scope:") ? raw.slice(raw.indexOf("scope:") + 6) : raw
        try { label = decodeURIComponent(text) } catch { label = text }
      }
      if (!label || label.length > 16 || label.includes("/")) label = t('graph.communityFallback', { index: index + 1 })
      const chipWidth = Array.from(label).reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 10 : 6), 0) + 20
      const labelY = minY - 18
      hulls.push({ id, label, count: group.nodes.length, d, x: cx, y: labelY, chipWidth })
      index += 1
    }
    return hulls  }, [graph, positions, visibleNodeIds, showCommunities])
  const svgRef = useRef<SVGSVGElement>(null)
  const draggingRef = useRef<string | null>(null)
  const screenToGraph = (event: { clientX: number; clientY: number }) => {
    const svg = svgRef.current
    if (!svg) return null
    const matrix = svg.getScreenCTM()
    if (!matrix) return null
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    return { x: point.x, y: point.y }
  }
  const startDrag = (event: ReactPointerEvent<SVGGElement>, node: VisualNode) => {
    if (event.button !== 0) return
    const point = screenToGraph(event)
    if (!point) return
    draggingRef.current = node.id
    event.currentTarget.setPointerCapture?.(event.pointerId)
    force.dragTo(node.id, point)
    event.stopPropagation()
  }
  const moveDrag = (event: ReactPointerEvent<SVGElement>) => {
    if (!draggingRef.current) return
    const point = screenToGraph(event)
    if (point) force.dragTo(draggingRef.current, point)
  }
  const endDrag = () => {
    if (draggingRef.current) force.release(draggingRef.current)
    draggingRef.current = null
  }
  const labelLayout = useMemo(() => {
    const candidates = (graph?.nodes ?? []).filter(node => node.type !== 'community' && layerVisible(node) && visibleNodeIds.has(node.id)).map(node => ({ id: node.id, label: shortLabel(node.label, 16) }))
    return placeLabelsGreedy(candidates, positions, id => degrees.get(id) ?? 0, id => { const node = graph?.nodes.find(item => item.id === id); return node ? compactNodeRadius(node, degrees.get(id) ?? 0) : 10 }, zoom, viewBoxParts)
  }, [graph, positions, degrees, layerVisible, visibleNodeIds, zoom, viewBoxParts]),
    nodeById = useMemo(
      () => new Map(graph?.nodes.map(node => [node.id, node]) ?? []),
      [graph],
    ),
    compact2d = (graph?.nodes.length ?? 0) >= 30,
    labeledNodeIds = useMemo(() => {
      if (!graph || graph.nodes.length < 30)
        return new Set(graph?.nodes.map(node => node.id) ?? [])
      const ranked = [...graph.nodes]
        .sort(
          (left, right) =>
            (degrees.get(right.id) ?? 0) - (degrees.get(left.id) ?? 0) ||
            Number(right.type === 'entity') - Number(left.type === 'entity') ||
            (right.importance ?? 0) - (left.importance ?? 0) ||
            right.id.localeCompare(left.id),
        )
        .slice(0, graph.nodes.length > 240 ? 12 : 20)
      return new Set(ranked.map(node => node.id))
    }, [graph, degrees]),
    markerId = 'ctx-arrow-' + useId().replace(/:/g, '')
  const chosenNode =
    selected?.kind === 'node'
      ? state.data?.nodes.find(node => node.id === selected.id)
      : undefined
  const chosenEdge =
    selected?.kind === 'edge'
      ? (state.data?.edges.find(edge => edge.id === selected.id) ??
        graph?.edges.find(edge => edge.id === selected.id))
      : undefined
  const chosenCommunity =
    selected?.kind === 'community'
      ? state.data?.communities?.find(row => row.id === selected.id)
      : undefined
  const minimap = useMemo(() => {
    if ((graph?.nodes.length ?? 0) <= 150) return null
    const points = [...positions.values()]
    if (points.length === 0) return null
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const point of points) { minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y) }
    const pad = 36
    const width = Math.max(120, maxX - minX + pad * 2)
    const height = Math.max(90, maxY - minY + pad * 2)
    const vbX = viewBoxParts[0] ?? 0
    const vbY = viewBoxParts[1] ?? 0
    const vbW = viewBoxParts[2] ?? VIEW_WIDTH
    const vbH = viewBoxParts[3] ?? VIEW_HEIGHT
    const z = Math.max(0.2, zoom)
    const centerX = vbX + vbW / 2 - pan.x / z
    const centerY = vbY + vbH / 2 - pan.y / z
    const viewWidth = vbW / z
    const viewHeight = vbH / z
    const dots = (graph?.nodes ?? []).filter(node => visibleNodeIds.has(node.id)).slice(0, 600).map(node => { const point = positions.get(node.id); return point ? { x: point.x, y: point.y, tone: nodeTone(node) } : null }).filter((dot): dot is { x: number; y: number; tone: string } => dot !== null)
    return { minX: minX - pad, minY: minY - pad, width, height, dots, viewport: { x: centerX - viewWidth / 2, y: centerY - viewHeight / 2, width: viewWidth, height: viewHeight } }
  }, [graph, positions, zoom, pan, viewBoxParts, visibleNodeIds])

  const viewportGroupRef = useRef<SVGGElement>(null)
  const minimapViewportRef = useRef<SVGRectElement>(null)
  const minimapDragRef = useRef(false)
  const minimapTargetPanRef = useRef({ x: 0, y: 0 })
  const reduceMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  const applyViewportTransform = (nextZoom: number, nextPan: { x: number; y: number }) => {
    const vbX = viewBoxParts[0] ?? 0
    const vbY = viewBoxParts[1] ?? 0
    const vbW = viewBoxParts[2] ?? VIEW_WIDTH
    const vbH = viewBoxParts[3] ?? VIEW_HEIGHT
    const group = viewportGroupRef.current
    if (group) group.setAttribute('transform', `translate(${(vbW * (1 - nextZoom)) / 2 + nextPan.x} ${(vbH * (1 - nextZoom)) / 2 + nextPan.y}) scale(${nextZoom})`)
    const rect = minimapViewportRef.current
    if (rect && minimap) {
      const z = Math.max(0.2, nextZoom)
      const centerX = vbX + vbW / 2 - nextPan.x / z
      const centerY = vbY + vbH / 2 - nextPan.y / z
      const width = vbW / z
      const height = vbH / z
      rect.setAttribute('x', String(centerX - width / 2))
      rect.setAttribute('y', String(centerY - height / 2))
      rect.setAttribute('width', String(width))
      rect.setAttribute('height', String(height))
    }
  }
  const motionRef = useRef<number | null>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const panRef = useRef(pan)
  panRef.current = pan
  const animateViewport = (targetZoom: number, targetPan: { x: number; y: number }, duration = 180) => {
    if (reduceMotion) {
      setZoom(targetZoom)
      setPan(targetPan)
      return
    }
    if (motionRef.current !== null) cancelAnimationFrame(motionRef.current)
    const startZoom = zoomRef.current
    const startPan = panRef.current
    const startedAt = performance.now()
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      const nextZoom = Number((startZoom + (targetZoom - startZoom) * eased).toFixed(3))
      const nextPan = { x: startPan.x + (targetPan.x - startPan.x) * eased, y: startPan.y + (targetPan.y - startPan.y) * eased }
      zoomRef.current = nextZoom
      panRef.current = nextPan
      // 动画期间只改 DOM transform，不触发 React 渲染（label/minimap 不逐帧重算）。
      applyViewportTransform(nextZoom, nextPan)
      if (progress < 1) motionRef.current = requestAnimationFrame(step)
      else {
        motionRef.current = null
        setZoom(targetZoom)
        setPan(targetPan)
      }
    }
    motionRef.current = requestAnimationFrame(step)
  }
  useEffect(() => () => { if (motionRef.current !== null) cancelAnimationFrame(motionRef.current) }, [])
  const animateZoom = (target: number) => animateViewport(target, panRef.current)

  const minimapPanFor = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!minimap) return { x: 0, y: 0 }
    const rect = event.currentTarget.getBoundingClientRect()
    const fx = (event.clientX - rect.left) / Math.max(1, rect.width)
    const fy = (event.clientY - rect.top) / Math.max(1, rect.height)
    const targetX = minimap.minX + fx * minimap.width
    const targetY = minimap.minY + fy * minimap.height
    const vbX = viewBoxParts[0] ?? 0
    const vbY = viewBoxParts[1] ?? 0
    const vbW = viewBoxParts[2] ?? VIEW_WIDTH
    const vbH = viewBoxParts[3] ?? VIEW_HEIGHT
    const z = Math.max(0.2, zoomRef.current)
    return { x: vbX + vbW / 2 - z * targetX - (vbW * (1 - z)) / 2, y: vbY + vbH / 2 - z * targetY - (vbH * (1 - z)) / 2 }
  }
  const moveMinimap = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!minimap) return
    minimapDragRef.current = true
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const next = minimapPanFor(event)
    minimapTargetPanRef.current = next
    applyViewportTransform(zoomRef.current, next)
  }
  const dragMinimap = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!minimapDragRef.current || !minimap) return
    const next = minimapPanFor(event)
    minimapTargetPanRef.current = next
    applyViewportTransform(zoomRef.current, next)
  }
  const endMinimap = () => {
    if (!minimapDragRef.current) return
    minimapDragRef.current = false
    panRef.current = minimapTargetPanRef.current
    setPan(minimapTargetPanRef.current)
  }
  const highlighted = useMemo(() => {
    if (!graph || selected?.kind !== 'node')
      return { nodeIds: new Set<string>(), edgeIds: new Set<string>() }
    return graphNeighborhood(graph, selected.id)
  }, [graph, selected])
  const matchNodeSet = useMemo(() => new Set(filter.trim() ? graph?.matchedNodeIds ?? [] : []), [graph, filter])
  const pulseNodeIds = useMemo(() => new Set([...matchNodeSet].slice(0, 8)), [matchNodeSet])
  const pathNodeIds = useMemo(() => new Set(path?.nodeIds ?? []), [path]),
    pathEdgeIds = useMemo(() => new Set(path?.edgeIds ?? []), [path])
  const closeSelection = () => {
    setSelected(null)
    setPath(null)
    pathAnchorId.current = null
  }
  const focusNode = (id: string) => {
    setFocusNodeId(id)
    setFocusRevision(value => value + 1)
  }
  const chooseDimension = (value: GraphDimension) => {
    setDimension(value)
    rememberDimension(value)
    if (value === '3d') setThreeError('')
  }
  const selectCommunity = (id: string) => {
    setSelected({ kind: 'community', id })
  }
  const expandCommunity = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      next.add(id)
      return next
    })
  }
  const collapseCommunity = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }
  useEffect(() => {
    setExpanded(new Set())
    setSelected(null)
    setViewMode('nodes')
    setFilter('')
    setNodeType('all')
    setEdgeType('all')
    setOrigin('all')
    setNodeScope('all')
    setZoom(1)
    setPath(null)
    pathAnchorId.current = null
    setFocusNodeId(null)
  }, [scopeId, rootId, known, valid])
  useEffect(() => {
    const documentRoot = document.documentElement
    const changed = () => {
      const element = document.fullscreenElement
      const active = !!element && element === graphHost.current
      setFullscreen(active && fullscreenRequested.current)
      if (active && !fullscreenRequested.current && document.exitFullscreen)
        void document.exitFullscreen().catch(() => undefined)
    }
    const nativeFullscreen = new MutationObserver((records) => {
      const element = document.fullscreenElement
      if (documentRoot.dataset.fullscreen !== 'true'
        && (!element || element !== graphHost.current)
        && records.some(record => record.oldValue === 'true')) setFullscreen(false)
    })
    nativeFullscreen.observe(documentRoot, {
      attributes: true,
      attributeFilter: ['data-fullscreen'],
      attributeOldValue: true,
    })
    document.addEventListener('fullscreenchange', changed)
    return () => {
      nativeFullscreen.disconnect()
      document.removeEventListener('fullscreenchange', changed)
    }
  }, [])
  useEffect(() => {
    if (!selected && !fullscreen) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        if (selected) closeSelection()
        else {
          fullscreenRequested.current = false
          if (document.fullscreenElement && document.exitFullscreen)
            void document.exitFullscreen().catch(() => undefined)
          setFullscreen(false)
        }
      }
    }
    window.addEventListener('keydown', close, true)
    return () => window.removeEventListener('keydown', close, true)
  }, [selected, fullscreen])
  const selectVisualNode = (node: VisualNode, intent: GraphSelectIntent = {}) => {
    if (node.type === 'community') {
      selectCommunity(node.id)
      return
    }
    if (intent.shiftKey && pathAnchorId.current && graph) {
      const nextPath = shortestGraphPath(graph, pathAnchorId.current, node.id)
      setPath(nextPath)
    } else {
      setPath(null)
      pathAnchorId.current = node.id
    }
    setSelected({ kind: 'node', id: node.id })
    if (intent.doubleClick) focusNode(node.id)
  }
  const cycleSearch = (direction: 1 | -1) => {
    if (!graph) return
    const next = nextSearchMatch(
      graph.matchedNodeIds,
      selected?.kind === 'node' ? selected.id : null,
      direction,
    )
    const node = next ? graph.nodes.find(item => item.id === next) : undefined
    if (!node) return
    setSelected({ kind: 'node', id: node.id })
    pathAnchorId.current = node.id
    setPath(null)
    focusNode(node.id)
  }
  const toggleFullscreen = () => {
    // Keep the React/CSS fullscreen state responsive even when Electron takes
    // a long time to settle the native Fullscreen API promise.  Also key the
    // exit path from our own state: when native fullscreen is unavailable the
    // CSS fallback still needs to be dismissible.
    if (fullscreen || document.fullscreenElement) {
      fullscreenRequested.current = false
      setFullscreen(false)
      if (document.fullscreenElement && document.exitFullscreen) {
        void document.exitFullscreen().catch(() => undefined)
      }
      return
    }
    fullscreenRequested.current = true
    setFullscreen(true)
    const element = graphHost.current
    if (element?.requestFullscreen) {
      void element.requestFullscreen().catch(() => {
        // Electron policies can reject the native API; the fixed-position
        // fallback below still provides a full work area.
      })
    }
  }
  return (
    <div
      className={`${styles.stack} ${overview ? styles.graphOverview : ''}`}
      data-context-graph-mode={mode}
      data-context-graph-view={showCommunities ? 'communities' : 'nodes'}
      data-context-graph-dimension={dimension}
      data-context-graph-scope={scopeId}
    >
      {!overview ? (
        <>
          <details className={styles.graphAdvanced}>
            <summary>{t('graph.filters.summary')}{rootId || pending || known || valid || depth !== 2 ? t('graph.filters.summaryActive') : ''}</summary>
            <div className={styles.toolbar}>
              <input
                aria-label={t('aria.graphCenter')}
                placeholder={t('graph.centerPlaceholder')}
                value={rootId}
                onChange={event => setRootId(event.currentTarget.value)}
              />
              <select
                aria-label={t('aria.expandDepth')}
                value={depth}
                onChange={event => setDepth(Number(event.currentTarget.value))}
              >
                <option value={1}>{t('graph.depth.one')}</option>
                <option value={2}>{t('graph.depth.two')}</option>
                <option value={3}>{t('graph.depth.three')}</option>
              </select>
              <label className={styles.inline}>
                <input
                  type="checkbox"
                  className={styles.compactCheckbox}
                  checked={pending}
                  onChange={event => setPending(event.currentTarget.checked)}
                />
                {t('graph.showPending')}
              </label>
              <label className={styles.field}>
                {t('graph.time.known')}
                <input
                  type="datetime-local"
                  value={known}
                  onChange={event => setKnown(event.currentTarget.value)}
                />
              </label>
              <label className={styles.field}>
                {t('graph.time.valid')}
                <input
                  type="datetime-local"
                  value={valid}
                  onChange={event => setValid(event.currentTarget.value)}
                />
              </label>
              {(rootId || pending || known || valid || depth !== 2) && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setRootId('')
                    setDepth(2)
                    setPending(false)
                    setKnown('')
                    setValid('')
                  }}
                >
                  {t('graph.clearConditions')}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={state.reload}>
                {t('common.refresh')}
              </Button>
            </div>
          </details>
          <div className={styles.badges} aria-label={t('aria.layerLegend')}>
            <span className={styles.meta}>{t('graph.legendHint')}</span>
            {LAYERS.map(layer => (
              <button
                key={layer}
                type="button"
                className={`${styles.legendChip} ${styles['legend_' + layer] ?? ''} ${layerFilter === layer ? styles.legendChipActive : ''}`}
                aria-pressed={layerFilter === layer}
                onMouseEnter={() => setLegendHover(layer)}
                onMouseLeave={() => setLegendHover(null)}
                onClick={() => setLayerFilter(layerFilter === layer ? null : layer)}
              >
                <span className={styles.legendGlyph}>{GLYPHS[layer]}</span>
                {memoryLayerLabel[layer]}
                <span className={styles.legendCount}>{toneCounts[layer] ?? 0}</span>
              </button>
            ))}
            {([['entity', t('workbench.mode.entities')], ['document', t('graph.tone.document')], ['source', t('graph.tone.source')], ['summary', t('graph.tone.summary')]] as const).map(([tone, label]) => (
              <span
                key={tone}
                className={`${styles.legendChip} ${styles['legend_' + tone] ?? ''}`}
                onMouseEnter={() => setLegendHover(tone)}
                onMouseLeave={() => setLegendHover(null)}
              >
                <span className={styles.legendGlyph}>{GLYPHS[tone]}</span>
                {label}
                <span className={styles.legendCount}>{toneCounts[tone] ?? 0}</span>
              </span>
            ))}
            <span className={`${styles.legendChip} ${styles.legend_pending}`}>{t('graph.legendPending')}</span>
            {layerFilter !== null ? <button type="button" className={styles.legendChip} onClick={() => setLayerFilter(null)}>{t('graph.clearFilter')}</button> : null}
          </div>
        </>
      ) : (
        <div className={styles.graphOverviewBar}>
          <div>
            <strong>{t('graph.overviewTitle')}</strong>
            <span>
              {showCommunities
                ? t('graph.overview.community')
                : t('graph.overview.default')}
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={state.reload}>
            {t('common.refresh')}
          </Button>
        </div>
      )}
      <div className={styles.graphUtilityBar}>
        <div className={styles.graphSearchBox}>
          <input
            aria-label={t('aria.filterNodes')}
            placeholder={t('graph.searchPlaceholder')}
            value={filter}
            onChange={event => setFilter(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              cycleSearch(event.shiftKey ? -1 : 1)
            }}
          />
          {filter.trim() ? (
            <span aria-live="polite">
              {t('graph.matches', { count: graph?.matchedNodeIds.length ?? 0 })}
            </span>
          ) : null}
        </div>
        <div className={styles.graphUtilityActions}>
          {dimension === '2d' ? <div className={styles.graphZoom} role="group" aria-label={t('aria.graphZoom')}>
            <button
              type="button"
              aria-label={t('aria.zoomOut')}
              disabled={zoom <= 0.7}
              onClick={() => animateZoom(Math.max(0.7, Number((zoomRef.current - 0.1).toFixed(1))))}
            >
              −
            </button>
            <button
              type="button"
              aria-label={t('aria.resetZoom')}
              onClick={() => animateZoom(1)}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              aria-label={t('aria.zoomIn')}
              disabled={zoom >= 1.4}
              onClick={() => animateZoom(Math.min(1.4, Number((zoomRef.current + 0.1).toFixed(1))))}
            >
              ＋
            </button>
          </div> : null}
          <button
            type="button"
            className={styles.graphFullscreenToggle}
            aria-pressed={fullscreen}
            onClick={() => void toggleFullscreen()}
          >{fullscreen ? t('graph.exitFullscreen') : t('graph.fullscreen')}</button>
        </div>
      </div>
      <details className={styles.graphFilters}>
        <summary>
          {t('graph.filters.title')}
          {hasVisualFilters ? t('graph.filters.active') : ''}
        </summary>
        <div className={styles.graphFilterGrid}>
          <label>
            {t('graph.filter.nodeTypes')}
            <select value={nodeType} onChange={event => setNodeType(event.currentTarget.value)}>
              <option value="all">{t('graph.filter.allTypes')}</option>
              {nodeTypes.map(type => <option value={type} key={type}>{typeLabels[type] ?? type}</option>)}
            </select>
          </label>
          <label>
            {t('graph.filter.edgeTypes')}
            <select value={edgeType} onChange={event => setEdgeType(event.currentTarget.value)}>
              <option value="all">{t('graph.filter.allRelations')}</option>
              {edgeTypes.map(type => <option value={type} key={type}>{type}</option>)}
            </select>
          </label>
          <label>
            {t('graph.filter.source')}
            <select value={origin} onChange={event => setOrigin(event.currentTarget.value as typeof origin)}>
              <option value="all">{t('graph.filter.allSources')}</option>
              <option value="current">{t('graph.filter.currentSource')}</option>
              <option value="legacy">{t('graph.filter.legacySource')}</option>
            </select>
          </label>
          <label>
            {t('aria.memoryScope')}
            <select value={nodeScope} onChange={event => setNodeScope(event.currentTarget.value)}>
              <option value="all">{t('scope.all')}</option>
              {nodeScopes.map(id => <option value={id} key={id}>{formatScopeLabel(id)}</option>)}
            </select>
          </label>
          {dimension === '3d' ? <label>
            {t('graph.filter.layout')}
            <select value={layoutMode} onChange={event => setLayoutMode(event.currentTarget.value as GraphLayoutMode)}>
              <option value="community">{t('graph.layout.community')}</option>
              <option value="structure">{t('graph.layout.structure')}</option>
              <option value="timeline">{t('graph.layout.timeline')}</option>
            </select>
          </label> : null}
          {hasVisualFilters ? <button type="button" onClick={() => {
            setFilter('')
            setNodeType('all')
            setEdgeType('all')
            setOrigin('all')
            setNodeScope('all')
          }}>{t('graph.clearVisualFilters')}</button> : null}
        </div>
      </details>
      <div className={styles.graphSwitchRow}>
        {communityCapable ? (
          <div
            className={styles.graphViewSwitch}
            role="group"
            aria-label={t('aria.displayMode')}
          >
            <button
              type="button"
              aria-pressed={showCommunities}
              onClick={() => {
                setViewMode('communities')
                setSelected(null)
              }}
            >
              {t('graph.communityView')}
            </button>
            <button
              type="button"
              aria-pressed={!showCommunities}
              onClick={() => {
                setViewMode('nodes')
                setSelected(null)
              }}
            >
              {t('graph.nodeView')}
            </button>
            <span>{t('graph.communityCount', { count: state.data?.communities?.length ?? 0 })}</span>
          </div>
        ) : null}
        <div
          className={styles.graphViewSwitch}
          role="group"
          aria-label={t('aria.dimension')}
        >
          <button
            type="button"
            aria-pressed={dimension === '2d'}
            onClick={() => chooseDimension('2d')}
          >
            {t('graph.dimension2d')}
          </button>
          <button
            type="button"
            aria-pressed={dimension === '3d'}
            onClick={() => chooseDimension('3d')}
          >
            {t('graph.dimension3d')}
          </button>
        </div>
      </div>
      {threeError ? (
        <div className={styles.notice} role="status">
          {t('graph.threeUnavailable', { error: threeError })}
        </div>
      ) : null}
      {state.data && graph ? (
        <div className={styles.graphDataStatus} role="status">
          <span>
            {t('graph.stats.loaded', { nodes: state.data.nodes.length, edges: state.data.edges.length })}
          </span>
          {showCommunities ? (
            <span>
              {t('graph.stats.aggregated', { nodes: graph.nodes.length, edges: graph.edges.length })}
            </span>
          ) : hasVisualFilters && (graph.hiddenNodeCount > 0 || graph.hiddenEdgeCount > 0) ? (
            <span>
              {t('graph.stats.filtered', { nodes: graph.nodes.length, edges: graph.edges.length })}
            </span>
          ) : null}
          {!showCommunities && graph.nodes.length > NODE_RENDER_CAP ? (
            <span className={styles.renderCap}>
              {t('graph.stats.rendered', { rendered: visibleNodeIds.size, total: graph.nodes.filter(layerVisible).length })}
              <button type="button" className={styles.linkButton} onClick={() => setShowAllNodes(value => !value)}>
                {showAllNodes ? t('graph.showDefault') : t('graph.showAll')}
              </button>
            </span>
          ) : null}
          {state.data.stats.truncated ? (
            <strong>
              {t('graph.truncated')}
              {state.data.stats.totalNodeCount
                ? t('graph.truncatedHint', { count: state.data.stats.totalNodeCount })
                : t('graph.exploreHint')}
            </strong>
          ) : (
            <span>{t('graph.fullyLoaded')}</span>
          )}
        </div>
      ) : null}
      {state.phase === 'loading' && !graph ? (
        <div className={styles.loading}>{t('graph.loading')}</div>
      ) : null}
      {state.error ? (
        <div className={styles.error} role="alert">
          {state.error}
          <Button onClick={state.reload}>{t('common.retry')}</Button>
        </div>
      ) : null}
      {graph && graph.nodes.length === 0 ? (
        <div className={styles.empty}>
          {filter.trim()
            ? t('graph.empty.search')
            : t('graph.empty.default')}
        </div>
      ) : null}
      {graph && graph.nodes.length > 0 ? (
        <>
          <div
            className={`${styles.graphGrid} ${overview ? styles.graphGridOverview : ''}`}
          >
            <div
              ref={graphHost}
              className={`${styles.graph} ${fullscreen ? styles.graphFullscreen : ''} ${(graph?.nodes.length ?? 0) > 150 ? styles.graphDense : ''} ${chosenNode || chosenEdge || chosenCommunity ? styles.graphWithDrawer : ''}`}
            >
              {dimension === '3d' ? (
                <ContextGraph3D
                  graph={graph}
                  onSelectNode={selectVisualNode}
                  onSelectEdge={edge => setSelected({ kind: 'edge', id: edge.id })}
                  selectedNodeId={selected?.kind === 'node' ? selected.id : null}
                  highlightedNodeIds={highlighted.nodeIds}
                  highlightedEdgeIds={highlighted.edgeIds}
                  pathNodeIds={pathNodeIds}
                  pathEdgeIds={pathEdgeIds}
                  focusNodeId={focusNodeId}
                  focusRevision={focusRevision}
                  layoutMode={layoutMode}
                  onUnavailable={(reason) => {
                    setThreeError(reason)
                    chooseDimension('2d')
                  }}
                />
              ) : (
                <>
                <svg
                  key={showCommunities ? 'stage-communities' : 'stage-nodes'}
                  ref={svgRef}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerLeave={endDrag}
                  viewBox={viewBox}
                  preserveAspectRatio="xMidYMid meet"
                  role="img"
                  aria-label={t('aria.graphCanvas', { nodes: graph.nodes.length, edges: graph.edges.length })}
                  onClick={(event) => {
                    if (event.target === event.currentTarget) closeSelection()
                  }}
                  onMouseLeave={() => setHovered(null)}
                >
                  <defs>
                    <marker
                      id={markerId}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto"
                    >
                      <path d="M0 0 10 5 0 10" fill="context-stroke" />
                    </marker>
                  </defs>
                  <g ref={viewportGroupRef} transform={`translate(${(viewBoxParts[2]! * (1 - zoom)) / 2 + pan.x} ${(viewBoxParts[3]! * (1 - zoom)) / 2 + pan.y}) scale(${zoom})`}>
                    {communityHulls.map(hull => (
                      <g key={hull.id} className={styles.communityHullGroup} onClick={() => setSelected({ kind: 'community', id: hull.id })}>
                        <path className={styles.communityHull} d={hull.d} />
                        <g transform={`translate(${hull.x},${hull.y})`}><rect className={styles.communityHullChip} x={-hull.chipWidth / 2} y={-9} width={hull.chipWidth} height={18} rx={9} /><text className={styles.communityHullLabel} textAnchor="middle" y="3.5">{hull.label} · {hull.count}</text></g>
                      </g>
                    ))}
                    {graph.edges.map((edge) => {
                      const a = positions.get(edge.source), b = positions.get(edge.target)
                      if (!a || !b) return null
                      const sourceNode = nodeById.get(edge.source), targetNode = nodeById.get(edge.target)
                      if (!sourceNode || !targetNode) return null
                      if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) return null
                      if (!layerVisible(sourceNode) || !layerVisible(targetNode)) return null
                      const dx = b.x - a.x, dy = b.y - a.y
                      const length = Math.max(1, Math.hypot(dx, dy))
                      const sourcePadding = compact2d ? compactNodeRadius(sourceNode, degrees.get(edge.source) ?? 0) + 4 : 66
                      const targetPadding = compact2d ? compactNodeRadius(targetNode, degrees.get(edge.target) ?? 0) + 5 : 70
                      const x1 = a.x + (dx / length) * sourcePadding
                      const y1 = a.y + (dy / length) * (compact2d ? sourcePadding : 25)
                      const x2 = b.x - (dx / length) * targetPadding
                      const y2 = b.y - (dy / length) * (compact2d ? targetPadding : 25)
                      const edgeHighlighted = highlighted.edgeIds.has(edge.id)
                      const edgeOnPath = pathEdgeIds.has(edge.id)
                      const edgeDimmed = selected?.kind === 'node' && !edgeHighlighted && !edgeOnPath
                      const edgeHovered = hovered?.kind === 'edge' && hovered.id === edge.id
                      const crossCommunity = sourceNode.communityId !== undefined && targetNode.communityId !== undefined && sourceNode.communityId !== targetNode.communityId
                      return (
                        <g
                          key={edge.id}
                          className={`${styles.edgeHit} ${edgeOnPath ? styles.edgePath : ''} ${edgeDimmed ? styles.edgeDimmed : ''} ${edgeHovered ? styles.edgeHovered : ''}`}
                          onClick={() => setSelected({ kind: 'edge', id: edge.id })}
                          onMouseEnter={() => setHovered({ kind: 'edge', id: edge.id, x: (x1 + x2) / 2, y: (y1 + y2) / 2, title: EDGE_LABEL[edge.type] ?? edge.type, meta: edge.status === 'pending' ? t('graph.edge.pending') : edge.count ? t('graph.edge.crossCommunity', { count: edge.count }) : t('graph.edge.confirmed') })}
                          onMouseLeave={() => setHovered(null)}
                        >
                          <title>{edge.count ? t('graph.edge.crossCommunity', { count: edge.count }) : edge.type}</title>
                          <path
                            className={edge.status === 'pending' ? `${styles.edge} ${styles.edgePending}` : styles.edge}
                            d={`M${x1} ${y1} Q${(x1 + x2) / 2} ${(y1 + y2) / 2 - 14},${x2} ${y2}`}
                            markerEnd={edgeHovered || edgeHighlighted || edgeOnPath ? `url(#${markerId})` : undefined}
                          />
                          {edge.count && edge.count > 1 ? (
                            <text className={styles.edgeCount} x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 16}>{edge.count}</text>
                          ) : edgeHovered || edgeHighlighted || edgeOnPath ? (
                            <text className={styles.edgeLabel} x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 16}>{EDGE_LABEL[edge.type] ?? edge.type}</text>
                          ) : null}
                        </g>
                      )
                    })}
                    {zoom < 0.8 && (graph?.nodes.length ?? 0) > 150 ? (
                      subclusterBubbles.map(bubble => (
                        <g key={bubble.key} className={styles.subclusterGroup} transform={`translate(${bubble.x},${bubble.y})`} onClick={() => { setZoom(1.5); setPan({ x: 0, y: 0 }) }}>
                          <circle className={styles.subclusterBubble} data-tone={bubble.tone} r={bubble.radius} />
                          <text className={styles.subclusterCount} textAnchor="middle" y="4">{bubble.count}</text>
                        </g>
                      ))
                    ) : graph.nodes.filter(node => (showCommunities || node.type !== 'community') && layerVisible(node) && visibleNodeIds.has(node.id)).map((node) => {
                      const point = livePositionsRef.current.get(node.id) ?? positions.get(node.id)
                      if (!point) return null
                      const active = selected?.id === node.id
                      const highlightedNode = highlighted.nodeIds.has(node.id)
                      const pathNode = pathNodeIds.has(node.id)
                      const compactRadius = compactNodeRadius(node, degrees.get(node.id) ?? 0)
                      const placement = labelLayout.get(node.id)
const isHoveredNode = hovered?.kind === 'node' && hovered.id === node.id
const showCompactLabel = active || highlightedNode || pathNode || placement !== undefined || isHoveredNode
                      const dimmed = (selected?.kind === 'node' && !highlightedNode && !pathNode) || (focusNodeId !== null && node.id !== focusNodeId && !highlightedNode)
                      const tone = nodeTone(node)
                      const isHub = (degrees.get(node.id) ?? 0) >= Math.max(2, hubThreshold)
                      if (node.type === 'community') {
                        const community = (node as VisualNode).community
                        const size = community?.size ?? 0
                        const clusterRadius = 24 + Math.min(18, Math.sqrt(size) * 3.4)
                        const memberCount = Math.min(12, Math.max(3, size))
                        const communityKey = node.community?.id ?? node.nativeId ?? node.id
                        const stats = communityStats.get(communityKey) ?? { nodes: size, internal: 0, cross: 0 }
                        const ringPoints = Array.from({ length: memberCount }, (_, index) => { const angle = (index / memberCount) * Math.PI * 2 - Math.PI / 2; return { x: Math.cos(angle) * clusterRadius * 1.6, y: Math.sin(angle) * clusterRadius * 1.35 } })
                        const ringHull = convexHull(ringPoints)
                        const hullPath = ringHull.length >= 3 ? ringHull.map((point, index) => (index === 0 ? 'M' : 'L') + (point.x * 1.14).toFixed(1) + ' ' + (point.y * 1.14).toFixed(1)).join(' ') + ' Z' : ''
                        return (
                          <g
                            key={node.id}
                            role="button"
                            tabIndex={0}
                            aria-label={t('graph.node.aria', { descriptor: nodeDescriptor(node), label: displayLabel(node.label), size })}
                            className={`${styles.node} ${styles.communityCluster} ${active ? styles.nodeSelected : ''} ${dimmed ? styles.nodeDimmed : ''}`}
                            transform={`translate(${point.x},${point.y})`}
                            onClick={() => { setViewMode('nodes'); setNodeScope(node.scopeId); setSelected(null) }}
                            onMouseEnter={() => setHovered({ kind: 'node', id: node.id, ...hoverPercent(point), title: displayLabel(node.label), meta: t('graph.node.meta', { nodes: stats.nodes, internal: stats.internal, cross: stats.cross }) })}
                            onMouseLeave={() => setHovered(null)}
                          >
                            {hullPath ? <path className={styles.communityViewHull} d={hullPath} /> : null}
                            {ringPoints.map((point, index) => <circle key={index} className={styles.communityMember} cx={point.x} cy={point.y} r={2.2} />)}
                            <g transform={`translate(0,${clusterRadius * 1.35 + 16})`}>
                              <rect className={styles.communityHullChip} x={-((shortLabel(node.label, 16).length * 5) + 26)} y={-9} width={(shortLabel(node.label, 16).length * 10) + 52} height={18} rx={9} />
                              <text className={styles.communityHullLabel} textAnchor="middle" y="3.5">{shortLabel(node.label, 16)} · {t('graph3d.sizeItems', { size })}</text>
                            </g>
                          </g>
                        )
                      }
                      return (
                        <g
                          key={node.id}
                          role="button"
                          ref={element => { if (element) nodeElementRef.current.set(node.id, element); else nodeElementRef.current.delete(node.id) }}
                          tabIndex={active || (!selected && node.id === firstVisibleNodeId) ? 0 : -1}
                          data-node-id={node.id}
                          data-compact={compact2d ? 'true' : 'false'}
                          aria-label={`${nodeDescriptor(node)}，${displayLabel(node.label)}`}
                          className={`${styles.node} ${compact2d ? styles.nodeCompact : ''} ${pulseNodeIds.has(node.id) ? styles.nodeSearchMatch : ''} ${styles['tone_' + tone] ?? ''} ${legendHover !== null && legendHover !== tone ? styles.nodeLegendDim : ''} ${active ? styles.nodeSelected : ''} ${pathNode ? styles.nodePath : ''} ${dimmed ? styles.nodeDimmed : ''}`}
                          transform={compact2d ? `translate(${point.x},${point.y})` : `translate(${point.x - 64},${point.y - 26})`}
                          onPointerDown={event => startDrag(event, node)}
                          onClick={event => selectVisualNode(node, { shiftKey: event.shiftKey })}
                          onDoubleClick={() => selectVisualNode(node, { doubleClick: true })}
                          onMouseEnter={() => setHovered({ kind: 'node', id: node.id, ...hoverPercent(point), title: displayLabel(node.label), meta: [TONE_LABELS[tone] ?? node.type, node.legacy ? t('graph.node.legacy') : null, node.timestamp ? formatTime(node.timestamp) : null].filter(Boolean).join(' · ') })}
                          onMouseLeave={() => setHovered(null)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              selectVisualNode(node)
                              return
                            }
                            if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return
                            event.preventDefault()
                            const svg = event.currentTarget.ownerSVGElement
                            const items = svg ? (Array.from(svg.querySelectorAll('[data-node-id]')) as SVGGElement[]) : []
                            const index = items.indexOf(event.currentTarget)
                            if (index < 0 || items.length === 0) return
                            const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1
                            items[(index + step + items.length) % items.length]?.focus()
                          }}
                        >
                          <title>{displayLabel(node.label)}</title>
                          {compact2d ? (
                            <>
                              {isHub ? <circle className={styles.nodeHubGlow} r={compactRadius + 12} /> : null}
                              <circle className={styles.nodeRing} r={compactRadius} />
                              <circle className={styles.nodeCore} r={Math.max(3, compactRadius - 3)} />
                              <text className={styles.nodeGlyph} y="3.4" textAnchor="middle">{GLYPHS[tone] ?? '●'}</text>
                              {showCompactLabel ? (
                                <text className={styles.nodeCompactLabel} x={placement ? placement.x - point.x : (active || isHoveredNode ? compactRadius * 1.12 : compactRadius) + 5} y={placement ? placement.y - point.y : 4}>{placement ? placement.text : shortLabel(node.label, 18)}</text>
                              ) : null}
                            </>
                          ) : (
                            <>
                              <rect width="128" height="52" rx={12} />
                              <text className={styles.nodeType} x="64" y="19" textAnchor="middle">{nodeDescriptor(node)}</text>
                              <text className={styles.nodeLabel} x="64" y="38" textAnchor="middle">{shortLabel(node.label, 22)}</text>
                            </>
                          )}
                        </g>
                      )
                    })}
                  </g>
                </svg>
                {minimap !== null ? (
                  <svg className={styles.graphMinimap} viewBox={`${minimap.minX} ${minimap.minY} ${minimap.width} ${minimap.height}`} role="img" aria-label={t('aria.minimap')} onPointerDown={moveMinimap} onPointerMove={dragMinimap} onPointerUp={endMinimap} onPointerLeave={endMinimap} onPointerCancel={endMinimap}>
                    <rect className={styles.minimapBg} x={minimap.minX} y={minimap.minY} width={minimap.width} height={minimap.height} rx={14} />
                    {minimap.dots.map((dot, index) => <circle key={index} className={styles.minimapDot} data-tone={dot.tone} cx={dot.x} cy={dot.y} r={2.4} />)}
                    <rect ref={minimapViewportRef} className={styles.minimapViewport} x={minimap.viewport.x} y={minimap.viewport.y} width={minimap.viewport.width} height={minimap.viewport.height} rx={6} />
                  </svg>
                ) : null}
                {hovered !== null ? (
                  <div className={styles.graphHoverCard} style={{ left: hovered.x ?? hovered.left, top: hovered.y ?? hovered.top }} role="tooltip">
                    <strong>{hovered.title}</strong>
                    <span>{hovered.meta}</span>
                  </div>
                ) : null}
                </>
              )}
              {selected?.kind === 'node' ? (
                <div className={styles.graphSelectionHint}>
                  {path
                    ? t('graph.path.shown', { nodes: path.nodeIds.length, edges: path.edgeIds.length })
                    : t('graph.path.neighbors')}
                  {path ? (
                    <button type="button" onClick={() => setPath(null)}>{t('graph.path.clear')}</button>
                  ) : null}
                </div>
              ) : null}
              {fullscreen ? (
                <button
                  type="button"
                  className={styles.graphFullscreenExit}
                  onClick={() => void toggleFullscreen()}
                >
                  {t('graph.exitFullscreen')}
                </button>
              ) : null}
              {chosenNode || chosenEdge || chosenCommunity ? (
                <aside
                  className={styles.graphDrawer}
                  role="dialog"
                  aria-label={t('aria.graphDetails')}
                >
                  <div className={styles.graphDrawerHeader}>
                    <div>
                      <span className={styles.graphDrawerEyebrow}>
                        {chosenCommunity
                          ? t('graph.details.community')
                          : chosenNode
                            ? t('graph.details.node')
                            : t('graph.details.edge')}
                      </span>
                      <strong>
                        {displayLabel(
                          chosenCommunity?.label ??
                            chosenNode?.label ??
                            chosenEdge?.type ??
                            '',
                        )}
                      </strong>
                    </div>
                    <Button
                      className={styles.graphDrawerClose}
                      variant="ghost"
                      size="sm"
                      aria-label={t('aria.closeGraphDetails')}
                      title={t('common.close')}
                      onClick={closeSelection}
                    >
                      <span aria-hidden="true">×</span>
                    </Button>
                  </div>
                  <div className={styles.graphDrawerBody}>
                    <div className={styles.graphInspectorActions}>
                      {chosenNode ? (
                        <>
                          <Button size="sm" variant="outline" onClick={() => setFocusNodeId(prev => prev === chosenNode.id ? null : chosenNode.id)}>{focusNodeId === chosenNode.id ? t('graph.action.unfocus') : t('graph.action.focusNeighbors')}</Button>
                          <Button size="sm" variant="outline" onClick={() => setZoom(value => Math.min(2.4, value + 0.25))}>{t('graph.action.openInGraph')}</Button>
                          <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText(chosenNode.label) }}>{t('common.copy')}</Button>
                        </>
                      ) : null}
                    </div>
                    {chosenCommunity ? (
                      <CommunitySelection
                        community={chosenCommunity}
                        graph={state.data!}
                        onSelectNode={id => setSelected({ kind: 'node', id })}
                        onSelectCommunity={selectCommunity}
                      />
                    ) : chosenNode?.type === 'memory' ? (
                      <MemoryNodeSelection
                        api={api}
                        scopeId={scopeId}
                        node={chosenNode}
                      />
                    ) : (
                      <GraphSelection
                        chosen={(chosenNode ?? chosenEdge)!}
                        graph={state.data!}
                      />
                    )}{' '}
                    {chosenCommunity?.id.startsWith('community:scope:') ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setNodeScope(chosenCommunity.scopeId)
                          setViewMode('nodes')
                          closeSelection()
                        }}
                      >
                        {t('graph.action.viewScopeNodes')}
                      </Button>
                    ) : chosenCommunity ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          expanded.has(chosenCommunity.id)
                            ? collapseCommunity(chosenCommunity.id)
                            : expandCommunity(chosenCommunity.id)
                        }
                      >
                        {expanded.has(chosenCommunity.id)
                          ? t('graph.community.collapse')
                          : t('graph.community.expand')}
                      </Button>
                    ) : !overview && chosenNode ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRootId(chosenNode.id)}
                      >
                        {t('graph.action.expandFromNode')}
                      </Button>
                    ) : null}
                  </div>
                </aside>
              ) : null}
            </div>
          </div>
          {!overview ? (
            <details className={styles.graphNavigator}>
              <summary>{t('graph.lookup.summary')}</summary>
              <div className={styles.graphNavigatorFields}>
                <div className={styles.field}>
                  <label htmlFor="context-graph-community">{t('graph.tone.community')}</label>
                  <select
                    id="context-graph-community"
                    value={selected?.kind === 'community' ? selected.id : ''}
                    onChange={event =>
                      event.currentTarget.value &&
                      selectCommunity(event.currentTarget.value)
                    }
                  >
                    <option value="">{t('graph.lookup.selectCommunity')}</option>
                    {(state.data?.communities ?? []).map(row => (
                      <option value={row.id} key={row.id}>
                        {t('graph.lookup.communityOption', { label: displayLabel(row.label), size: row.size })}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label htmlFor="context-graph-node">{t('workbench.mode.entities')}</label>
                  <select
                    id="context-graph-node"
                    value={selected?.kind === 'node' ? selected.id : ''}
                    onChange={event =>
                      event.currentTarget.value &&
                      setSelected({
                        kind: 'node',
                        id: event.currentTarget.value,
                      })
                    }
                  >
                    <option value="">{t('graph.lookup.selectNode')}</option>
                    {state.data?.nodes.map(node => (
                      <option value={node.id} key={node.id}>
                        {displayLabel(node.label)} ·{' '}
                        {node.layer
                          ? t('workbench.layerMemory', { layer: memoryLayerLabel[node.layer] })
                          : (node.subtype ?? node.type)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label htmlFor="context-graph-edge">{t('workbench.field.relation')}</label>
                  <select
                    id="context-graph-edge"
                    value={selected?.kind === 'edge' ? selected.id : ''}
                    onChange={event =>
                      event.currentTarget.value &&
                      setSelected({
                        kind: 'edge',
                        id: event.currentTarget.value,
                      })
                    }
                  >
                    <option value="">{t('graph.lookup.selectEdge')}</option>
                    {state.data?.edges.map(edge => (
                      <option value={edge.id} key={edge.id}>
                        {displayLabel(
                          state.data?.nodes.find(
                            node => node.id === edge.source,
                          )?.label ?? edge.source,
                        )}{' '}
                        — {edge.type} →{' '}
                        {displayLabel(
                          state.data?.nodes.find(
                            node => node.id === edge.target,
                          )?.label ?? edge.target,
                        )}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </details>
          ) : null}
          <div className={styles.graphFootnote}>
            {t('graph.footer.current', { nodes: graph.nodes.length, edges: graph.edges.length })}
            {showCommunities
              ? t('graph.footer.communities', { count: state.data?.communities?.length ?? 0 })
              : ''}
            {graph.truncated
              ? t('graph.footer.controlled')
              : '。'}
          </div>
        </>
      ) : null}
    </div>
  )
}

function CommunitySelection({
  community,
  graph,
  onSelectNode,
  onSelectCommunity,
}: {
  community: ContextCommunity
  graph: GraphData
  onSelectNode: (id: string) => void
  onSelectCommunity: (id: string) => void
}) {
  const top = community.topNodeIds
      .map(id => graph.nodes.find(node => node.id === id))
      .filter(Boolean) as ContextGraphNode[],
    links = (graph.communityEdges ?? [])
      .filter(
        edge => edge.source === community.id || edge.target === community.id,
      )
      .map(edge => ({
        edge,
        target: graph.communities?.find(
          row =>
            row.id ===
            (edge.source === community.id ? edge.target : edge.source),
        ),
      }))
      .filter(row => row.target)
  return (
    <div className={styles.stack}>
      <div className={styles.badges}>
        <Tag tone="info">{t('graph.communityStats.nodes', { count: community.size })}</Tag>
        <Tag tone="neutral">{t('graph.communityStats.internal', { count: community.edgeCount })}</Tag>
        <Tag tone="warning">{t('graph.communityStats.external', { count: community.externalEdgeCount })}</Tag>
      </div>
      <p className={styles.communitySummary}>{community.summary}</p>
      <div className={styles.graphDrawerSectionLabel}>{t('graph.section.topEntities')}</div>
      <div className={styles.communityMembers}>
        {top.map(node => (
          <button
            type="button"
            key={node.id}
            title={displayLabel(node.label)}
            onClick={() => onSelectNode(node.id)}
          >
            {displayLabel(node.label)}
            <small>{nodeDescriptor(node)}</small>
          </button>
        ))}
      </div>
      {links.length ? (
        <>
          <div className={styles.graphDrawerSectionLabel}>{t('graph.section.relatedCommunities')}</div>
          <div className={styles.communityMembers}>
            {links.map(({ edge, target }) => (
              <button
                type="button"
                key={edge.id}
                onClick={() => onSelectCommunity(target!.id)}
              >
                {displayLabel(target!.label)}
                <small>
                  {t('graph.edge.countTypes', { count: edge.count, types: edge.types.join(t('common.enumSeparator')) })}
                </small>
              </button>
            ))}
          </div>
        </>
      ) : null}
      <div className={styles.graphDrawerSectionLabel}>{t('graph.section.composition')}</div>
      <dl className={styles.graphDetailList}>
        {Object.entries(community.typeCounts)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([type, count]) => (
            <div key={type}>
              <dt>{type}</dt>
              <dd>{count}</dd>
            </div>
          ))}
      </dl>
      <dl className={styles.graphDetailList}>
        <div>
          <dt>{t('aria.memoryScope')}</dt>
          <dd>{formatScopeLabel(community.scopeId, community.scopeId)}</dd>
        </div>
        <div>
          <dt>{t('graph.details.communityId')}</dt>
          <dd className={styles.graphDetailCode}>{community.id}</dd>
        </div>
      </dl>
    </div>
  )
}
function MemoryNodeSelection({
  api,
  scopeId,
  node,
}: {
  api: ContextApi
  scopeId: string
  node: ContextGraphNode
}) {
  const memoryScope = node.scopeId || scopeId,
    memoryId = node.nativeId ?? node.id,
    state = useLoad(
      api,
      'graph-memory:' + memoryScope + ':' + memoryId,
      signal => api.memory(memoryScope, memoryId, signal),
    )
  if (state.phase === 'loading' && !state.data)
    return <div className={styles.loading}>{t('graph.loading.fullMemory')}</div>
  if (state.error && !state.data)
    return (
      <div className={styles.error} role="alert">
        {state.error}
        <Button size="sm" onClick={state.reload}>
          {t('common.retry')}
        </Button>
      </div>
    )
  const memory = state.data as ContextMemory | undefined
  if (!memory) return null
  return (
    <div className={styles.stack}>
      <div className={styles.badges}>
        <Tag tone={memory.layer === 'working' ? 'warning' : 'info'}>
          {t('workbench.layerMemory', { layer: memoryLayerLabel[memory.layer] })}
        </Tag>
        <Tag tone="neutral">{memoryKindLabel[memory.kind] ?? memory.kind}</Tag>
        {memory.legacy ? <Tag tone="info">{t('graph.legacyCompat')}</Tag> : null}
      </div>
      <div className={styles.graphDrawerSectionLabel}>{t('graph.details.fullMemory')}</div>
      <p className={styles.graphMemoryContent}>{memory.content}</p>
      <div className={styles.graphDrawerSectionLabel}>{t('graph.details.sourceText')}</div>
      <blockquote className={styles.source}>{memory.source.content}</blockquote>
      <p className={styles.meta}>
        {sourceLabel(memory)} · {memory.source.kind}
      </p>
      <dl className={styles.graphDetailList}>
        <div>
          <dt>{t('memoryView.detail.recordedAt')}</dt>
          <dd>{formatTime(memory.recordedAt)}</dd>
        </div>
        <div>
          <dt>{t('graph.details.importance')}</dt>
          <dd>{Math.round((memory.importance ?? 0.5) * 100)}%</dd>
        </div>
        <div>
          <dt>{t('memoryView.detail.scope')}</dt>
          <dd>{formatScopeLabel(memory.scopeId, memory.scopeId)}</dd>
        </div>
        <div>
          <dt>{t('graph.details.nodeId')}</dt>
          <dd className={styles.graphDetailCode}>{memory.id}</dd>
        </div>
      </dl>
    </div>
  )
}
function GraphSelection({
  chosen,
  graph,
}: {
  chosen: ContextGraphNode | VisualEdge
  graph: GraphData
}) {
  const node = 'label' in chosen,
    source = !node
      ? graph.nodes.find(item => item.id === chosen.source)
      : undefined,
    target = !node
      ? graph.nodes.find(item => item.id === chosen.target)
      : undefined
  return (
    <div className={styles.stack}>
      {node ? (
        <>
          <div className={styles.badges}>
            <Tag tone={chosen.layer === 'working' ? 'warning' : 'info'}>
              {nodeDescriptor(chosen)}
            </Tag>
            {chosen.status ? (
              <Tag
                tone={
                  chosen.status === 'confirmed'
                    ? 'success'
                    : chosen.status === 'pending'
                      ? 'warning'
                      : 'neutral'
                }
              >
                {chosen.status}
              </Tag>
            ) : null}
          </div>
          <div className={styles.graphDrawerSectionLabel}>{t('graph.details.basic')}</div>
          <dl className={styles.graphDetailList}>
            <div>
              <dt>{t('memoryView.detail.recordedAt')}</dt>
              <dd>
                {chosen.timestamp ? formatTime(chosen.timestamp) : t('time.unknown')}
              </dd>
            </div>
            <div>
              <dt>{t('aria.memoryScope')}</dt>
              <dd>{formatScopeLabel(chosen.scopeId, chosen.scopeId)}</dd>
            </div>
            <div>
              <dt>{t('graph.details.nodeId')}</dt>
              <dd className={styles.graphDetailCode}>{chosen.id}</dd>
            </div>
          </dl>
        </>
      ) : (
        <>
          <div className={styles.graphDrawerSectionLabel}>
            {chosen.count ? t('graph.edge.crossCommunityTitle') : t('graph.edge.pathTitle')}
          </div>
          <div className={styles.graphRelationPath}>
            <span>{displayLabel(source?.label ?? chosen.source)}</span>
            <b>
              {chosen.count
                ? t('graph.edge.summary', { count: chosen.count, types: (chosen.types ?? []).join(t('common.enumSeparator')) })
                : chosen.type}
            </b>
            <span>{displayLabel(target?.label ?? chosen.target)}</span>
          </div>
          {chosen.status ? (
            <Tag
              tone={
                chosen.status === 'confirmed'
                  ? 'success'
                  : chosen.status === 'pending'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {chosen.status}
            </Tag>
          ) : null}
          {chosen.quote ? (
            <div>
              <div className={styles.meta}>{t('graph.details.sourceExcerpt')}</div>
              <blockquote className={styles.source}>{chosen.quote}</blockquote>
            </div>
          ) : null}
          <dl className={styles.graphDetailList}>
            <div>
              <dt>{t('graph.details.edgeId')}</dt>
              <dd className={styles.graphDetailCode}>{chosen.id}</dd>
            </div>
          </dl>
        </>
      )}
    </div>
  )
}
