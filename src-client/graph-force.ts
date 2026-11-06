import { useEffect, useMemo, useRef, useState } from 'react'

/** 力导向布局的节点输入（只依赖可视层字段，不引入 d3 依赖）。 */
export interface ForceNodeInput {
  id: string
  communityId?: string
  scopeId?: string
  subcluster?: string
}

export interface ForceEdgeInput {
  source: string
  target: string
}

export interface ForcePoint {
  x: number
  y: number
}

interface SimulationNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  community: string
  subcluster: string
  fixed: boolean
}

const WIDTH = 960
const HEIGHT = 520
const REPULSION = 2600
const SPRING = 0.06
const SPRING_LENGTH = 118
const CENTER_GRAVITY = 0.008
const COMMUNITY_GRAVITY = 0.02
const DAMPING = 0.62
const MIN_DISTANCE = 64

function hashUnit(value: string): number {
  let hash = 2166136261
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return (hash >>> 0) / 4294967296
}

function initialPositions(
  nodes: ForceNodeInput[],
  radiusOf: (node: ForceNodeInput) => number,
): SimulationNode[] {
  const communities = new Map<string, ForceNodeInput[]>()
  for (const node of nodes) {
    const key = node.communityId ?? node.scopeId ?? 'all'
    const bucket = communities.get(key) ?? []
    bucket.push(node)
    communities.set(key, bucket)
  }
  const result: SimulationNode[] = []
  const keys = [...communities.keys()]
  keys.forEach((key, communityIndex) => {
    const bucket = communities.get(key) ?? []
    const angle = (communityIndex / Math.max(1, keys.length)) * Math.PI * 2
    const distance = keys.length > 1 ? 300 : 0
    const cx = WIDTH / 2 + Math.cos(angle) * distance
    const cy = HEIGHT / 2 + Math.sin(angle) * distance * 0.72
    const subKeys = [...new Set(bucket.map(item => item.subcluster ?? key))]
    const subCenters = new Map<string, { x: number; y: number }>()
    subKeys.forEach((subKey, subIndex) => {
      const subAngle = (subIndex / Math.max(1, subKeys.length)) * Math.PI * 2 - Math.PI / 2
      const subDistance = subKeys.length > 1 ? Math.min(130, 60 + subKeys.length * 18) : 0
      subCenters.set(subKey, { x: cx + Math.cos(subAngle) * subDistance, y: cy + Math.sin(subAngle) * subDistance * 0.82 })
    })
    bucket.forEach((node, index) => {
      const subCenter = subCenters.get(node.subcluster ?? key) ?? { x: cx, y: cy }
      const subMembers = bucket.filter(item => (item.subcluster ?? key) === (node.subcluster ?? key)).length
      const spread = 16 + Math.sqrt(subMembers) * 9
      const theta = hashUnit(node.id + ':t') * Math.PI * 2
      const ring = 0.28 + hashUnit(node.id + ':r') * 0.72
      result.push({
        id: node.id,
        x: subCenter.x + Math.cos(theta) * ring * spread,
        y: subCenter.y + Math.sin(theta) * ring * spread * 0.8,
        vx: 0,
        vy: 0,
        community: key,
        subcluster: node.subcluster ?? key,
        fixed: false,
      })
    })
  })
  void radiusOf
  return result
}

