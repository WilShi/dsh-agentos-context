/** Conversation-native memory overview with a readable list and graph. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Tag } from './ui-primitives.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextApi } from './context-api.ts'
import type { ContextMemory } from './context-types.ts'
import { ContextGraph } from './ContextGraph.tsx'
import { ContextModal } from './ContextModal.tsx'
import { ContextWorkbench } from './ContextWorkbench.tsx'
import { ALL_SCOPES_ID, withAllScopes } from './context-all-scopes.ts'
import {
  formatScopeLabel,
  formatTime,
  memoryKindLabel,
  memoryLayerLabel,
  sourceLabel,
  useLiveContextRefresh,
  useLoad,
} from './context-ui-helpers.tsx'
import css from './MemoryView.module.css'

export { groupByDay } from './memory-grouping.ts'
export type { DayGroup } from './memory-grouping.ts'

/**
 * Structural subset of `ConvViewProps` from
 * `@deepseek-ai/dsh-client-ui-conversation/client`. The host package exists at
 * runtime, but this source tree does not install its declarations; only the two
 * members this view reads are declared here.
 */
interface ConversationViewProps {
  readonly sessionId: SessionId
  openView(view: string, id?: string): void
}
export type MemoryViewFace = ConversationViewProps & { contextApi: ContextApi }
type OverviewMode = 'list' | 'graph'

function captureLabel(memory: ContextMemory): string {
  if (memory.legacy) return '历史记忆'
  if (memory.metadata?.distillState === 'local-fallback') return '本地暂存'
  if (memory.metadata?.distilledFrom === 'capture') return '自动提炼'
  return sourceLabel(memory)
}

