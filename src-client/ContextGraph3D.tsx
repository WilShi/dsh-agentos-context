import { useEffect, useMemo, useRef, useState } from 'react'
import * as ThreeRuntime from 'three'
import { OrbitControls as OrbitControlsRuntime } from 'three/addons/controls/OrbitControls.js'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import type { ContextGraphEdge, ContextGraphNode } from './context-types.ts'
import styles from './Context.module.css'
import { localized, t } from './i18n.ts'

type GraphInput = { nodes: ContextGraphNode[]; edges: ContextGraphEdge[] }
type Hovered = { label: string; type: string; x: number; y: number } | null
type Rgb = { r: number; g: number; b: number }
type Palette = {
  background: Rgb
  memory: Rgb
  entity: Rgb
  document: Rgb
  source: Rgb
  community: Rgb
  edge: Rgb
  pending: Rgb
  active: Rgb
}

export type GraphLayoutMode = 'community' | 'structure' | 'timeline'
export type GraphSelectIntent = { shiftKey?: boolean; doubleClick?: boolean }

const typeLabelMap = localized<'memory'|'entity'|'document'|'source'|'community'>('graph.nodeType')
const typeLabels: Record<string, string> = new Proxy({} as Record<string, string>, { get: (_target, key) => key === 'memory' ? t('nav') : typeof key === 'string' ? typeLabelMap[key as 'entity'|'document'|'source'|'community'] : undefined })

function stableUnit(value: string): number {
  let hash = 2166136261
  for (const char of value)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return (hash >>> 0) / 4294967296
}

function mix(left: Rgb, right: Rgb, weight: number): Rgb {
  const inverse = 1 - weight
  return {
    r: Math.round(left.r * inverse + right.r * weight),
    g: Math.round(left.g * inverse + right.g * weight),
    b: Math.round(left.b * inverse + right.b * weight),
  }
}

function parseColor(value: string, fallback: Rgb): Rgb {
  const probe = document.createElement('span')
  probe.style.color = value
  probe.style.display = 'none'
  document.body.append(probe)
  const normalized = getComputedStyle(probe).color
  probe.remove()
  const match = /^rgba?\(\s*([\d.]+)\D+([\d.]+)\D+([\d.]+)/iu.exec(
    normalized,
  )
  return match
    ? { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }
    : fallback
}

function cssColor(name: string, fallback: string): Rgb {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim()
  return parseColor(
    value || fallback,
    parseColor(fallback, { r: 110, g: 137, b: 174 }),
  )
}

/** 创建 renderer 之前先探测 WebGL 能力，避免 THREE.WebGLRenderer 在禁用环境里先打一串错误日志。 */
function probeWebGLSupport(): { ok: boolean; reason: string } {
  if (typeof document === 'undefined') return { ok: false, reason: t('graph3d.error.noDom') }
  try {
    const canvas = document.createElement('canvas')
    const attributes: WebGLContextAttributes = {
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    }
    const context = (canvas.getContext('webgl2', attributes) ??
      canvas.getContext('webgl', attributes)) as WebGLRenderingContext | null
    if (!context) return { ok: false, reason: t('graph3d.error.noWebgl') }
    // 预检用的 context 立即释放，避免占用浏览器 WebGL 上下文配额。
    context.getExtension('WEBGL_lose_context')?.loseContext()
    return { ok: true, reason: '' }
  } catch {
    return { ok: false, reason: t('graph3d.error.noWebgl') }
  }
}

function themePalette(): Palette {
  const accent = cssColor('--dsw-alias-brand-primary', '#6689b9')
  const secondary = cssColor('--dsw-alias-label-secondary', '#8793a4')
  const success = cssColor('--dsw-alias-state-success-primary', '#559b91')
  const warning = cssColor('--dsw-alias-state-warning-primary', '#b58b4d')
  const layer = cssColor('--dsw-alias-bg-layer-1', '#17202d')
  const dark =
    document.body.hasAttribute('data-ds-dark-theme') ||
    document.documentElement.hasAttribute('data-ds-dark-theme')
  return {
    background: dark
      ? mix(layer, { r: 6, g: 11, b: 18 }, 0.58)
      : mix(layer, accent, 0.055),
    memory: mix(accent, secondary, 0.16),
    entity: mix(success, secondary, 0.12),
    document: mix(accent, { r: 139, g: 116, b: 161 }, 0.48),
    source: mix(secondary, accent, 0.16),
    community: mix(accent, { r: 126, g: 112, b: 150 }, 0.42),
    edge: mix(accent, secondary, 0.48),
    pending: mix(warning, secondary, 0.08),
    active: mix(accent, { r: 232, g: 241, b: 255 }, dark ? 0.25 : 0.08),
  }
}

function colorFor(type: string, palette: Palette): Rgb {
  return palette[type as keyof Palette] ?? palette.memory
}
const LAYER_TONES: Record<string, Rgb> = {
  working: { r: 224, g: 160, b: 60 },
  episodic: { r: 139, g: 116, b: 224 },
  semantic: { r: 63, g: 131, b: 216 },
  procedural: { r: 47, g: 158, b: 120 },
}
const TONE_LABELS = localized<'working'|'episodic'|'semantic'|'procedural'|'entity'|'document'|'source'|'summary'|'community'>('graph.tone')
function nodeTone3D(node: { type: string; layer?: string; subtype?: string }): string {
  if (node.type !== 'memory') return node.type
  if (node.layer !== undefined && LAYER_TONES[node.layer] !== undefined) return node.layer
  const subtype = node.subtype ?? ''
  if (/user_request|capture/iu.test(subtype)) return 'working'
  if (/assistant|reply/iu.test(subtype)) return 'semantic'
  if (/conversation|chat|seed/iu.test(subtype)) return 'episodic'
  return 'semantic'
}
function colorForNode(node: ContextGraphNode, palette: Palette): Rgb {
  const tone = nodeTone3D(node)
  return LAYER_TONES[tone] ?? colorFor(node.type, palette)
}

function threeColor(value: Rgb) {
  return new ThreeRuntime.Color(value.r / 255, value.g / 255, value.b / 255)
}

function clusteredPosition(
  node: ContextGraphNode,
  center: { x: number; y: number; z: number },
  spread: number,
) {
  const theta = stableUnit(`${node.id}:theta`) * Math.PI * 2
  const cosPhi = stableUnit(`${node.id}:phi`) * 2 - 1
  const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi))
  const radius = Math.pow(stableUnit(`${node.id}:radius`), 0.38) * spread
  return {
    x: center.x + Math.cos(theta) * sinPhi * radius,
    y: center.y + Math.sin(theta) * sinPhi * radius * 0.72,
    z: center.z + cosPhi * radius,
  }
}