function buildSimulation(
  nodes: ForceNodeInput[],
  edges: ForceEdgeInput[],
  radiusOf: (node: ForceNodeInput) => number,
): SimulationNode[] & { tick: () => void; nodeById: Map<string, SimulationNode> } {
  const simulation = initialPositions(nodes, radiusOf)
  const index = new Map(simulation.map(node => [node.id, node]))
  const links = edges
    .map(edge => ({ source: index.get(edge.source), target: index.get(edge.target) }))
    .filter(link => link.source !== undefined && link.target !== undefined) as Array<{
    source: SimulationNode
    target: SimulationNode
  }>
  const communitySum = new Map<string, { x: number; y: number; count: number }>()
  for (const node of simulation) {
    const bucket = communitySum.get(node.community) ?? { x: 0, y: 0, count: 0 }
    bucket.x += node.x
    bucket.y += node.y
    bucket.count += 1
    communitySum.set(node.community, bucket)
  }
  const subSums = new Map<string, { x: number; y: number; count: number }>()
  for (const node of simulation) {
    const bucket = subSums.get(node.subcluster) ?? { x: 0, y: 0, count: 0 }
    bucket.x += node.x; bucket.y += node.y; bucket.count += 1
    subSums.set(node.subcluster, bucket)
  }
  const subCentroids = new Map([...subSums.entries()].map(([key, value]) => [key, { x: value.x / value.count, y: value.y / value.count }]))
  const centroids = new Map(
    [...communitySum.entries()].map(([key, value]) => [key, { x: value.x / value.count, y: value.y / value.count }]),
  )
  for (const node of simulation) {
    const center = centroids.get(node.community)
    if (!center) continue
    const pull = Math.min(0.25, 26 / Math.max(1, Math.hypot(node.x - center.x, node.y - center.y)))
    node.x = center.x + (node.x - center.x) * (1 - pull)
    node.y = center.y + (node.y - center.y) * (1 - pull)
  }
  const nodeById = index
  const radius = (node: SimulationNode) => radiusOf({ id: node.id })
  const tick = () => {
    // 1) 两两排斥（500 节点 = 125k 对，一次布局可接受）
    const list = simulation
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i]!
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j]!
        let dx = b.x - a.x
        let dy = b.y - a.y
        let squared = dx * dx + dy * dy
        if (squared < 0.01) {
          dx = (hashUnit(a.id + b.id) - 0.5) * 2
          dy = (hashUnit(b.id + a.id) - 0.5) * 2
          squared = dx * dx + dy * dy + 0.01
        }
        const distance = Math.sqrt(squared)
        const minDistance = (radius(a) + radius(b) + 16)
        const force = REPULSION / squared + (distance < minDistance ? (minDistance - distance) * 0.22 : 0)
        const ux = dx / distance
        const uy = dy / distance
        a.vx -= ux * force
        a.vy -= uy * force
        b.vx += ux * force
        b.vy += uy * force
      }
    }
    // 2) 边弹簧
    for (const link of links) {
      const dx = link.target.x - link.source.x
      const dy = link.target.y - link.source.y
      const distance = Math.max(0.01, Math.hypot(dx, dy))
      const force = (distance - SPRING_LENGTH) * SPRING
      const ux = dx / distance
      const uy = dy / distance
      link.source.vx += ux * force
      link.source.vy += uy * force
      link.target.vx -= ux * force
      link.target.vy -= uy * force
    }
    // 3) 社区向心 + 全局向心
    for (const node of simulation) {
      const subCenter = subCentroids.get(node.subcluster)
      if (subCenter) { node.vx += (subCenter.x - node.x) * 0.05; node.vy += (subCenter.y - node.y) * 0.05 }
      const center = centroids.get(node.community)
      if (center) {
        node.vx += (center.x - node.x) * COMMUNITY_GRAVITY
        node.vy += (center.y - node.y) * COMMUNITY_GRAVITY
      }
      node.vx += (WIDTH / 2 - node.x) * CENTER_GRAVITY
      node.vy += (HEIGHT / 2 - node.y) * CENTER_GRAVITY
    }
    // 4) 积分 + 阻尼
    for (const node of simulation) {
      if (node.fixed) { node.vx = 0; node.vy = 0; continue }
      node.vx *= DAMPING
      node.vy *= DAMPING
      node.x += Math.max(-9, Math.min(9, node.vx))
      node.y += Math.max(-9, Math.min(9, node.vy))
      node.x = Math.max(24, Math.min(WIDTH - 24, node.x))
      node.y = Math.max(24, Math.min(HEIGHT - 24, node.y))
    }
  }
  return Object.assign(simulation, { tick, nodeById })
}

