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
import type { GraphLayoutMode, GraphSelectIntent } from './ContextGraph3D.tsx'
import {
  exploreGraph,
  graphNeighborhood,
  nextSearchMatch,
  shortestGraphPath,
} from './graph-exploration.ts'
import { ALL_SCOPES_ID } from './context-all-scopes.ts'
import styles from './Context.module.css'

const LAYERS: MemoryLayer[] = ['working', 'episodic', 'semantic', 'procedural']
const EDGE_LABEL: Record<string, string> = { summarizes: '摘要归纳', supersedes: '修订', references: '引用', mentions: '提及', source: '来源', session: '同会话', relation: '关系' }
const TONE_LABELS: Record<string, string> = { working: '工作记忆', episodic: '情节记忆', semantic: '语义记忆', procedural: '程序记忆', entity: '对象', document: '知识文档', source: '来源证据', summary: '摘要', community: '社区' }
function nodeTone(node: { type: string; layer?: string; subtype?: string }): string {
  if (node.type !== 'memory') return node.type
  if (node.layer && (LAYERS as string[]).includes(node.layer)) return node.layer
  const subtype = node.subtype ?? ''
  if (/user_request|capture/iu.test(subtype)) return 'working'
  if (/assistant|reply/iu.test(subtype)) return 'semantic'
  if (/conversation|chat|seed/iu.test(subtype)) return 'episodic'
  return 'semantic'
}
const typeLabels: Record<string, string> = {
  memory: '记忆',
  entity: '对象',
  document: '知识文档',
  source: '来源证据',
  community: '社区',
}
const VIEW_WIDTH = 960,
  VIEW_HEIGHT = 500,
  COMMUNITY_THRESHOLD = 12
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
  const base =
    node.type === 'community'
      ? 12
      : node.type === 'entity'
        ? 8
        : node.type === 'source'
          ? 5
          : 6.5
  return base + Math.min(5, Math.sqrt(Math.max(0, degree)) * 1.4)
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
    return `社区 · ${node.community?.size ?? 0} 项`
  if (node.type === 'memory')
    return `${memoryLayerLabel[node.layer ?? 'semantic']}记忆 · ${Math.round((node.importance ?? 0.5) * 100)}%`
  if (node.type === 'entity') return `对象 · ${node.subtype ?? '未分类'}`
  if (node.type === 'document') return '知识文档'
  if (node.type === 'source') return '来源证据'
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
            type: '跨社区关联',
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
    [viewMode, setViewMode] = useState<'auto' | 'communities' | 'nodes'>(
      'auto',
    ),
    [expanded, setExpanded] = useState<Set<string>>(() => new Set()),
    [dimension, setDimension] = useState<GraphDimension>(savedDimension),
    [layerFilter, setLayerFilter] = useState<MemoryLayer | null>(null),
    [hovered, setHovered] = useState<{ kind: 'node' | 'edge'; id: string; x: number; y: number; title: string; meta: string } | null>(null),
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
  const positions = useMemo(() => graphPositions(graph), [graph]),
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
    for (const point of points) {
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y)
    }
    const hasCommunities = [...(graph?.nodes ?? [])].some(node => node.type === 'community')
    const padX = 150
    const padTop = 120
    const padBottom = hasCommunities ? 210 : 130
    return (minX - padX) + ' ' + (minY - padTop) + ' ' + Math.max(320, maxX - minX + padX * 2) + ' ' + Math.max(220, maxY - minY + padTop + padBottom)
  }, [positions]),
    viewBoxParts = useMemo(() => viewBox.split(' ').map(Number), [viewBox]),
    hoverPercent = (point: { x: number; y: number }) => {
    const [x = 0, y = 0, width = VIEW_WIDTH, height = VIEW_HEIGHT] = viewBoxParts
    return { left: `${Math.max(4, Math.min(88, ((point.x - x) / width) * 100))}%`, top: `${Math.max(4, Math.min(84, ((point.y - y) / height) * 100))}%` }
  },
    degrees = useMemo(() => graphDegrees(graph), [graph])
  const labelLayout = useMemo(() => {
      const layout = new Map<string, { x: number; y: number; text: string }>()
      if (!graph) return layout
      const entries = [...graph.nodes]
        .filter(node => node.type !== 'community' && layerVisible(node))
        .sort((left, right) => (degrees.get(right.id) ?? 0) - (degrees.get(left.id) ?? 0) || left.id.localeCompare(right.id))
        .slice(0, 18)
      const occupied: number[][] = []
      for (const node of entries) {
        const point = positions.get(node.id)
        if (!point) continue
        const radius = compactNodeRadius(node, degrees.get(node.id) ?? 0)
        const text = shortLabel(node.label, 14)
        const width = Math.min(190, [...text].length * 6.4 + 4)
        const candidates = [
          { x: point.x + radius + 6, y: point.y + 4 },
          { x: point.x - radius - 6 - width, y: point.y + 4 },
          { x: point.x - width / 2, y: point.y - radius - 8 },
          { x: point.x - width / 2, y: point.y + radius + 16 },
        ]
        for (const candidate of candidates) {
          const rect = [candidate.x, candidate.y - 9, candidate.x + width, candidate.y + 3]
          const blocked = occupied.some(other => rect[0]! < other[2]! && rect[2]! > other[0]! && rect[1]! < other[3]! && rect[3]! > other[1]!)
          if (blocked) continue
          occupied.push(rect)
          layout.set(node.id, { ...candidate, text })
          break
        }
      }
      return layout
    }, [graph, positions, degrees, layerVisible]),
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
  const highlighted = useMemo(() => {
    if (!graph || selected?.kind !== 'node')
      return { nodeIds: new Set<string>(), edgeIds: new Set<string>() }
    return graphNeighborhood(graph, selected.id)
  }, [graph, selected])
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
    setViewMode('auto')
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
            <summary>范围与时间{rootId || pending || known || valid || depth !== 2 ? ' · 已设置筛选' : ''}</summary>
            <div className={styles.toolbar}>
              <input
                aria-label="图谱中心对象"
                placeholder="中心节点 ID（可选）"
                value={rootId}
                onChange={event => setRootId(event.currentTarget.value)}
              />
              <select
                aria-label="展开层数"
                value={depth}
                onChange={event => setDepth(Number(event.currentTarget.value))}
              >
                <option value={1}>一层</option>
                <option value={2}>两层</option>
                <option value={3}>三层</option>
              </select>
              <label className={styles.inline}>
                <input
                  type="checkbox"
                  className={styles.compactCheckbox}
                  checked={pending}
                  onChange={event => setPending(event.currentTarget.checked)}
                />
                显示待确认关系
              </label>
              <label className={styles.field}>
                系统所知时间
                <input
                  type="datetime-local"
                  value={known}
                  onChange={event => setKnown(event.currentTarget.value)}
                />
              </label>
              <label className={styles.field}>
                事实生效时间
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
                  清除条件
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={state.reload}>
                刷新
              </Button>
            </div>
          </details>
          <div className={styles.badges} aria-label="记忆层级图例">
            <span className={styles.meta}>图例（点击过滤）：</span>
            {LAYERS.map(layer => (
              <button
                key={layer}
                type="button"
                className={`${styles.legendChip} ${styles['legend_' + layer] ?? ''} ${layerFilter === layer ? styles.legendChipActive : ''}`}
                aria-pressed={layerFilter === layer}
                onClick={() => setLayerFilter(layerFilter === layer ? null : layer)}
              >
                {memoryLayerLabel[layer]}
              </button>
            ))}
            <span className={`${styles.legendChip} ${styles.legend_entity}`}>对象 / 来源</span>
            <span className={`${styles.legendChip} ${styles.legend_pending}`}>虚线：待确认</span>
            {layerFilter !== null ? <button type="button" className={styles.legendChip} onClick={() => setLayerFilter(null)}>清除过滤</button> : null}
                    </div>
        </>
      ) : (
        <div className={styles.graphOverviewBar}>
          <div>
            <strong>重点关系概览</strong>
            <span>
              {showCommunities
                ? '已按强连接关系折叠为社区；点击社区展开成员。'
                : '展示最近且关联度较高的节点；选择节点可查看完整内容与来源。'}
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={state.reload}>
            刷新
          </Button>
        </div>
      )}
      <div className={styles.graphUtilityBar}>
        <div className={styles.graphSearchBox}>
          <input
            aria-label="筛选图谱节点"
            placeholder="搜索节点，按 Enter 定位"
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
              {graph?.matchedNodeIds.length ?? 0} 个匹配 · Enter 下一个 · Shift+Enter 上一个
            </span>
          ) : null}
        </div>
        <div className={styles.graphUtilityActions}>
          {dimension === '2d' ? <div className={styles.graphZoom} role="group" aria-label="图谱缩放">
            <button
              type="button"
              aria-label="缩小图谱"
              disabled={zoom <= 0.7}
              onClick={() =>
                setZoom(value =>
                  Math.max(0.7, Number((value - 0.1).toFixed(1))),
                )
              }
            >
              −
            </button>
            <button
              type="button"
              aria-label="重置图谱缩放"
              onClick={() => setZoom(1)}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              aria-label="放大图谱"
              disabled={zoom >= 1.4}
              onClick={() =>
                setZoom(value =>
                  Math.min(1.4, Number((value + 0.1).toFixed(1))),
                )
              }
            >
              ＋
            </button>
          </div> : null}
          <button
            type="button"
            className={styles.graphFullscreenToggle}
            aria-pressed={fullscreen}
            onClick={() => void toggleFullscreen()}
          >{fullscreen ? '退出全屏' : '全屏探索'}</button>
        </div>
      </div>
      <details className={styles.graphFilters}>
        <summary>
          筛选与布局
          {hasVisualFilters ? ' · 已启用' : ''}
        </summary>
        <div className={styles.graphFilterGrid}>
          <label>
            节点类型
            <select value={nodeType} onChange={event => setNodeType(event.currentTarget.value)}>
              <option value="all">全部类型</option>
              {nodeTypes.map(type => <option value={type} key={type}>{typeLabels[type] ?? type}</option>)}
            </select>
          </label>
          <label>
            关系类型
            <select value={edgeType} onChange={event => setEdgeType(event.currentTarget.value)}>
              <option value="all">全部关系</option>
              {edgeTypes.map(type => <option value={type} key={type}>{type}</option>)}
            </select>
          </label>
          <label>
            数据来源
            <select value={origin} onChange={event => setOrigin(event.currentTarget.value as typeof origin)}>
              <option value="all">全部来源</option>
              <option value="current">当前记忆库</option>
              <option value="legacy">兼容的历史记忆</option>
            </select>
          </label>
          <label>
            记忆范围
            <select value={nodeScope} onChange={event => setNodeScope(event.currentTarget.value)}>
              <option value="all">全部范围</option>
              {nodeScopes.map(id => <option value={id} key={id}>{formatScopeLabel(id)}</option>)}
            </select>
          </label>
          {dimension === '3d' ? <label>
            图谱布局
            <select value={layoutMode} onChange={event => setLayoutMode(event.currentTarget.value as GraphLayoutMode)}>
              <option value="community">社区聚类</option>
              <option value="structure">关系结构</option>
              <option value="timeline">时间脉络</option>
            </select>
          </label> : null}
          {hasVisualFilters ? <button type="button" onClick={() => {
            setFilter('')
            setNodeType('all')
            setEdgeType('all')
            setOrigin('all')
            setNodeScope('all')
          }}>清除可视筛选</button> : null}
        </div>
      </details>
      <div className={styles.graphSwitchRow}>
        {communityCapable ? (
          <div
            className={styles.graphViewSwitch}
            role="group"
            aria-label="图谱显示方式"
          >
            <button
              type="button"
              aria-pressed={showCommunities}
              onClick={() => {
                setViewMode('communities')
                setSelected(null)
              }}
            >
              社区视图
            </button>
            <button
              type="button"
              aria-pressed={!showCommunities}
              onClick={() => {
                setViewMode('nodes')
                setSelected(null)
              }}
            >
              节点视图
            </button>
            <span>{state.data?.communities?.length ?? 0} 个社区</span>
          </div>
        ) : null}
        <div
          className={styles.graphViewSwitch}
          role="group"
          aria-label="图谱维度"
        >
          <button
            type="button"
            aria-pressed={dimension === '2d'}
            onClick={() => chooseDimension('2d')}
          >
            2D 实用
          </button>
          <button
            type="button"
            aria-pressed={dimension === '3d'}
            onClick={() => chooseDimension('3d')}
          >
            3D 点云
          </button>
        </div>
      </div>
      {threeError ? (
        <div className={styles.notice} role="status">
          三维图谱暂不可用，已自动切换为 2D：{threeError}
        </div>
      ) : null}
      {state.data && graph ? (
        <div className={styles.graphDataStatus} role="status">
          <span>
            已加载 {state.data.nodes.length} 个节点、{state.data.edges.length} 条关系
          </span>
          {showCommunities ? (
            <span>
              图中聚合显示 {graph.nodes.length} 个社区或节点、{graph.edges.length} 组关系
            </span>
          ) : hasVisualFilters && (graph.hiddenNodeCount > 0 || graph.hiddenEdgeCount > 0) ? (
            <span>
              当前筛选显示 {graph.nodes.length} 个节点、{graph.edges.length} 条关系
            </span>
          ) : null}
          {state.data.stats.truncated ? (
            <strong>
              数据量已达到本次加载上限
              {state.data.stats.totalNodeCount
                ? `（范围内约 ${state.data.stats.totalNodeCount} 个节点）`
                : '，可通过筛选或中心节点继续探索'}
            </strong>
          ) : (
            <span>当前范围已完整加载</span>
          )}
        </div>
      ) : null}
      {state.phase === 'loading' && !graph ? (
        <div className={styles.loading}>正在读取关系图谱…</div>
      ) : null}
      {state.error ? (
        <div className={styles.error} role="alert">
          {state.error}
          <Button onClick={state.reload}>重试</Button>
        </div>
      ) : null}
      {graph && graph.nodes.length === 0 ? (
        <div className={styles.empty}>
          {filter.trim()
            ? '没有匹配的图谱节点，请更换关键词。'
            : '当前范围还没有已建立的对象关系。已有记忆仍然保留，可在列表中查看。'}
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
                  viewBox={viewBox}
                  preserveAspectRatio="xMidYMid meet"
                  role="img"
                  aria-label={`当前范围的关系图，展示 ${graph.nodes.length} 个节点和 ${graph.edges.length} 条关系`}
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
                  <g transform={`translate(${(viewBoxParts[2]! * (1 - zoom)) / 2} ${(viewBoxParts[3]! * (1 - zoom)) / 2}) scale(${zoom})`}>
                    {graph.edges.map((edge) => {
                      const a = positions.get(edge.source), b = positions.get(edge.target)
                      if (!a || !b) return null
                      const sourceNode = nodeById.get(edge.source), targetNode = nodeById.get(edge.target)
                      if (!sourceNode || !targetNode) return null
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
                      return (
                        <g
                          key={edge.id}
                          className={`${styles.edgeHit} ${edgeOnPath ? styles.edgePath : ''} ${edgeDimmed ? styles.edgeDimmed : ''} ${edgeHovered ? styles.edgeHovered : ''}`}
                          onClick={() => setSelected({ kind: 'edge', id: edge.id })}
                          onMouseEnter={() => setHovered({ kind: 'edge', id: edge.id, x: (x1 + x2) / 2, y: (y1 + y2) / 2, title: EDGE_LABEL[edge.type] ?? edge.type, meta: edge.status === 'pending' ? '待确认关系' : edge.count ? `${edge.count} 条跨社区关系` : '已确认关系' })}
                          onMouseLeave={() => setHovered(null)}
                        >
                          <title>{edge.count ? `${edge.count} 条跨社区关系` : edge.type}</title>
                          <path
                            className={edge.status === 'pending' ? `${styles.edge} ${styles.edgePending}` : styles.edge}
                            d={`M${x1} ${y1} Q${(x1 + x2) / 2} ${(y1 + y2) / 2 - 14},${x2} ${y2}`}
                            markerEnd={`url(#${markerId})`}
                          />
                          {edge.count && edge.count > 1 ? (
                            <text className={styles.edgeCount} x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 16}>{edge.count}</text>
                          ) : edgeHovered || edgeHighlighted || edgeOnPath ? (
                            <text className={styles.edgeLabel} x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 16}>{EDGE_LABEL[edge.type] ?? edge.type}</text>
                          ) : null}
                        </g>
                      )
                    })}
                    {graph.nodes.filter(layerVisible).map((node) => {
                      const point = positions.get(node.id)!
                      const active = selected?.id === node.id
                      const highlightedNode = highlighted.nodeIds.has(node.id)
                      const pathNode = pathNodeIds.has(node.id)
                      const compactRadius = compactNodeRadius(node, degrees.get(node.id) ?? 0)
                      const placement = labelLayout.get(node.id)
const isHoveredNode = hovered?.kind === 'node' && hovered.id === node.id
const showCompactLabel = active || highlightedNode || pathNode || placement !== undefined || isHoveredNode
                      const dimmed = selected?.kind === 'node' && !highlightedNode && !pathNode
                      const tone = nodeTone(node)
                      if (node.type === 'community') {
                        const community = (node as VisualNode).community
                        const size = community?.size ?? 0
                        const clusterRadius = 24 + Math.min(18, Math.sqrt(size) * 3.4)
                        const memberCount = Math.min(12, Math.max(3, size))
                        return (
                          <g
                            key={node.id}
                            role="button"
                            tabIndex={0}
                            aria-label={`${nodeDescriptor(node)}，${displayLabel(node.label)}，${size} 项`}
                            className={`${styles.node} ${styles.communityCluster} ${active ? styles.nodeSelected : ''} ${dimmed ? styles.nodeDimmed : ''}`}
                            transform={`translate(${point.x},${point.y})`}
                            onClick={() => setSelected({ kind: 'community', id: node.id })}
                            onMouseEnter={() => setHovered({ kind: 'node', id: node.id, ...hoverPercent(point), title: displayLabel(node.label), meta: `${size} 项 · 点击展开社区` })}
                            onMouseLeave={() => setHovered(null)}
                          >
                            <circle className={styles.communityHalo} r={clusterRadius * 1.55} />
                            <circle className={styles.communityCore} r={clusterRadius * 0.62} />
                            {Array.from({ length: memberCount }, (_, index) => {
                              const angle = (index / memberCount) * Math.PI * 2 - Math.PI / 2
                              return <circle key={index} className={styles.communityMember} cx={Math.cos(angle) * clusterRadius} cy={Math.sin(angle) * clusterRadius} r={1.9} />
                            })}
                            <text className={styles.communityLabel} y={clusterRadius * 1.55 + 14} textAnchor="middle">{shortLabel(node.label, 16)}</text>
                            <text className={styles.communityCount} y={clusterRadius * 1.55 + 28} textAnchor="middle">{size} 项</text>
                          </g>
                        )
                      }
                      return (
                        <g
                          key={node.id}
                          role="button"
                          tabIndex={0}
                          aria-label={`${nodeDescriptor(node)}，${displayLabel(node.label)}`}
                          className={`${styles.node} ${compact2d ? styles.nodeCompact : ''} ${styles['tone_' + tone] ?? ''} ${active ? styles.nodeSelected : ''} ${pathNode ? styles.nodePath : ''} ${dimmed ? styles.nodeDimmed : ''}`}
                          transform={compact2d ? `translate(${point.x},${point.y})` : `translate(${point.x - 64},${point.y - 26})`}
                          onClick={event => selectVisualNode(node, { shiftKey: event.shiftKey })}
                          onDoubleClick={() => selectVisualNode(node, { doubleClick: true })}
                          onMouseEnter={() => setHovered({ kind: 'node', id: node.id, ...hoverPercent(point), title: displayLabel(node.label), meta: [TONE_LABELS[tone] ?? node.type, node.legacy ? '旧版数据' : null, node.timestamp ? formatTime(node.timestamp) : null].filter(Boolean).join(' · ') })}
                          onMouseLeave={() => setHovered(null)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              selectVisualNode(node)
                            }
                          }}
                        >
                          <title>{displayLabel(node.label)}</title>
                          {compact2d ? (
                            <>
                              <circle r={compactRadius} />
                              {showCompactLabel ? (
                                <text className={styles.nodeCompactLabel} x={placement ? placement.x - point.x : compactRadius + 5} y={placement ? placement.y - point.y : 4}>{placement ? placement.text : shortLabel(node.label, 18)}</text>
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
                {hovered !== null ? (
                  <div className={styles.graphHoverCard} style={{ left: hovered.x, top: hovered.y }} role="tooltip">
                    <strong>{hovered.title}</strong>
                    <span>{hovered.meta}</span>
                  </div>
                ) : null}
                </>
              )}
              {selected?.kind === 'node' ? (
                <div className={styles.graphSelectionHint}>
                  {path
                    ? `已显示最短路径：${path.nodeIds.length} 个节点、${path.edgeIds.length} 条关系`
                    : '已突出相邻节点；按住 Shift 再点一个节点可查看最短路径'}
                  {path ? (
                    <button type="button" onClick={() => setPath(null)}>清除路径</button>
                  ) : null}
                </div>
              ) : null}
              {fullscreen ? (
                <button
                  type="button"
                  className={styles.graphFullscreenExit}
                  onClick={() => void toggleFullscreen()}
                >
                  退出全屏
                </button>
              ) : null}
              {chosenNode || chosenEdge || chosenCommunity ? (
                <aside
                  className={styles.graphDrawer}
                  role="dialog"
                  aria-label="图谱详情"
                >
                  <div className={styles.graphDrawerHeader}>
                    <div>
                      <span className={styles.graphDrawerEyebrow}>
                        {chosenCommunity
                          ? '社区详情'
                          : chosenNode
                            ? '节点详情'
                            : '关系详情'}
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
                      aria-label="关闭图谱详情"
                      title="关闭"
                      onClick={closeSelection}
                    >
                      <span aria-hidden="true">×</span>
                    </Button>
                  </div>
                  <div className={styles.graphDrawerBody}>
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
                        查看此范围节点
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
                          ? '折叠这个社区'
                          : '展开社区成员'}
                      </Button>
                    ) : !overview && chosenNode ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRootId(chosenNode.id)}
                      >
                        以此节点为中心展开
                      </Button>
                    ) : null}
                  </div>
                </aside>
              ) : null}
            </div>
          </div>
          {!overview ? (
            <details className={styles.graphNavigator}>
              <summary>按列表查找对象、社区或关系</summary>
              <div className={styles.graphNavigatorFields}>
                <div className={styles.field}>
                  <label htmlFor="context-graph-community">社区</label>
                  <select
                    id="context-graph-community"
                    value={selected?.kind === 'community' ? selected.id : ''}
                    onChange={event =>
                      event.currentTarget.value &&
                      selectCommunity(event.currentTarget.value)
                    }
                  >
                    <option value="">选择社区</option>
                    {(state.data?.communities ?? []).map(row => (
                      <option value={row.id} key={row.id}>
                        {displayLabel(row.label)} · {row.size} 项
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label htmlFor="context-graph-node">对象</label>
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
                    <option value="">选择对象</option>
                    {state.data?.nodes.map(node => (
                      <option value={node.id} key={node.id}>
                        {displayLabel(node.label)} ·{' '}
                        {node.layer
                          ? `${memoryLayerLabel[node.layer]}记忆`
                          : (node.subtype ?? node.type)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label htmlFor="context-graph-edge">关系</label>
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
                    <option value="">选择关系</option>
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
            当前显示 {graph.nodes.length} 个节点、{graph.edges.length} 条关系
            {showCommunities
              ? `；共 ${state.data?.communities?.length ?? 0} 个社区，可点击展开或折叠。`
              : ''}
            {graph.truncated
              ? '；已控制画布节点数量，可通过社区或中心对象继续查看。'
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
        <Tag tone="info">{community.size} 个节点</Tag>
        <Tag tone="neutral">{community.edgeCount} 条内部关系</Tag>
        <Tag tone="warning">{community.externalEdgeCount} 条外部联系</Tag>
      </div>
      <p className={styles.communitySummary}>{community.summary}</p>
      <div className={styles.graphDrawerSectionLabel}>主要对象</div>
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
          <div className={styles.graphDrawerSectionLabel}>关联社区</div>
          <div className={styles.communityMembers}>
            {links.map(({ edge, target }) => (
              <button
                type="button"
                key={edge.id}
                onClick={() => onSelectCommunity(target!.id)}
              >
                {displayLabel(target!.label)}
                <small>
                  {edge.count} 条 · {edge.types.join('、')}
                </small>
              </button>
            ))}
          </div>
        </>
      ) : null}
      <div className={styles.graphDrawerSectionLabel}>节点构成</div>
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
          <dt>记忆范围</dt>
          <dd>{formatScopeLabel(community.scopeId, community.scopeId)}</dd>
        </div>
        <div>
          <dt>社区 ID</dt>
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
    return <div className={styles.loading}>正在读取完整记忆…</div>
  if (state.error && !state.data)
    return (
      <div className={styles.error} role="alert">
        {state.error}
        <Button size="sm" onClick={state.reload}>
          重试
        </Button>
      </div>
    )
  const memory = state.data as ContextMemory | undefined
  if (!memory) return null
  return (
    <div className={styles.stack}>
      <div className={styles.badges}>
        <Tag tone={memory.layer === 'working' ? 'warning' : 'info'}>
          {memoryLayerLabel[memory.layer]}记忆
        </Tag>
        <Tag tone="neutral">{memoryKindLabel[memory.kind] ?? memory.kind}</Tag>
        {memory.legacy ? <Tag tone="info">历史兼容</Tag> : null}
      </div>
      <div className={styles.graphDrawerSectionLabel}>完整记忆</div>
      <p className={styles.graphMemoryContent}>{memory.content}</p>
      <div className={styles.graphDrawerSectionLabel}>来源原文</div>
      <blockquote className={styles.source}>{memory.source.content}</blockquote>
      <p className={styles.meta}>
        {sourceLabel(memory)} · {memory.source.kind}
      </p>
      <dl className={styles.graphDetailList}>
        <div>
          <dt>记录时间</dt>
          <dd>{formatTime(memory.recordedAt)}</dd>
        </div>
        <div>
          <dt>重要度</dt>
          <dd>{Math.round((memory.importance ?? 0.5) * 100)}%</dd>
        </div>
        <div>
          <dt>范围</dt>
          <dd>{formatScopeLabel(memory.scopeId, memory.scopeId)}</dd>
        </div>
        <div>
          <dt>节点 ID</dt>
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
          <div className={styles.graphDrawerSectionLabel}>基本信息</div>
          <dl className={styles.graphDetailList}>
            <div>
              <dt>记录时间</dt>
              <dd>
                {chosen.timestamp ? formatTime(chosen.timestamp) : '时间未知'}
              </dd>
            </div>
            <div>
              <dt>记忆范围</dt>
              <dd>{formatScopeLabel(chosen.scopeId, chosen.scopeId)}</dd>
            </div>
            <div>
              <dt>节点 ID</dt>
              <dd className={styles.graphDetailCode}>{chosen.id}</dd>
            </div>
          </dl>
        </>
      ) : (
        <>
          <div className={styles.graphDrawerSectionLabel}>
            {chosen.count ? '跨社区关系' : '关系路径'}
          </div>
          <div className={styles.graphRelationPath}>
            <span>{displayLabel(source?.label ?? chosen.source)}</span>
            <b>
              {chosen.count
                ? `${chosen.count} 条关系 · ${(chosen.types ?? []).join('、')}`
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
              <div className={styles.meta}>来源摘录</div>
              <blockquote className={styles.source}>{chosen.quote}</blockquote>
            </div>
          ) : null}
          <dl className={styles.graphDetailList}>
            <div>
              <dt>关系 ID</dt>
              <dd className={styles.graphDetailCode}>{chosen.id}</dd>
            </div>
          </dl>
        </>
      )}
    </div>
  )
}