/** Stable layouts: existing nodes keep their position when new memories arrive. */
export function pointCloudPositions(
  graph: GraphInput,
  layoutMode: GraphLayoutMode = 'community',
) {
  const degree = new Map(graph.nodes.map(node => [node.id, 0]))
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }
  const result = new Map<string, { x: number; y: number; z: number }>()

  if (layoutMode === 'timeline') {
    const times = graph.nodes
      .map(node => node.timestamp)
      .filter((value): value is number => Number.isFinite(value))
    const minimum = times.length ? Math.min(...times) : 0
    const maximum = times.length ? Math.max(...times) : 1
    const span = Math.max(1, maximum - minimum)
    for (const node of graph.nodes) {
      const time = Number.isFinite(node.timestamp) ? node.timestamp! : minimum
      result.set(node.id, {
        x: ((time - minimum) / span - 0.5) * 10,
        y: (stableUnit(`${node.id}:timeline:y`) - 0.5) * 5.2,
        z: (stableUnit(`${node.id}:timeline:z`) - 0.5) * 5.2,
      })
    }
    return { positions: result, degree }
  }

  const groupKey = (node: ContextGraphNode) =>
    layoutMode === 'structure' ? node.type : node.communityId || node.type
  const groupKeys = [...new Set(graph.nodes.map(groupKey))].sort()
  const centers = new Map<string, { x: number; y: number; z: number }>()
  for (let index = 0; index < groupKeys.length; index += 1) {
    const key = groupKeys[index]
    if (key === undefined) continue
    if (layoutMode === 'structure') {
      centers.set(key, {
        x: (index - (groupKeys.length - 1) / 2) * 4.2,
        y: 0,
        z: (stableUnit(`${key}:structure:z`) - 0.5) * 2.4,
      })
      continue
    }
    if (groupKeys.length === 1) {
      centers.set(key, { x: 0, y: 0, z: 0 })
      continue
    }
    const radius = 1.1 + Math.sqrt(index) * 0.61
    const theta = index * Math.PI * (3 - Math.sqrt(5))
    centers.set(key, {
      x: Math.cos(theta) * radius,
      y: Math.sin(theta) * radius * 0.62,
      z: (stableUnit(`${key}:community:z`) - 0.5) * 4.5,
    })
  }
  for (const node of graph.nodes) {
    const center = centers.get(groupKey(node)) ?? { x: 0, y: 0, z: 0 }
    result.set(
      node.id,
      clusteredPosition(
        node,
        center,
        node.type === 'community' ? 0.34 : layoutMode === 'structure' ? 2.45 : 0.82,
      ),
    )
  }
  return { positions: result, degree }
}

function label(node: ContextGraphNode): string {
  return node.label.replace(/\s+/gu, ' ').trim()
}

type CommunityVisualNode = ContextGraphNode & {
  community?: { size?: number }
}

/** Keep aggregate scope maps readable without filling dense point clouds with text. */
export function pointCloudPermanentLabel(
  node: ContextGraphNode,
  totalNodes: number,
): string | null {
  if (node.type !== 'community' || totalNodes > 8) return null
  const value = label(node)
  const size = (node as CommunityVisualNode).community?.size
  const compact = value.length > 20 ? `${value.slice(0, 19)}…` : value
  return Number.isFinite(size) && size! > 0 ? `${compact} · ${t('graph3d.sizeItems', { size })}` : compact
}

export function pointCloudNodeRadius(
  node: ContextGraphNode,
  totalNodes: number,
): number {
  if (node.type === 'community') return totalNodes <= 8 ? 0.15 : 0.24
  if (node.type === 'entity') return 0.095
  if (node.type === 'source') return 0.06
  if (node.type === 'document') return 0.085
  return 0.078
}