export interface ForceLayoutOptions {
  radiusOf?: (node: ForceNodeInput) => number
  animate?: boolean
  /** 仅在 2D 节点视图启用；关闭时不做任何模拟（3D/社区聚合视图不需要力导向）。 */
  enabled?: boolean
}

export interface ForceLayoutResult {
  positions: Map<string, ForcePoint>
  settled: boolean
  dragTo: (id: string, point: ForcePoint) => void
  release: (id: string) => void
  reheat: () => void
}

/** 轻量力导向：确定性初始位置 + rAF 收敛动画（无第三方依赖）。 */
export function useForceLayout(
  nodes: ForceNodeInput[],
  edges: ForceEdgeInput[],
  options: ForceLayoutOptions = {},
): ForceLayoutResult {
  const enabled = options.enabled ?? true
  const reduceMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  const animate = (options.animate ?? true) && !reduceMotion
  const radiusOf = useMemo(() => options.radiusOf ?? (() => 10), [options.radiusOf])
  const signature = useMemo(() => nodes.map(node => node.id).join('|') + '::' + edges.map(edge => edge.source + '>' + edge.target).join('|'), [nodes, edges])
  const simulationRef = useRef<ReturnType<typeof buildSimulation> | null>(null)
  const frameRef = useRef<number | null>(null)
  const initialPositions = useMemo(() => {
    const simulation = buildSimulation(nodes, edges, radiusOf)
    const map = new Map<string, ForcePoint>()
    for (const node of simulation) map.set(node.id, { x: node.x, y: node.y })
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])
  const [positions, setPositions] = useState<Map<string, ForcePoint>>(() => initialPositions)
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    if (!enabled) {
      simulationRef.current = null
      setPositions(new Map())
      setSettled(true)
      return
    }
    const simulation = buildSimulation(nodes, edges, radiusOf)
    simulationRef.current = simulation
    const publish = () => {
      const next = new Map<string, ForcePoint>()
      for (const node of simulation) next.set(node.id, { x: node.x, y: node.y })
      setPositions(next)
    }
    publish()
    setSettled(false)
    if (!animate) {
      for (let step = 0; step < 120; step += 1) simulation.tick()
      publish()
      setSettled(true)
      return () => { simulationRef.current = null }
    }
    let frame = 0
    let alpha = 1
    const step = () => {
      frame += 1
      const ticks = frame < 12 ? 3 : 2
      for (let index = 0; index < ticks; index += 1) simulation.tick()
      alpha *= 0.94
      publish()
      if (frame < 90 && alpha > 0.02) frameRef.current = requestAnimationFrame(step)
      else setSettled(true)
    }
    frameRef.current = requestAnimationFrame(step)
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      simulationRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, animate, enabled])

  return {
    positions: positions.size > 0 ? positions : initialPositions,
    settled,
    dragTo: (id, point) => {
      if (!enabled) return
      const simulation = simulationRef.current
      const node = simulation?.nodeById.get(id)
      if (!node) return
      node.fixed = true
      node.x = point.x
      node.y = point.y
      node.vx = 0
      node.vy = 0
      const next = new Map(positions)
      next.set(id, { x: node.x, y: node.y })
      setPositions(next)
    },
    release: (id) => {
      if (!enabled) return
      const node = simulationRef.current?.nodeById.get(id)
      if (node) node.fixed = false
    },
    reheat: () => {
      if (!enabled || !animate) return
      const simulation = simulationRef.current
      if (!simulation) return
      if (frameRef.current !== null) return
      let frame = 0
      const step = () => {
        frame += 1
        for (let index = 0; index < 2; index += 1) simulation.tick()
        const next = new Map<string, ForcePoint>()
        for (const node of simulation) next.set(node.id, { x: node.x, y: node.y })
        setPositions(next)
        if (frame < 25) frameRef.current = requestAnimationFrame(step)
        else frameRef.current = null
      }
      frameRef.current = requestAnimationFrame(step)
    },
  }
}
