/**
 * GraphView — 记忆知识图谱（M4）：cytoscape 懒加载 chunk + fcose/dagre 布局。
 *
 * - 主题：色值全部经 getComputedStyle 读 --dsw-alias-*（带兜底色），
 *   MutationObserver 监听 body[data-ds-dark-theme] 变化后整图换肤。
 * - 交互：滚轮缩放 / 拖拽平移 / 悬停 tooltip / 单击打开详情卡（复用 M3
 *   MemoryDetail，记忆节点经 /memories/:id 取全文）/ 双击选中并聚焦邻居 /
 *   fcose↔dagre 布局切换。
 * - 图例（左下）、空态、stats.truncated 顶部提示条；节点 >300 时标签仅悬停显示。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Core, NodeSingular } from 'cytoscape'
import type { GraphData, GraphNode, MemoryItem, OcApi } from './api.ts'
import { loadGraphChunk } from './graph-chunk-loader.ts'
import { MemoryDetail } from './MemoryView.tsx'
import css from './GraphView.module.css'

declare global {
  interface Window {
    __ocGraph?: { cy: Core }
  }
}

const TYPE_LABELS: Record<string, string> = { memory: '记忆', summary: '摘要', document: '文档' }
const EDGE_LABELS: Record<string, string> = { supersedes: '修订', summarizes: '摘要', references: '引用' }

interface Palette {
  label: string
  memory: string
  summary: string
  document: string
  edge: string
  supersedes: string
  references: string
  session: string
  active: string
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback
}

function readPalette(): Palette {
  return {
    label: cssVar('--dsw-alias-label-primary', '#1f2328'),
    memory: cssVar('--dsw-alias-border-active', '#155eef'),
    summary: '#7c3aed',
    document: cssVar('--dsw-alias-status-success-label', '#0d7a4f'),
    edge: cssVar('--dsw-alias-border-l2', '#9aa4b2'),
    supersedes: '#d97706',
    references: cssVar('--dsw-alias-status-success-label', '#0d7a4f'),
    session: cssVar('--dsw-alias-label-tertiary', '#7a8699'),
    active: cssVar('--dsw-alias-border-active', '#155eef'),
  }
}

function cytoscapeStyle(palette: Palette, showLabels: boolean) {
  return [
    {
      selector: 'node',
      style: {
        'label': showLabels ? 'data(label)' : '',
        'font-size': 9,
        // 截断为 ~14 个全角字符宽：长中文标签在高倍视角下互撞的根因
        'text-max-width': '80px',
        'text-wrap': 'ellipsis',
        'text-overflow-wrap': 'anywhere',
        'color': palette.label,
        'text-valign': 'bottom',
        'text-margin-y': 5,
        'background-color': palette.memory,
        'width': 26,
        'height': 26,
        'border-width': 1.5,
        'border-color': palette.edge,
      },
    },
    { selector: '.node-memory', style: { 'background-color': palette.memory } },
    { selector: '.node-summary', style: { 'background-color': palette.summary, 'shape': 'round-diamond', 'width': 32, 'height': 32 } },
    { selector: '.node-document', style: { 'background-color': palette.document, 'shape': 'round-rectangle' } },
    { selector: '.deprecated', style: { 'opacity': 0.35 } },
    { selector: 'node:selected', style: { 'border-width': 3, 'border-color': palette.active } },
    {
      selector: 'edge',
      style: {
        'width': 1.2,
        'line-color': palette.edge,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': palette.edge,
        'arrow-scale': 0.8,
        'curve-style': 'bezier',
      },
    },
    { selector: '.edge-summarizes', style: { 'line-color': palette.summary, 'target-arrow-color': palette.summary } },
    { selector: '.edge-supersedes', style: { 'line-style': 'dashed', 'line-color': palette.supersedes, 'target-arrow-color': palette.supersedes } },
    { selector: '.edge-references', style: { 'line-style': 'dotted', 'line-color': palette.references, 'target-arrow-color': palette.references } },
    { selector: '.edge-session', style: { 'line-color': palette.session, 'target-arrow-color': palette.session, 'width': 1.6 } },
  ] as cytoscape.Stylesheet[]
}

function toElements(graph: GraphData) {
  return [
    ...graph.nodes.map(n => ({
      data: { id: n.id, label: n.label, nodeType: n.type, deprecated: n.deprecated === true },
      classes: `node-${n.type}${n.deprecated ? ' deprecated' : ''}`,
    })),
    ...graph.edges.map(e => ({
      data: { id: e.id, source: e.source, target: e.target, edgeType: e.type },
      classes: `edge-${e.type}`,
    })),
  ]
}

export function GraphView(props: { api: OcApi }) {
  const { api } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const cyRef = useRef<Core | null>(null)
  const [graph, setGraph] = useState<GraphData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chunkReady, setChunkReady] = useState(false)
  const [layoutName, setLayoutName] = useState<'fcose' | 'dagre'>('fcose')
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: GraphNode } | null>(null)
  const [detail, setDetail] = useState<MemoryItem | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const paletteRef = useRef(readPalette())

  // 拉取图谱数据
  useEffect(() => {
    let cancelled = false
    setError(null)
    api.getGraph({ days: 30 })
      .then((data) => { if (!cancelled) setGraph(data) })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true }
  }, [api, refreshTick])

  // 节点多时标签默认隐藏（悬停 tooltip 仍能看全文）：80 是中文长标签开始互撞的经验线
  const showLabels = (graph?.nodes.length ?? 0) <= 80

  // 初始化/重建 cytoscape（数据或布局语义变化时）
  useEffect(() => {
    const container = containerRef.current
    if (graph === null || container === null) return
    let destroyed = false
    let cy: Core | null = null
    void loadGraphChunk().then((cytoscape) => {
      if (destroyed || containerRef.current === null) return
      paletteRef.current = readPalette()
      cy = cytoscape({
        container: containerRef.current,
        elements: toElements(graph),
        style: cytoscapeStyle(paletteRef.current, showLabels),
        wheelSensitivity: 0.3,
        minZoom: 0.2,
        maxZoom: 3,
      })
      cyRef.current = cy
      // 只读调试句柄（support/E2E 用）：暴露 cy 便于检查节点状态，无写封装。
      window.__ocGraph = { cy }
      runLayout(cy, layoutName)
      setChunkReady(true)

      // 悬停 tooltip
      cy.on('mouseover', 'node', (event) => {
        const node = event.target as NodeSingular
        const rendered = node.renderedPosition()
        const rect = containerRef.current?.getBoundingClientRect()
        if (rect === undefined) return
        setTooltip({
          x: rendered.x + 14,
          y: rendered.y - 8,
          node: {
            id: node.id(),
            type: node.data('nodeType'),
            label: node.data('label'),
            deprecated: node.data('deprecated'),
          },
        })
      })
      cy.on('mouseout', 'node', () => setTooltip(null))
      cy.on('viewport', () => setTooltip(null))

      // 单击 → 详情卡（记忆节点取全文）
      cy.on('tap', 'node', (event) => {
        const node = event.target as NodeSingular
        if (node.data('nodeType') !== 'memory') return
        void api.getMemory(node.id()).then((item) => {
          if (item !== undefined) setDetail(item)
        }).catch(() => undefined)
      })
      cy.on('tap', (event) => {
        if (event.target === cy) setTooltip(null)
      })

      // 双击 → 选中并聚焦邻居（300ms 双 tap 探测）
      let lastTap = 0
      cy.on('tap', 'node', (event) => {
        const now = Date.now()
        const node = event.target as NodeSingular
        if (now - lastTap < 300 && cy !== null) {
          const hood = node.closedNeighborhood()
          cy.elements().unselect()
          hood.select()
          cy.animate({ center: { eles: hood }, duration: 250 })
        }
        lastTap = now
      })
    }).catch((cause: unknown) => {
      if (!destroyed) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      destroyed = true
      setChunkReady(false)
      cy?.destroy()
      if (window.__ocGraph?.cy === cy) delete window.__ocGraph
      cyRef.current = null
    }
  }, [graph, api])

  // 布局切换：不重Init，直接换布局
  useEffect(() => {
    if (cyRef.current !== null) runLayout(cyRef.current, layoutName)
  }, [layoutName])

  // 暗色跟随：body[data-ds-dark-theme] 变化时整图换肤（paletteTick 驱动图例同步换色）
  const [paletteTick, setPaletteTick] = useState(0)
  useEffect(() => {
    const observer = new MutationObserver(() => {
      paletteRef.current = readPalette()
      if (cyRef.current !== null) {
        cyRef.current.style(cytoscapeStyle(paletteRef.current, showLabels))
      }
      setPaletteTick(tick => tick + 1)
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => observer.disconnect()
  }, [showLabels])
  void paletteTick

  const stats = graph?.stats
  const typeCounts = useMemo(() => {
    const counts = { memory: 0, summary: 0, document: 0 }
    for (const node of graph?.nodes ?? []) counts[node.type] += 1
    return counts
  }, [graph])
  const edgeCounts = useMemo(() => {
    const counts: Record<string, number> = { supersedes: 0, summarizes: 0, references: 0, session: 0 }
    for (const edge of graph?.edges ?? []) counts[edge.type] = (counts[edge.type] ?? 0) + 1
    return counts
  }, [graph])

  return (
    <div className={css.root} data-opencontext-graph-view>
      {stats !== undefined ? (
        <div className={css.banner} data-oc-graph-stats>
          最近 {stats.windowDays} 天 · {stats.nodeCount} 节点 · {stats.edgeCount} 条关系
          {stats.truncated ? '（已达上限截断）' : ''}
        </div>
      ) : null}
      <div className={css.canvasWrap}>
        <div ref={containerRef} className={css.canvas} data-oc-graph-canvas />
        {error !== null ? (
          <div className={css.loading}>图谱加载失败：{error}</div>
        ) : graph === null || !chunkReady ? (
          <div className={css.loading}>正在加载图谱组件…</div>
        ) : graph.nodes.length === 0 ? (
          <div className={css.loading}>窗口内还没有可视化的记忆节点。</div>
        ) : null}

        <div className={css.layoutSwitch}>
          <button
            type="button"
            className={`${css.layoutBtn} ${layoutName === 'fcose' ? css.layoutBtnActive : ''}`}
            onClick={() => setLayoutName('fcose')}
          >力导向</button>
          <button
            type="button"
            className={`${css.layoutBtn} ${layoutName === 'dagre' ? css.layoutBtnActive : ''}`}
            onClick={() => setLayoutName('dagre')}
          >层次</button>
          <button
            type="button"
            className={css.layoutBtn}
            onClick={() => { setGraph(null); setChunkReady(false); setRefreshTick(tick => tick + 1) }}
          >⟳</button>
        </div>

        <div className={css.legend} data-oc-graph-legend>
          <div className={css.legendRow}>
            <span className={css.swatch} style={{ background: paletteRef.current.memory }} />记忆（{typeCounts.memory}）
          </div>
          <div className={css.legendRow}>
            <span className={css.swatch} style={{ background: paletteRef.current.summary }} />摘要（{typeCounts.summary}）
          </div>
          <div className={css.legendRow}>
            <span className={css.swatch} style={{ background: paletteRef.current.document }} />文档（{typeCounts.document}）
          </div>
          <div className={css.legendRow}>
            <span
              className={css.swatchLine}
              style={{ borderTopColor: paletteRef.current.supersedes, borderTopStyle: 'dashed' }}
            />修订链（{edgeCounts.supersedes}）
          </div>
          <div className={css.legendRow}>
            <span className={css.swatchLine} style={{ borderTopColor: paletteRef.current.summary }} />
            摘要-成员（{edgeCounts.summarizes}）
          </div>
          <div className={css.legendRow}>
            <span
              className={css.swatchLine}
              style={{ borderTopColor: paletteRef.current.references, borderTopStyle: 'dotted' }}
            />文档引用（{edgeCounts.references}）
          </div>
          <div className={css.legendRow}>
            <span className={css.swatchLine} style={{ borderTopColor: paletteRef.current.session }} />
            同会话（{edgeCounts.session}）
          </div>
        </div>

        {tooltip !== null ? (
          <div className={css.tooltip} style={{ left: tooltip.x, top: tooltip.y }}>
            <div className={css.tooltipType}>
              {TYPE_LABELS[tooltip.node.type] ?? tooltip.node.type}{tooltip.node.deprecated ? '（已废弃）' : ''}
            </div>
            <div>{tooltip.node.label}</div>
          </div>
        ) : null}
      </div>

      {detail !== null ? (
        <MemoryDetail
          item={detail}
          api={api}
          onClose={() => setDetail(null)}
          onChanged={() => { setDetail(null); setGraph(null); setRefreshTick(tick => tick + 1) }}
        />
      ) : null}
    </div>
  )
}

function runLayout(cy: Core, name: 'fcose' | 'dagre'): void {
  const options = name === 'fcose'
    // 收紧斥力与理想边长：无边节点云摊得太开 → 视角放大 → 标签互撞的根因
    ? { name: 'fcose' as const, animate: true, nodeRepulsion: 4000, idealEdgeLength: 70, gravity: 0.5, padding: 60 }
    : { name: 'dagre' as const, animate: true, rankDir: 'LR' as const, nodeSep: 60, rankSep: 110, padding: 60 }
  cy.layout(options as never).run()
}