function createPermanentLabel(
  text: string,
  palette: Palette,
): { sprite: any; texture: any; material: any } | null {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 112
  const context = canvas.getContext('2d')
  if (!context) return null
  const accent = `rgb(${palette.active.r}, ${palette.active.g}, ${palette.active.b})`
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = 'rgba(10, 17, 28, 0.84)'
  context.strokeStyle = accent
  context.lineWidth = 2
  context.beginPath()
  context.roundRect(4, 4, canvas.width - 8, canvas.height - 8, 24)
  context.fill()
  context.stroke()
  context.fillStyle = 'rgba(246, 249, 253, 0.96)'
  context.font = '600 28px "Microsoft YaHei", "PingFang SC", sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  const compact = text.length > 28 ? `${text.slice(0, 27)}…` : text
  context.fillText(compact, canvas.width / 2, canvas.height / 2, canvas.width - 42)
  const texture = new ThreeRuntime.CanvasTexture(canvas)
  texture.colorSpace = ThreeRuntime.SRGBColorSpace
  texture.minFilter = ThreeRuntime.LinearFilter
  texture.magFilter = ThreeRuntime.LinearFilter
  const material = new ThreeRuntime.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const sprite = new ThreeRuntime.Sprite(material)
  sprite.scale.set(1.45, 0.255, 1)
  sprite.renderOrder = 20
  return { sprite, texture, material }
}

type CameraActions = {
  fitAll: () => void
  focusNode: (id: string) => void
  fitNodes: (ids: ReadonlySet<string>) => void
  zoomIn: () => void
  zoomOut: () => void
}

const noopCamera: CameraActions = {
  fitAll: () => {},
  focusNode: () => {},
  fitNodes: () => {},
  zoomIn: () => {},
  zoomOut: () => {},
}