function MemoryOverviewList({
  api,
  scopeId,
  query,
  totalCount,
  onSelect,
}: {
  api: ContextApi
  scopeId: string
  query: string
  totalCount: number
  onSelect: (memory: ContextMemory) => void
}) {
  const normalized = query.trim().toLocaleLowerCase()
  const state = useLoad(api, 'conversation-list:' + scopeId + ':' + normalized, signal =>
    api.memories(scopeId, {
      ...(normalized ? { query: normalized } : {}),
      lifecycle: 'active',
      limit: 120,
    }, signal),
  )
  const visible = state.data ?? []
  if (state.phase === 'loading' && !state.data)
    return <div className={css.overviewState}>正在读取记忆列表…</div>
  if (state.error && !state.data)
    return (
      <div className={css.overviewState} role="alert">
        {state.error}
        <Button onClick={state.reload}>重试</Button>
      </div>
    )
  if (!state.data?.length && normalized)
    return (
      <div className={css.emptyState}>
        <strong>没有找到匹配的记忆</strong>
        <span>换一个关键词，或清除搜索后查看当前范围的全部记忆。</span>
      </div>
    )
  if (!state.data?.length)
    return (
      <div className={css.emptyState}>
        <strong>当前范围还没有记忆</strong>
        <span>
          自动记忆开启后，偏好、决定、约束和重要事实会在对话处理中自动整理到这里。
        </span>
      </div>
    )
  return (
    <div className={css.memoryOverview} aria-label="记忆列表">
      <div className={css.memoryOverviewHead}>
        <span>{normalized ? '搜索结果' : '最近记忆'}</span>
        <span>
          {normalized
            ? `${visible.length} / ${totalCount} 条`
            : `共 ${totalCount} 条${totalCount > state.data.length ? '，打开完整工作台查看更多' : ''}`}
        </span>
      </div>
      <div className={css.memoryGrid}>
        {visible.map(memory => (
          <button
            type="button"
            className={css.memoryCard}
            key={`${memory.scopeId}\u0000${memory.id}`}
            onClick={() => onSelect(memory)}
          >
            <span className={css.memoryText}>{memory.content}</span>
            <span className={css.memoryMeta}>
              <Tag
                tone={
                  memory.metadata?.distillState === 'local-fallback'
                    ? 'warning'
                    : 'neutral'
                }
              >
                {captureLabel(memory)}
              </Tag>
              <Tag tone={memory.layer === 'working' ? 'warning' : 'info'}>
                {memoryLayerLabel[memory.layer] ?? memory.layer}
              </Tag>
              <span>{memoryKindLabel[memory.kind] ?? memory.kind}</span>
              <time>{formatTime(memory.recordedAt)}</time>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function MemoryDetail({
  memory,
  onClose,
}: {
  memory: ContextMemory | null
  onClose: () => void
}) {
  return (
    <ContextModal
      open={memory !== null}
      onClose={onClose}
      title="记忆详情"
      description={
        memory
          ? `${captureLabel(memory)} · ${formatTime(memory.recordedAt)}`
          : undefined
      }
      closeLabel="关闭"
      footer={
        <Button variant="primary" onClick={onClose}>
          完成
        </Button>
      }
    >
      {memory ? (
        <div className={css.memoryDetail}>
          <div className={css.memoryDetailTags}>
            <Tag tone="neutral">
              {memoryKindLabel[memory.kind] ?? memory.kind}
            </Tag>
            <Tag tone={memory.layer === 'working' ? 'warning' : 'info'}>
              {memoryLayerLabel[memory.layer] ?? memory.layer}记忆
            </Tag>
            <Tag tone="outline">
              重要度 {Math.round((memory.importance ?? 0.5) * 100)}%
            </Tag>
            {memory.legacy ? <Tag tone="info">旧记忆</Tag> : null}
          </div>
          <p className={css.memoryDetailContent}>{memory.content}</p>
          <section>
            <h3>来源</h3>
            <blockquote>{memory.source.content}</blockquote>
            <p>
              {sourceLabel(memory)} · {memory.source.kind}
            </p>
          </section>
          <dl>
            <div>
              <dt>范围</dt>
              <dd>{formatScopeLabel(memory.scopeId, memory.scopeId)}</dd>
            </div>
            <div>
              <dt>版本</dt>
              <dd>v{memory.revision}</dd>
            </div>
            <div>
              <dt>记录时间</dt>
              <dd>{formatTime(memory.recordedAt)}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>{memory.lifecycle}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </ContextModal>
  )
}

/** Hide chat-only host chrome while this non-chat view is active.
 *
 * The composer has a stable host data attribute. The width handle currently
 * has a build-hashed class, so it is identified conservatively by geometry:
 * only a tall, narrow col-resize element touching this surface is marked.
 *
 * H4: the original implementation re-ran `document.querySelectorAll('body *')`
 * plus getComputedStyle/getBoundingClientRect for every body mutation — i.e.
 * once per streaming frame — which caused layout thrash in long conversations.
 * This version never observes mutations. It scans a few times after mount,
 * when the surface or one of its ancestors resizes (ResizeObserver), and on
 * window resize, and it checks geometry before computed style so the number of
 * forced style reads stays proportional to real size changes.
 */
const LAYOUT_HANDLE_HINT = [
  '[role="separator"]',
  '[class*="resize" i]',
  '[class*="handle" i]',
  '[class*="gutter" i]',
  '[class*="splitter" i]',
].join(',')

/** Elements worth probing: the host's own handle classes when they survived the
 *  build, otherwise a bounded walk of the document (the fallback keeps working
 *  for hashed class names). */
function layoutHandleCandidates(): HTMLElement[] {
  const hinted = [...document.querySelectorAll<HTMLElement>(LAYOUT_HANDLE_HINT)]
  if (hinted.length > 0) return hinted
  const all = document.querySelectorAll<HTMLElement>('body *')
  return all.length > 4000 ? [...all].slice(0, 4000) : [...all]
}

function useMemorySurfaceChrome(
  surfaceRef: { readonly current: HTMLElement | null },
): void {
  useEffect(() => {
    const root = document.documentElement
    root.dataset.agentosMemoryActive = 'true'
    const marked = new Set<HTMLElement>()
    let frame = 0
    let debounce = 0
    const scan = () => {
      if (document.visibilityState === 'hidden') return
      const surface = surfaceRef.current
      if (!surface) return
      const area = surface.getBoundingClientRect()
      if (area.width <= 0 || area.height <= 0) return
      for (const candidate of layoutHandleCandidates()) {
        if (candidate === surface || surface.contains(candidate)) continue
        const rect = candidate.getBoundingClientRect()
        if (rect.width <= 0 || rect.width > 48 || rect.height < 80) continue
        const overlapsVertically =
          rect.bottom > area.top && rect.top < area.bottom
        const overlapsHorizontally =
          rect.right >= area.left - 16 && rect.left <= area.right + 16
        if (!overlapsVertically || !overlapsHorizontally) continue
        const cursor = getComputedStyle(candidate).cursor
        if (cursor !== 'col-resize' && cursor !== 'ew-resize') continue
        candidate.dataset.agentosMemoryLayoutHandle = 'true'
        marked.add(candidate)
      }
    }
    // Debounce: a resize drag fires many observer callbacks; one scan per settle
    // is enough and keeps the frame budget free.
    const scheduleScan = () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(debounce)
      debounce = window.setTimeout(() => {
        frame = requestAnimationFrame(scan)
      }, 120)
    }
    scan()
    const retries = [50, 250, 750, 1500, 3000].map(delay =>
      window.setTimeout(scan, delay),
    )
    // Observe the surface and the layout containers that decide where the
    // host's handle sits, instead of every mutation in the document.
    const observed: Element[] = []
    for (
      let node: Element | null = surfaceRef.current;
      node !== null && node !== document.body;
      node = node.parentElement
    ) {
      observed.push(node)
    }
    const resize =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(scheduleScan)
        : null
    for (const node of observed) resize?.observe(node)
    window.addEventListener('resize', scheduleScan)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(debounce)
      resize?.disconnect()
      window.removeEventListener('resize', scheduleScan)
      for (const timer of retries) window.clearTimeout(timer)
      delete root.dataset.agentosMemoryActive
      for (const element of marked)
        delete element.dataset.agentosMemoryLayoutHandle
    }
  }, [surfaceRef])
}

export function MemoryView({
  contextApi,
  sessionId,
  openView,
}: MemoryViewFace) {
  const surfaceRef = useRef<HTMLElement>(null)
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
  const [mode, setMode] = useState<OverviewMode>('list')
  const [query, setQuery] = useState('')
  const [selectedMemory, setSelectedMemory] = useState<ContextMemory | null>(
    null,
  )
  const boot = useLoad(
    contextApi,
    'conversation-overview:' + String(sessionId),
    signal => contextApi.bootstrap(String(sessionId), signal),
  )
  const availableScopes = useMemo(
    () =>
      [...(boot.data?.scopes ?? [])].sort(
        (a, b) => b.count - a.count || a.label.localeCompare(b.label),
      ),
    [boot.data?.scopes],
  )
  const allScope = useMemo(
    () => ({
      id: ALL_SCOPES_ID,
      label: '全部范围',
      count: availableScopes.reduce((total, item) => total + item.count, 0),
    }),
    [availableScopes],
  )
  const orderedScopes = useMemo(
    () => [allScope, ...availableScopes],
    [allScope, availableScopes],
  )
  const displayedScopes = orderedScopes
  const scopedApi = useMemo(
    () =>
      withAllScopes(
        contextApi,
        availableScopes.map(item => item.id),
      ),
    [contextApi, availableScopes],
  )
  const [scopeId, setScopeId] = useState('')
  useMemorySurfaceChrome(surfaceRef)

  useEffect(() => {
    setScopeId('')
    setMode('list')
    setQuery('')
    setSelectedMemory(null)
  }, [sessionId])
  useEffect(() => {
    if (!boot.data) return
    if (
      !scopeId ||
      (scopeId !== ALL_SCOPES_ID &&
        !boot.data.scopes.some(scope => scope.id === scopeId))
    )
      setScopeId(ALL_SCOPES_ID)
  }, [boot.data, orderedScopes, scopeId])
  useEffect(() => {
    setQuery('')
    setSelectedMemory(null)
  }, [scopeId])
  useLiveContextRefresh(scopedApi, scopeId)

  const selected = displayedScopes.find(scope => scope.id === scopeId)
  const close = () => openView('chat', 'agentos-context')
  return (
    <section
      ref={surfaceRef}
      className={css.overview}
      data-context-surface="conversation"
      aria-label="记忆概览"
    >
      <header className={css.overviewHeader}>
        <div className={css.overviewTitleBlock}>
          <h1 className={css.overviewTitle}>记忆</h1>
          <p className={css.overviewSubtitle}>
            {selected
              ? `正在查看“${formatScopeLabel(selected.id, selected.label)}”中的 ${selected.count} 条记忆${boot.data?.features.capture ? '；自动记忆与实时同步已开启' : ''}`
              : '查看跨会话记忆与关系图谱'}
          </p>
        </div>
        <div className={css.overviewActions}>
          {orderedScopes.length ? (
            <select
              aria-label="记忆范围"
              value={scopeId}
              onChange={event => setScopeId(event.currentTarget.value)}
            >
              {orderedScopes.map(scope => (
                <option value={scope.id} key={scope.id}>
                  {formatScopeLabel(scope.id, scope.label)} · {scope.count} 条
                </option>
              ))}
            </select>
          ) : null}
          {mode === 'list' ? (
            <label className={css.overviewSearch}>
              <span className={css.srOnly}>搜索记忆</span>
              <input
                type="search"
                aria-label="搜索记忆"
                placeholder="搜索当前记忆"
                value={query}
                onChange={event => setQuery(event.currentTarget.value)}
              />
              {query ? (
                <button
                  type="button"
                  aria-label="清除记忆搜索"
                  onClick={() => setQuery('')}
                >
                  ×
                </button>
              ) : null}
            </label>
          ) : null}
          <div
            className={css.modeSwitch}
            role="tablist"
            aria-label="记忆显示方式"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'list'}
              onClick={() => setMode('list')}
            >
              列表
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'graph'}
              onClick={() => setMode('graph')}
            >
              图谱
            </button>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setWorkbenchOpen(true)}
          >
            打开完整工作台
          </Button>
          <Button variant="toolbar" size="sm" onClick={close}>
            返回对话
          </Button>
        </div>
      </header>
      <main className={css.overviewBody}>
        {boot.phase === 'loading' && !boot.data ? (
          <div className={css.overviewState}>正在读取记忆图谱…</div>
        ) : null}
        {boot.error && !boot.data ? (
          <div className={css.overviewState} role="alert">
            {boot.error}
            <Button onClick={boot.reload}>重试</Button>
          </div>
        ) : null}
        {boot.data && !scopeId ? (
          <div className={css.overviewState}>当前没有可用的记忆范围。</div>
        ) : null}
        {scopeId && mode === 'list' ? (
          <MemoryOverviewList
            key={'list:' + scopeId}
            api={scopedApi}
            scopeId={scopeId}
            query={query}
            totalCount={selected?.count ?? 0}
            onSelect={setSelectedMemory}
          />
        ) : null}
        {scopeId && mode === 'graph' ? (
          <ContextGraph
            key={'graph:' + scopeId}
            api={scopedApi}
            scopeId={scopeId}
            mode="overview"
          />
        ) : null}
      </main>
      <MemoryDetail
        memory={selectedMemory}
        onClose={() => setSelectedMemory(null)}
      />
      <ContextModal
        open={workbenchOpen}
        onClose={() => setWorkbenchOpen(false)}
        title="完整记忆工作台"
        headless
        className={css.workbenchDialog}
      >
        <div className={css.workbenchDialogBody}>
          <ContextWorkbench
            api={contextApi}
            sessionId={sessionId}
            onClose={() => setWorkbenchOpen(false)}
          />
        </div>
      </ContextModal>
    </section>
  )
}
