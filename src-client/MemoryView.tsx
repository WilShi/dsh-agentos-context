/** Conversation-native memory overview with a readable list and graph. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Tag } from './ui-primitives.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { setActiveTranslator, zhT, type AgentosT } from './i18n.ts'
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
import { t } from './i18n.ts'

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
export type MemoryViewFace = ConversationViewProps & {
  contextApi: ContextApi
  /** Locale seat injected by the DSH conversation-view slot registration. */
  t?: AgentosT
}
type OverviewMode = 'list' | 'graph'

function captureLabel(memory: ContextMemory): string {
  if (memory.legacy) return t('memoryView.capture.legacy')
  if (memory.metadata?.distillState === 'local-fallback') return t('memoryView.capture.localFallback')
  if (memory.metadata?.distilledFrom === 'capture') return t('memoryView.capture.autoDistilled')
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
    return <div className={css.overviewState}>{t('memoryView.list.loading')}</div>
  if (state.error && !state.data)
    return (
      <div className={css.overviewState} role="alert">
        {state.error}
        <Button onClick={state.reload}>{t('common.retry')}</Button>
      </div>
    )
  if (!state.data?.length && normalized)
    return (
      <div className={css.emptyState}>
        <strong>{t('memoryView.search.empty.title')}</strong>
        <span>{t('memoryView.search.empty.body')}</span>
      </div>
    )
  if (!state.data?.length)
    return (
      <div className={css.emptyState}>
        <strong>{t('memoryView.empty.title')}</strong>
        <span>
          {t('memoryView.empty.body')}
        </span>
      </div>
    )
  return (
    <div className={css.memoryOverview} aria-label={t('aria.memoryList')}>
      <div className={css.memoryOverviewHead}>
        <span>{normalized ? t('memoryView.head.searchResults') : t('memoryView.head.recent')}</span>
        <span>
          {normalized
            ? t('memoryView.count.search', { visible: visible.length, total: totalCount })
            : t('memoryView.count.total', { count: totalCount }) + (totalCount > state.data.length ? t('memoryView.count.more') : '')}
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
      title={t('memoryView.detail.title')}
      description={
        memory
          ? `${captureLabel(memory)} · ${formatTime(memory.recordedAt)}`
          : undefined
      }
      closeLabel={t('common.close')}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('common.done')}
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
              {t('memoryView.detail.layer', { layer: memoryLayerLabel[memory.layer] ?? memory.layer })}
            </Tag>
            <Tag tone="outline">
              {t('memoryView.detail.importance', { percent: Math.round((memory.importance ?? 0.5) * 100) })}
            </Tag>
            {memory.legacy ? <Tag tone="info">{t('memoryView.detail.legacy')}</Tag> : null}
          </div>
          <p className={css.memoryDetailContent}>{memory.content}</p>
          <section>
            <h3>{t('memoryView.detail.source')}</h3>
            <blockquote>{memory.source.content}</blockquote>
            <p>
              {sourceLabel(memory)} · {memory.source.kind}
            </p>
          </section>
          <dl>
            <div>
              <dt>{t('memoryView.detail.scope')}</dt>
              <dd>{formatScopeLabel(memory.scopeId, memory.scopeId)}</dd>
            </div>
            <div>
              <dt>{t('memoryView.detail.version')}</dt>
              <dd>v{memory.revision}</dd>
            </div>
            <div>
              <dt>{t('memoryView.detail.recordedAt')}</dt>
              <dd>{formatTime(memory.recordedAt)}</dd>
            </div>
            <div>
              <dt>{t('memoryView.detail.status')}</dt>
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
  t: localeSeat,
}: MemoryViewFace) {
  // Publish the locale seat for the graph/workbench descendants and helpers.
  setActiveTranslator(localeSeat ?? zhT)
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
      label: t('scope.all'),
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
      aria-label={t('aria.memoryOverview')}
    >
      <header className={css.overviewHeader}>
        <div className={css.overviewTitleBlock}>
          <h1 className={css.overviewTitle}>{t('nav')}</h1>
          <p className={css.overviewSubtitle}>
            {selected
              ? t('memoryView.viewing', { scope: formatScopeLabel(selected.id, selected.label), count: selected.count, a11y: boot.data?.features.capture ? t('memoryView.viewing.captureOn') : '' })
              : t('memoryView.viewing.subtitle')}
          </p>
        </div>
        <div className={css.overviewActions}>
          {orderedScopes.length ? (
            <select
              aria-label={t('aria.memoryScope')}
              value={scopeId}
              onChange={event => setScopeId(event.currentTarget.value)}
            >
              {orderedScopes.map(scope => (
                <option value={scope.id} key={scope.id}>
                  {t('memoryView.scope.count', { scope: formatScopeLabel(scope.id, scope.label), count: scope.count })}
                </option>
              ))}
            </select>
          ) : null}
          {mode === 'list' ? (
            <label className={css.overviewSearch}>
              <span className={css.srOnly}>{t('aria.memorySearch')}</span>
              <input
                type="search"
                aria-label={t('aria.memorySearch')}
                placeholder={t('aria.memorySearchPlaceholder')}
                value={query}
                onChange={event => setQuery(event.currentTarget.value)}
              />
              {query ? (
                <button
                  type="button"
                  aria-label={t('aria.memorySearchClear')}
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
            aria-label={t('aria.memoryDisplayMode')}
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'list'}
              onClick={() => setMode('list')}
            >
              {t('memoryView.tab.list')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'graph'}
              onClick={() => setMode('graph')}
            >
              {t('memoryView.tab.graph')}
            </button>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setWorkbenchOpen(true)}
          >
            {t('memoryView.openWorkbench')}
          </Button>
          <Button variant="toolbar" size="sm" onClick={close}>
            {t('memoryView.backToChat')}
          </Button>
        </div>
      </header>
      <main className={css.overviewBody}>
        {boot.phase === 'loading' && !boot.data ? (
          <div className={css.overviewState}>{t('memoryView.graph.loading')}</div>
        ) : null}
        {boot.error && !boot.data ? (
          <div className={css.overviewState} role="alert">
            {boot.error}
            <Button onClick={boot.reload}>{t('common.retry')}</Button>
          </div>
        ) : null}
        {boot.data && !scopeId ? (
          <div className={css.overviewState}>{t('memoryView.noScope')}</div>
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
        title={t('memoryView.workbench.title')}
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