export function ContextGraph3D({
  graph,
  onSelectNode,
  onSelectEdge,
  onUnavailable,
  selectedNodeId,
  highlightedNodeIds,
  highlightedEdgeIds,
  pathNodeIds,
  pathEdgeIds,
  focusNodeId,
  focusRevision,
  layoutMode,
}: {
  graph: GraphInput
  onSelectNode: (node: ContextGraphNode, intent?: GraphSelectIntent) => void
  onSelectEdge: (edge: ContextGraphEdge) => void
  onUnavailable: (reason: string) => void
  selectedNodeId: string | null
  highlightedNodeIds: ReadonlySet<string>
  highlightedEdgeIds: ReadonlySet<string>
  pathNodeIds: ReadonlySet<string>
  pathEdgeIds: ReadonlySet<string>
  focusNodeId: string | null
  focusRevision: number
  layoutMode: GraphLayoutMode
}) {
  const host = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onSelectNode, onSelectEdge, onUnavailable })
  const cameraActions = useRef<CameraActions>(noopCamera)
  const styleActions = useRef({ apply: () => {} })
  const selection = useRef({
    selectedNodeId,
    highlightedNodeIds,
    highlightedEdgeIds,
    pathNodeIds,
    pathEdgeIds,
  })
  const [hovered, setHovered] = useState<Hovered>(null)
  const [autoRotate, setAutoRotate] = useState(true)
  const autoRotateRef = useRef(autoRotate)
  const controlsRef = useRef<any>(null)
  const autoLoopRef = useRef<{ start: () => void; stop: () => void } | null>(null)
  const [themeRevision, setThemeRevision] = useState(0)
  const rendered = useMemo(
    () => ({ ...graph, ...pointCloudPositions(graph, layoutMode) }),
    [graph, layoutMode],
  )
  const counts = useMemo(() => {
    const value: Record<string, number> = {}
    for (const node of graph.nodes) {
      const tone = nodeTone3D(node)
      value[tone] = (value[tone] ?? 0) + 1
    }
    return value
  }, [graph.nodes])

  useEffect(() => {
    callbacks.current = { onSelectNode, onSelectEdge, onUnavailable }
  }, [onSelectNode, onSelectEdge, onUnavailable])

  useEffect(() => {
    selection.current = {
      selectedNodeId,
      highlightedNodeIds,
      highlightedEdgeIds,
      pathNodeIds,
      pathEdgeIds,
    }
    styleActions.current.apply()
  }, [
    selectedNodeId,
    highlightedNodeIds,
    highlightedEdgeIds,
    pathNodeIds,
    pathEdgeIds,
  ])

  useEffect(() => {
    if (focusNodeId) cameraActions.current.focusNode(focusNodeId)
  }, [focusNodeId, focusRevision, rendered])

  useEffect(() => {
    const changed = () => setThemeRevision(value => value + 1)
    const observer = new MutationObserver(changed)
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-ds-dark-theme'],
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-ds-dark-theme'],
    })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = host.current
    if (!element) return
    let disposed = false
    let cleanUp = () => {}
    const webglSupport = probeWebGLSupport()
    if (!webglSupport.ok) {
      callbacks.current.onUnavailable(webglSupport.reason)
      return () => { disposed = true }
    }
    try {
      const palette = themePalette()
      const width = Math.max(320, element.clientWidth || 760)
      const height = Math.max(360, element.clientHeight || 500)
      const scene = new ThreeRuntime.Scene()
      scene.fog = new ThreeRuntime.Fog(threeColor(palette.background), 24, 86)
      const camera = new ThreeRuntime.PerspectiveCamera(
        46,
        width / height,
        0.03,
        160,
      )
      camera.position.set(0, 3, 18)
      const renderer = new ThreeRuntime.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
      })
      renderer.setClearColor(threeColor(palette.background), 0)
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75))
      renderer.setSize(width, height, false)
      renderer.outputColorSpace = ThreeRuntime.SRGBColorSpace
      renderer.domElement.setAttribute('role', 'img')
      renderer.domElement.setAttribute(
        'aria-label',
        t('graph3d.aria.canvas', { nodes: graph.nodes.length, edges: graph.edges.length }),
      )
      renderer.domElement.tabIndex = 0
      element.replaceChildren(renderer.domElement)

      const controls = new OrbitControlsRuntime(camera, renderer.domElement)
      controls.enableDamping = true
      controls.dampingFactor = 0.08
      controls.minDistance = 0.22
      controls.maxDistance = 120
      controls.zoomSpeed = 0.95
      controls.rotateSpeed = 0.62
      controls.autoRotate = autoRotateRef.current
      controls.autoRotateSpeed = 0.55
      controls.panSpeed = 0.72
      controlsRef.current = controls
      const render = () => {
        if (!disposed) renderer.render(scene, camera)
      }
      let autoFrame: number | null = null
      const stopAuto = () => {
        if (autoFrame !== null) { cancelAnimationFrame(autoFrame); autoFrame = null }
      }
      const animateAuto = () => {
        autoFrame = null
        if (disposed || !controls.autoRotate || document.hidden) return
        controls.update()
        render()
        autoFrame = requestAnimationFrame(animateAuto)
      }
      const startAuto = () => {
        if (disposed || autoFrame !== null || !controls.autoRotate) return
        autoFrame = requestAnimationFrame(animateAuto)
      }
      autoLoopRef.current = { start: startAuto, stop: stopAuto }
      startAuto()
      const animateControls = () => {
        if (disposed) return
        if (controls.update()) {
          render()
          requestAnimationFrame(animateControls)
        }
      }
      controls.addEventListener('change', render)
      controls.addEventListener('start', animateControls)
      const renderWhenVisible = () => {
        if (document.hidden) stopAuto()
        else { render(); startAuto() }
      }
      document.addEventListener('visibilitychange', renderWhenVisible)

      const root = new ThreeRuntime.Group()
      scene.add(root)
      const nodeGeometry = new ThreeRuntime.SphereGeometry(1, 16, 12)
      const hitGeometry = new ThreeRuntime.SphereGeometry(1, 8, 6)
      const hitMaterial = new ThreeRuntime.MeshBasicMaterial({
        transparent: true,
        opacity: 0.001,
        depthWrite: false,
      })
      const arrowGeometry = new ThreeRuntime.ConeGeometry(0.055, 0.16, 7)
      const nodeMeshes: any[] = []
      const permanentLabels: Array<{
        sprite: any
        texture: any
        material: any
      }> = []
      const nodeVisuals = new Map<
        string,
        {
          mesh: any
          material: any
          baseRadius: number
        }
      >()
      const realPointPositions: number[] = []
      const realPointColors: number[] = []
      const densityScale = graph.nodes.length < 120 ? 1.38 : graph.nodes.length > 900 ? 1.12 : 1.24
      const labelIds = new Set([...rendered.nodes].sort((left, right) => (rendered.degree.get(right.id) ?? 0) - (rendered.degree.get(left.id) ?? 0)).slice(0, 12).map(item => item.id))
      let labelIndex = 0
      for (const node of rendered.nodes) {
        const point = rendered.positions.get(node.id)
        if (!point) continue
        const degree = rendered.degree.get(node.id) ?? 0
        const color = colorForNode(node, palette)
        const baseRadius = pointCloudNodeRadius(node, graph.nodes.length)
        const radius =
          (baseRadius +
            Math.min(0.3, Math.sqrt(Math.max(0, degree)) * 0.055) +
            (node.importance ?? 0.5) * 0.025) *
          densityScale
        const material = new ThreeRuntime.MeshBasicMaterial({
          color: threeColor(color),
          transparent: true,
          opacity: 0.92,
        })
        const mesh = new ThreeRuntime.Mesh(nodeGeometry, material)
        mesh.scale.setScalar(radius)
        mesh.position.set(point.x, point.y, point.z)
        root.add(mesh)
        const hit = new ThreeRuntime.Mesh(hitGeometry, hitMaterial)
        hit.scale.setScalar(Math.max(0.4, radius * 2.9))
        hit.position.copy(mesh.position)
        hit.userData.node = node
        root.add(hit)
        nodeMeshes.push(hit)
        nodeVisuals.set(node.id, { mesh, material, baseRadius: radius })
        const permanentLabel = pointCloudPermanentLabel(node, graph.nodes.length) ?? (labelIds.has(node.id) ? (label(node).length > 18 ? label(node).slice(0, 17) + '…' : label(node)) : null)
        if (permanentLabel) {
          const visual = createPermanentLabel(permanentLabel, palette)
          if (visual) {
            visual.sprite.scale.multiplyScalar(0.8)
            visual.sprite.position.set(
              point.x,
              point.y + radius + 0.24 + labelIndex * 0.32,
              point.z,
            )
            root.add(visual.sprite)
            permanentLabels.push(visual)
            labelIndex += 1
          }
        }
        realPointPositions.push(point.x, point.y, point.z)
        realPointColors.push(color.r / 255, color.g / 255, color.b / 255)
      }
      const glowMeshes: Array<{ geometry: any; material: any }> = []
      const communityGroups = new Map<string, { x: number; y: number; z: number; radius: number; count: number }>()
      for (const node of rendered.nodes) {
        const community = node.communityId ?? node.scopeId
        if (!community) continue
        const point = rendered.positions.get(node.id)
        if (!point) continue
        const entry = communityGroups.get(community) ?? { x: 0, y: 0, z: 0, radius: 0, count: 0 }
        entry.x += point.x; entry.y += point.y; entry.z += point.z; entry.count += 1
        communityGroups.set(community, entry)
      }
      for (const group of communityGroups.values()) {
        if (group.count < 6) continue
        const cx = group.x / group.count, cy = group.y / group.count, cz = group.z / group.count
        let spread = 0
        for (const node of rendered.nodes) { const point = rendered.positions.get(node.id); if (!point) continue; spread = Math.max(spread, Math.hypot(point.x - cx, point.y - cy, point.z - cz)) }
        const glowGeometry = new ThreeRuntime.SphereGeometry(Math.max(1.4, spread * 1.05), 18, 12)
        const glowMaterial = new ThreeRuntime.MeshBasicMaterial({ color: 0x7f93d8, transparent: true, opacity: 0.06, depthWrite: false, blending: ThreeRuntime.AdditiveBlending })
        const glow = new ThreeRuntime.Mesh(glowGeometry, glowMaterial)
        glow.position.set(cx, cy, cz)
        root.add(glow)
        glowMeshes.push({ geometry: glowGeometry, material: glowMaterial })
      }
      // One halo point per real record. There are no decorative fake nodes.
      const pointGeometry = new ThreeRuntime.BufferGeometry()
      pointGeometry.setAttribute(
        'position',
        new ThreeRuntime.Float32BufferAttribute(realPointPositions, 3),
      )
      pointGeometry.setAttribute(
        'color',
        new ThreeRuntime.Float32BufferAttribute(realPointColors, 3),
      )
      const pointMaterial = new ThreeRuntime.PointsMaterial({
        vertexColors: true,
        size: 0.21,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        blending: ThreeRuntime.AdditiveBlending,
      })
      root.add(new ThreeRuntime.Points(pointGeometry, pointMaterial))

      const lineMaterials = {
        normal: new LineMaterial({
          depthTest: false,
          color: 0x527db5,
          linewidth: 4.2,
          transparent: true,
          opacity: 1,
          resolution: new ThreeRuntime.Vector2(width, height),
        }),
        pending: new LineMaterial({
          depthTest: false,
          color: 0xd28b3c,
          linewidth: 1.35,
          transparent: true,
          opacity: 0.72,
          dashed: true,
          dashSize: 0.12,
          gapSize: 0.08,
          resolution: new ThreeRuntime.Vector2(width, height),
        }),
        cross: new LineMaterial({
          depthTest: false,
          color: 0x9b6bd6,
          linewidth: 3.2,
          transparent: true,
          opacity: 0.9,
          dashed: true,
          dashSize: 0.16,
          gapSize: 0.1,
          resolution: new ThreeRuntime.Vector2(width, height),
        }),
        active: new LineMaterial({
          depthTest: false,
          color: threeColor(palette.active).getHex(),
          linewidth: 2.6,
          transparent: true,
          opacity: 0.96,
          resolution: new ThreeRuntime.Vector2(width, height),
        }),
        path: new LineMaterial({
          color: threeColor(palette.pending).getHex(),
          linewidth: 3.6,
          transparent: true,
          opacity: 1,
          resolution: new ThreeRuntime.Vector2(width, height),
        }),
        dim: new LineMaterial({
          color: threeColor(palette.edge).getHex(),
          linewidth: 0.75,
          transparent: true,
          opacity: 0.08,
          resolution: new ThreeRuntime.Vector2(width, height),
        }),
      }
      const arrowMaterials = {
        normal: new ThreeRuntime.MeshBasicMaterial({
          color: threeColor(palette.edge),
          transparent: true,
          opacity: 0.64,
        }),
        pending: new ThreeRuntime.MeshBasicMaterial({
          color: threeColor(palette.pending),
          transparent: true,
          opacity: 0.82,
        }),
        active: new ThreeRuntime.MeshBasicMaterial({
          color: threeColor(palette.active),
          transparent: true,
          opacity: 0.98,
        }),
        path: new ThreeRuntime.MeshBasicMaterial({
          color: threeColor(palette.pending),
          transparent: true,
          opacity: 1,
        }),
        dim: new ThreeRuntime.MeshBasicMaterial({
          color: threeColor(palette.edge),
          transparent: true,
          opacity: 0.08,
        }),
      }
      const edgeHits: any[] = []
      const hitLineMaterial = new ThreeRuntime.LineBasicMaterial({
        transparent: true,
        opacity: 0.001,
        depthWrite: false,
      })
      const edgeVisuals = new Map<
        string,
        { line: any; arrow: any; pending: boolean }
      >()
      for (const edge of rendered.edges) {
        const source = rendered.positions.get(edge.source)
        const target = rendered.positions.get(edge.target)
        if (!source || !target) continue
        const geometry = new LineGeometry()
        geometry.setPositions([
          source.x,
          source.y,
          source.z,
          target.x,
          target.y,
          target.z,
        ])
        const pending = edge.status === 'pending'
        const sourceCommunity = (rendered.nodes.find(item => item.id === edge.source) as ContextGraphNode | undefined)?.communityId
        const targetCommunity = (rendered.nodes.find(item => item.id === edge.target) as ContextGraphNode | undefined)?.communityId
        const crossCommunity = sourceCommunity !== undefined && targetCommunity !== undefined && sourceCommunity !== targetCommunity
        const line = new Line2(
          geometry,
          pending ? lineMaterials.pending : crossCommunity ? lineMaterials.cross : lineMaterials.normal,
        )
        line.computeLineDistances()
        root.add(line)
        const from = new ThreeRuntime.Vector3(source.x, source.y, source.z)
        const to = new ThreeRuntime.Vector3(target.x, target.y, target.z)
        const direction = to.clone().sub(from).normalize()
        const arrow = new ThreeRuntime.Mesh(
          arrowGeometry,
          pending ? arrowMaterials.pending : arrowMaterials.normal,
        )
        arrow.position.copy(to).addScaledVector(direction, -0.19)
        arrow.quaternion.setFromUnitVectors(
          new ThreeRuntime.Vector3(0, 1, 0),
          direction,
        )
        root.add(arrow)
        const hitGeometry = new ThreeRuntime.BufferGeometry().setFromPoints([from, to])
        const hit = new ThreeRuntime.Line(hitGeometry, hitLineMaterial)
        hit.userData.edge = edge
        root.add(hit)
        edgeHits.push(hit)
        edgeVisuals.set(edge.id, { line, arrow, pending })
      }

      styleActions.current.apply = () => {
        const current = selection.current
        const hasSelection = !!current.selectedNodeId || current.pathNodeIds.size > 0
        for (const [id, visual] of nodeVisuals) {
          const onPath = current.pathNodeIds.has(id)
          const highlighted = current.highlightedNodeIds.has(id)
          const selected = current.selectedNodeId === id
          visual.material.opacity = hasSelection
            ? onPath || highlighted || selected
              ? 1
              : 0.13
            : 0.92
          const scale = selected ? 1.9 : onPath ? 1.55 : highlighted ? 1.2 : hasSelection ? 0.82 : 1
          visual.mesh.scale.setScalar(visual.baseRadius * scale)
        }
        for (const [id, visual] of edgeVisuals) {
          const onPath = current.pathEdgeIds.has(id)
          const highlighted = current.highlightedEdgeIds.has(id)
          const key = onPath
            ? 'path'
            : highlighted
              ? 'active'
              : hasSelection
                ? 'dim'
                : visual.pending
                  ? 'pending'
                  : 'normal'
          visual.line.material = lineMaterials[key]
          visual.arrow.material = arrowMaterials[key]
        }
        render()
      }

      const pointsFor = (ids?: ReadonlySet<string>) => {
        const points: any[] = []
        for (const [id, point] of rendered.positions) {
          if (!ids || ids.has(id))
            points.push(new ThreeRuntime.Vector3(point.x, point.y, point.z))
        }
        return points
      }
      const frame = (points: any[]) => {
        if (!points.length) return
        const box = new ThreeRuntime.Box3().setFromPoints(points)
        const center = box.getCenter(new ThreeRuntime.Vector3())
        const size = box.getSize(new ThreeRuntime.Vector3())
        const direction = camera.position
          .clone()
          .sub(controls.target)
          .normalize()
        if (!Number.isFinite(direction.x) || direction.lengthSq() < 0.1)
          direction.set(0, 0.25, 1).normalize()
        const halfFov = ThreeRuntime.MathUtils.degToRad(camera.fov / 2)
        const projectedHalfExtent = Math.max(
          size.y / 2,
          size.x / Math.max(2, camera.aspect * 2),
          size.z * 0.28,
        )
        const distance = Math.min(
          96,
          Math.max(
            1.1,
            (projectedHalfExtent / Math.tan(halfFov)) * 1.16 + size.z / 2,
          ),
        )
        controls.target.copy(center)
        camera.position.copy(center).addScaledVector(direction, distance)
        camera.near = Math.max(0.02, distance / 500)
        camera.far = Math.max(160, distance * 8)
        camera.updateProjectionMatrix()
        controls.update()
        render()
      }
      cameraActions.current = {
        fitAll: () => frame(pointsFor()),
        fitNodes: ids => frame(pointsFor(ids)),
        focusNode: (id) => {
          const point = rendered.positions.get(id)
          if (!point) return
          const target = new ThreeRuntime.Vector3(point.x, point.y, point.z)
          const direction = camera.position
            .clone()
            .sub(controls.target)
            .normalize()
          controls.target.copy(target)
          camera.position.copy(target).addScaledVector(direction, 1.35)
          controls.update()
          render()
        },
        zoomIn: () => {
          const offset = camera.position.clone().sub(controls.target)
          camera.position.copy(controls.target).add(offset.multiplyScalar(0.64))
          controls.update()
          render()
        },
        zoomOut: () => {
          const offset = camera.position.clone().sub(controls.target)
          camera.position.copy(controls.target).add(offset.multiplyScalar(1.48))
          controls.update()
          render()
        },
      }

      const raycaster = new ThreeRuntime.Raycaster()
      raycaster.params.Line.threshold = 0.2
      const pointer = new ThreeRuntime.Vector2()
      let pointerDown: { x: number; y: number } | null = null
      const pointerAt = (event: PointerEvent | MouseEvent) => {
        const rect = renderer.domElement.getBoundingClientRect()
        pointer.x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1
        pointer.y = -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1
        return { x: event.clientX - rect.left, y: event.clientY - rect.top }
      }
      let hoverMeshId: string | null = null
      const highlightHover = (id: string | null) => {
        if (hoverMeshId === id) return
        const previous = hoverMeshId !== null ? nodeVisuals.get(hoverMeshId) : undefined
        if (previous) { previous.mesh.scale.setScalar(previous.baseRadius); previous.material.opacity = 0.92 }
        hoverMeshId = id
        const next = id !== null ? nodeVisuals.get(id) : undefined
        if (next) { next.mesh.scale.setScalar(next.baseRadius * 1.75); next.material.opacity = 1 }
      }
      const pick = (
        event: PointerEvent | MouseEvent,
        choose = false,
        intent: GraphSelectIntent = {},
      ) => {
        const at = pointerAt(event)
        raycaster.setFromCamera(pointer, camera)
        const nodeHit = raycaster.intersectObjects(nodeMeshes, false)[0]?.object
        if (nodeHit?.userData.node) {
          const node = nodeHit.userData.node as ContextGraphNode
          highlightHover(node.id)
          renderer.domElement.style.cursor = 'pointer'
          setHovered({
            label: label(node),
            type: typeLabels[node.type] ?? node.type,
            ...at,
          })
          if (choose) callbacks.current.onSelectNode(node, intent)
          return true
        }
        const edgeHit = raycaster.intersectObjects(edgeHits, false)[0]?.object
        if (edgeHit?.userData.edge) {
          const edge = edgeHit.userData.edge as ContextGraphEdge
          renderer.domElement.style.cursor = 'pointer'
          setHovered({ label: edge.type, type: t('workbench.field.relation'), ...at })
          if (choose) callbacks.current.onSelectEdge(edge)
          return true
        }
        highlightHover(null)
        renderer.domElement.style.cursor = 'grab'
        setHovered(null)
        return false
      }
      const pointerMove = (event: PointerEvent) => pick(event)
      const pointerDownHandler = (event: PointerEvent) => {
        pointerDown = { x: event.clientX, y: event.clientY }
      }
      const pointerUp = (event: PointerEvent) => {
        if (
          pointerDown &&
          Math.hypot(
            event.clientX - pointerDown.x,
            event.clientY - pointerDown.y,
          ) < 5
        )
          pick(event, true, { shiftKey: event.shiftKey })
        pointerDown = null
      }
      const doubleClick = (event: MouseEvent) => {
        if (pick(event, true, { shiftKey: event.shiftKey, doubleClick: true }))
          event.preventDefault()
      }
      const leave = () => {
        pointerDown = null
        setHovered(null)
      }
      const contextLost = (event: Event) => {
        event.preventDefault()
        if (!disposed) callbacks.current.onUnavailable(t('graph3d.unavailable.deviceReset'))
      }
      const keyDown = (event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          const rect = renderer.domElement.getBoundingClientRect()
          pick({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 } as MouseEvent, true)
          return
        }
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        const offset = camera.position.clone().sub(controls.target)
        const spherical = new ThreeRuntime.Spherical().setFromVector3(offset)
        if (event.key === 'ArrowLeft') spherical.theta -= 0.12
        if (event.key === 'ArrowRight') spherical.theta += 0.12
        if (event.key === 'ArrowUp') spherical.phi = Math.max(0.08, spherical.phi - 0.1)
        if (event.key === 'ArrowDown') spherical.phi = Math.min(Math.PI - 0.08, spherical.phi + 0.1)
        camera.position.copy(controls.target).add(offset.setFromSpherical(spherical))
        camera.lookAt(controls.target)
        controls.update()
        render()
      }
      renderer.domElement.addEventListener('keydown', keyDown)
      renderer.domElement.addEventListener('pointermove', pointerMove)
      renderer.domElement.addEventListener('pointerdown', pointerDownHandler)
      renderer.domElement.addEventListener('pointerup', pointerUp)
      renderer.domElement.addEventListener('pointerleave', leave)
      renderer.domElement.addEventListener('dblclick', doubleClick)
      renderer.domElement.addEventListener('webglcontextlost', contextLost)

      const resize = () => {
        const nextWidth = Math.max(320, element.clientWidth || 760)
        const nextHeight = Math.max(360, element.clientHeight || 500)
        camera.aspect = nextWidth / nextHeight
        camera.updateProjectionMatrix()
        renderer.setSize(nextWidth, nextHeight, false)
        for (const material of Object.values(lineMaterials))
          material.resolution.set(nextWidth, nextHeight)
        cameraActions.current.fitAll()
      }
      const observer = new ResizeObserver(resize)
      observer.observe(element)
      cameraActions.current.fitAll()
      styleActions.current.apply()
      let probeFrame: number | null = null
      probeFrame = requestAnimationFrame(() => {
        probeFrame = null
        if (disposed || (graph?.nodes?.length ?? 0) === 0) return
        try {
          renderer.render(scene, camera)
          const gl = renderer.getContext()
          const info = renderer.info.render
          const painted = info.points + info.lines + info.triangles
          if ((gl.isContextLost?.() ?? false) || painted === 0) {
            callbacks.current.onUnavailable(t('graph3d.unavailable.noContent'))
          }
        } catch (error) {
          console.warn('[agentos-context] 3D paint probe failed', error)
        }
      })
      cleanUp = () => {
        observer.disconnect()
        controls.removeEventListener('change', render)
        controls.removeEventListener('start', animateControls)
        document.removeEventListener('visibilitychange', renderWhenVisible)
        controls.dispose()
        renderer.domElement.removeEventListener('keydown', keyDown)
        renderer.domElement.removeEventListener('pointermove', pointerMove)
        renderer.domElement.removeEventListener('pointerdown', pointerDownHandler)
        renderer.domElement.removeEventListener('pointerup', pointerUp)
        renderer.domElement.removeEventListener('pointerleave', leave)
        renderer.domElement.removeEventListener('dblclick', doubleClick)
        renderer.domElement.removeEventListener('webglcontextlost', contextLost)
        for (const visual of nodeVisuals.values()) visual.material.dispose()
        for (const visual of edgeVisuals.values()) visual.line.geometry.dispose()
        for (const material of Object.values(lineMaterials)) material.dispose()
        for (const material of Object.values(arrowMaterials)) material.dispose()
        for (const hit of edgeHits) hit.geometry.dispose()
        for (const visual of permanentLabels) {
          visual.texture.dispose()
          visual.material.dispose()
        }
        for (const glow of glowMeshes) { glow.geometry.dispose(); glow.material.dispose() }
        nodeGeometry.dispose()
        hitGeometry.dispose()
        hitMaterial.dispose()
        hitLineMaterial.dispose()
        arrowGeometry.dispose()
        pointGeometry.dispose()
        pointMaterial.dispose()
        scene.clear()
        renderer.renderLists.dispose()
        renderer.dispose()
        renderer.forceContextLoss()
        stopAuto()
        if (probeFrame !== null) cancelAnimationFrame(probeFrame)
        autoLoopRef.current = null
        controlsRef.current = null
        renderer.domElement.remove()
        cameraActions.current = noopCamera
        styleActions.current.apply = () => {}
      }
    } catch (error) {
      console.error('[agentos-context] 3D graph unavailable', error)
      if (!disposed)
        callbacks.current.onUnavailable(
          t('graph3d.error.noWebgl'),
        )
    }
    return () => {
      disposed = true
      cleanUp()
    }
  }, [graph, layoutMode, rendered, themeRevision])

  useEffect(() => {
    autoRotateRef.current = autoRotate
    const controls = controlsRef.current
    const loop = autoLoopRef.current
    if (!controls || !loop) return
    controls.autoRotate = autoRotate
    if (autoRotate) loop.start()
    else loop.stop()
  }, [autoRotate])

  return (
    <div
      className={styles.graph3d}
      aria-label={t('aria.graph3d')}
      data-context-point-cloud
      data-context-graph-layout={layoutMode}
    >
      <div className={styles.graph3dCanvas} ref={host} />
      <div className={styles.graph3dLegend} aria-label={t('aria.graphLegend')}>
        {(['working', 'episodic', 'semantic', 'procedural', 'entity', 'document', 'summary', 'source'] as const)
          .filter(tone => (counts[tone] ?? 0) > 0)
          .map(tone => (
            <span key={tone}>
              <i className={styles[`graphDot_${tone}`]} />
              {TONE_LABELS[tone] ?? tone} {counts[tone]}
            </span>
          ))}
      </div>
      <div className={styles.graph3dSummary}>
        <b>{t('graph3d.nodes', { count: graph.nodes.length })}</b>
        <span>{t('graph3d.edges', { count: graph.edges.length })}</span>
      </div>
      {hovered && (
        <div
          className={styles.graph3dTooltip}
          data-context-graph-tooltip
          style={{ left: hovered.x + 14, top: hovered.y + 14 }}
        >
          <b>{hovered.type}</b>
          <span>{hovered.label}</span>
        </div>
      )}
      <div className={styles.graph3dControls} role="group" aria-label={t('aria.graph3dViewport')}>
        <button
          type="button"
          aria-label={t('aria.fitAll')}
          title={t('graph3d.fitAll')}
          onClick={() => cameraActions.current.fitAll()}
        >
          ⛶
        </button>
        <button
          type="button"
          aria-label={t('aria.focusSelection')}
          title={t('graph3d.focusSelection')}
          disabled={!selectedNodeId}
          onClick={() => cameraActions.current.fitNodes(highlightedNodeIds)}
        >
          ◎
        </button>
        <button
          type="button"
          aria-label={t('aria.zoomIn3d')}
          title={t('graph3d.zoomIn')}
          onClick={() => cameraActions.current.zoomIn()}
        >
          ＋
        </button>
        <button
          type="button"
          aria-label={t('aria.autoRotate')}
          aria-pressed={autoRotate}
          title={autoRotate ? t('graph3d.pauseRotate') : t('graph3d.startRotate')}
          onClick={() => setAutoRotate(value => !value)}
        >
          {autoRotate ? "❚❚" : "▶"}
        </button>
        <button
          type="button"
          aria-label={t('aria.zoomOut3d')}
          title={t('graph3d.zoomOut')}
          onClick={() => cameraActions.current.zoomOut()}
        >
          －
        </button>
      </div>
      <div className={styles.graph3dHelp}>
        {t('graph3d.hint')}
      </div>
      <div className={styles.srOnly} aria-label={t('aria.graph3dNodes')}>
        {graph.nodes.map(node => (
          <button
            type="button"
            data-context-graph-node={node.id}
            key={node.id}
            onClick={event =>
              onSelectNode(node, { shiftKey: event.shiftKey })
            }
            onDoubleClick={() => onSelectNode(node, { doubleClick: true })}
          >
            {label(node)}
          </button>
        ))}
      </div>
    </div>
  )
}
