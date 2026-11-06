import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Switch, Tag } from './ui-primitives.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextApi } from './context-api.ts'
import type {
  ContextBootstrap,
  ContextMemory,
  ContextUsage,
  UsagePolicy,
} from './context-types.ts'
import {
  plainError,
  sourceLabel,
  usageLabel,
  useApiRevision,
  useMutationGuard,
} from './context-ui-helpers.tsx'
import { ContextModal } from './ContextModal.tsx'
import styles from './Context.module.css'
import { t, type AgentosContextLocaleKey } from './i18n.ts'
type PaneTab = 'requested' | 'other' | 'related'
const PANE_TABS: [PaneTab, AgentosContextLocaleKey][] = [
  ['requested', 'pane.phase.requested'],
  ['other', 'pane.phase.other'],
  ['related', 'pane.phase.related'],
]
export interface ContextMemoryPaneProps {
  api: ContextApi
  sessionId: SessionId
  onClose: () => void
  onManage: () => void
}
export function ContextMemoryPane({
  api,
  sessionId,
  onClose,
  onManage,
}: ContextMemoryPaneProps) {
  const revision = useApiRevision(api),
    saveKey = useRef(''),
    loadGeneration = useRef(0),
    loadController = useRef<AbortController | null>(null),
    currentSession = useRef(String(sessionId)),
    runMutation = useMutationGuard(String(sessionId))
  currentSession.current = String(sessionId)
  const [boot, setBoot] = useState<ContextBootstrap | null>(null),
    [items, setItems] = useState<ContextUsage[]>([]),
    [related, setRelated] = useState<ContextMemory[]>([]),
    [policy, setPolicy] = useState<UsagePolicy | null>(null),
    [error, setError] = useState<string | null>(null),
    [relatedError, setRelatedError] = useState<string | null>(null),
    [view, setView] = useState<PaneTab>('requested'),
    [busy, setBusy] = useState(false),
    [saveOpen, setSaveOpen] = useState(false),
    [content, setContent] = useState(''),
    [saveError, setSaveError] = useState('')
  const load = async () => {
    const generation = ++loadGeneration.current
    loadController.current?.abort(new DOMException('Superseded', 'AbortError'))
    const controller = new AbortController()
    loadController.current = controller
    setBoot(null)
    setItems([])
    setRelated([])
    setPolicy(null)
    setError(null)
    setRelatedError(null)
    try {
      const b = await api.bootstrap(String(sessionId), controller.signal)
      if (controller.signal.aborted || generation !== loadGeneration.current)
        return
      setBoot(b)
      const scope = b.sessionScope ?? b.defaultScope
      const [u, m] = await Promise.allSettled([
        api.usage(scope, String(sessionId), controller.signal),
        api.memories(
          scope,
          { lifecycle: 'active', limit: 30 },
          controller.signal,
        ),
      ])
      if (controller.signal.aborted || generation !== loadGeneration.current)
        return
      if (u.status === 'fulfilled') {
        setItems(u.value.items)
        setPolicy(u.value.policy)
      } else setError(plainError(u.reason))
      if (m.status === 'fulfilled') setRelated(m.value)
      else setRelatedError(plainError(m.reason))
    } catch (e) {
      if (
        !controller.signal.aborted &&
        generation === loadGeneration.current &&
        (e as Error).name !== 'AbortError'
      )
        setError(plainError(e))
    } finally {
      if (loadController.current === controller) loadController.current = null
    }
  }
  useEffect(() => {
    void load()
    return () => {
      loadGeneration.current++
      loadController.current?.abort(
        new DOMException('Unmounted', 'AbortError'),
      )
      loadController.current = null
    }
  }, [api, sessionId, revision])
  const scope = boot?.sessionScope ?? boot?.defaultScope,
    snapshots = useMemo(
      () => items.flatMap(x => x.items.map(m => ({ usage: x, m }))),
      [items],
    ),
    requested = useMemo(
      () => snapshots.filter(x => x.usage.phase === 'requested'),
      [snapshots],
    ),
    other = useMemo(
      () => snapshots.filter(x => x.usage.phase !== 'requested'),
      [snapshots],
    ),
    requestedIds = useMemo(
      () => new Set(requested.map(x => x.m.id)),
      [requested],
    ),
    candidates = related.filter(x => !requestedIds.has(x.id))
  const setPolicyValue = async (
    input: Parameters<ContextApi['setUsagePolicy']>[0],
  ) => {
    if (!scope || busy) return
    const actionSession = String(sessionId)
    setBusy(true)
    setError(null)
    try {
      const p = await runMutation(signal =>
        api.setUsagePolicy(
          {
            ...input,
            scopeId: scope,
            sessionId: actionSession,
            ...(policy ? { expectedRevision: policy.revision } : {}),
          },
          signal,
        ),
      )
      if (currentSession.current !== actionSession) return
      setPolicy(p)
      await load()
    } catch (e) {
      if (
        currentSession.current === actionSession &&
        (e as Error).name !== 'AbortError'
      )
        setError(plainError(e))
    } finally {
      if (currentSession.current === actionSession) setBusy(false)
    }
  }
  const save = async () => {
    if (!scope || !content.trim() || busy) return
    const actionSession = String(sessionId)
    setBusy(true)
    setSaveError('')
    try {
      await runMutation(signal =>
        api.saveMemory(
          {
            scopeId: scope,
            content: content.trim(),
            kind: 'note',
            idempotencyKey: saveKey.current,
          },
          signal,
        ),
      )
      if (currentSession.current !== actionSession) return
      setContent('')
      setSaveOpen(false)
      await load()
    } catch (e) {
      if (
        currentSession.current === actionSession &&
        (e as Error).name !== 'AbortError'
      )
        setSaveError(plainError(e))
    } finally {
      if (currentSession.current === actionSession) setBusy(false)
    }
  }
  const openSave = () => {
    saveKey.current = 'ui:' + String(sessionId) + ':' + crypto.randomUUID()
    setContent('')
    setSaveError('')
    setSaveOpen(true)
  }
  return (
    <section className={styles.pane} aria-label={t('aria.pane')}>
      <header className={styles.paneHeader}>
        <div className={styles.titleRow}>
          <div>
            <h2 className={styles.title}>{t('pane.title')}</h2>
            <p className={styles.subtitle}>{t('pane.subtitle')}</p>
          </div>
          <Button
            variant="toolbar"
            size="sm"
            disabled={busy}
            onClick={onClose}
            aria-label={t('aria.closeMemory')}
          >
            {t('common.close')}
          </Button>
        </div>
        <nav className={styles.tabs} role="tablist" aria-label={t('aria.paneTabs')}>
          {PANE_TABS.map(([id, labelKey], index) => (
            <button
              id={'context-pane-tab-' + id}
              aria-controls={'context-pane-panel-' + id}
              key={id}
              role="tab"
              tabIndex={view === id ? 0 : -1}
              aria-selected={view === id}
              className={
                styles.tab + ' ' + (view === id ? styles.tabActive : '')
              }
              onClick={() => setView(id)}
              onKeyDown={(event) => {
                let next = index
                if (event.key === 'ArrowRight')
                  next = (index + 1) % PANE_TABS.length
                else if (event.key === 'ArrowLeft')
                  next = (index + PANE_TABS.length - 1) % PANE_TABS.length
                else if (event.key === 'Home') next = 0
                else if (event.key === 'End') next = PANE_TABS.length - 1
                else return
                event.preventDefault()
                const target = PANE_TABS[next]?.[0]
                if (!target) return
                setView(target)
                requestAnimationFrame(() =>
                  document
                    .getElementById('context-pane-tab-' + target)
                    ?.focus(),
                )
              }}
            >
              {t(labelKey)}{' '}
              {id === 'requested'
                ? requested.length
                : id === 'other'
                  ? other.length
                  : candidates.length}
            </button>
          ))}
        </nav>
      </header>
      <div
        id={'context-pane-panel-' + view}
        role="tabpanel"
        aria-labelledby={'context-pane-tab-' + view}
        className={styles.paneBody}
      >
        {!boot && !error && (
          <div className={styles.loading}>{t('pane.loading')}</div>
        )}
        {boot && (
          <div className={styles.between}>
            <span className={styles.meta}>{scope === undefined ? '' : t('pane.scope', { scope })}</span>
            <div className={styles.inline}>
              <span className={styles.meta}>{t('pane.pauseRecall')}</span>
              <Switch
                checked={policy?.paused ?? false}
                disabled={busy}
                label={t('pane.pauseRecall')}
                onChange={paused =>
                  void setPolicyValue({
                    scopeId: scope!,
                    sessionId: String(sessionId),
                    paused,
                  })
                }
              />
            </div>
          </div>
        )}
        {(view === 'requested' || view === 'other') && (
          <>
            {error && (
              <div className={styles.error} role="alert">
                <b>{t('pane.usageUnavailable')}</b>
                <div>{error}</div>
                <Button size="sm" variant="outline" onClick={() => void load()}>
                  {t('common.retry')}
                </Button>
              </div>
            )}
            {!error && boot && (
              <div className={styles.stack}>
                {(view === 'requested' ? requested : other).length === 0 ? (
                  <div className={styles.empty}>
                    {view === 'requested'
                      ? t('pane.empty.requested')
                      : t('pane.empty.other')}
                  </div>
                ) : (
                  (view === 'requested' ? requested : other).map(
                    ({ usage, m }, i) => (
                      <article
                        className={styles.usage}
                        key={usage.id + ':' + m.id + ':' + i}
                      >
                        <div className={styles.between}>
                          <div className={styles.badges}>
                            <Tag
                              tone={
                                usage.phase === 'requested'
                                  ? 'success'
                                  : usage.phase === 'failed'
                                    ? 'danger'
                                    : 'neutral'
                              }
                            >
                              {usageLabel[usage.phase]}
                            </Tag>
                            {m.truncated && <Tag tone="warning">{t('pane.truncated')}</Tag>}
                          </div>
                          <span className={styles.meta}>v{m.revision}</span>
                        </div>
                        <div className={styles.snapshot}>{m.content}</div>
                        <div className={styles.actions}>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy || !scope}
                            onClick={() =>
                              void setPolicyValue({
                                scopeId: scope!,
                                sessionId: String(sessionId),
                                memoryId: m.id,
                                mode: policy?.excludedIds.includes(m.id)
                                  ? 'normal'
                                  : 'exclude',
                              })
                            }
                          >
                            {policy?.excludedIds.includes(m.id)
                              ? t('pane.action.restoreCandidate')
                              : t('pane.action.skipNext')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy || !scope}
                            onClick={() =>
                              void setPolicyValue({
                                scopeId: scope!,
                                sessionId: String(sessionId),
                                memoryId: m.id,
                                mode: policy?.preferredIds.includes(m.id)
                                  ? 'normal'
                                  : 'prefer',
                              })
                            }
                          >
                            {policy?.preferredIds.includes(m.id)
                              ? t('pane.action.removePriority')
                              : t('pane.action.prioritize')}
                          </Button>
                        </div>
                      </article>
                    ),
                  )
                )}
              </div>
            )}
          </>
        )}
        {view === 'related' && (
          <div className={styles.stack}>
            {relatedError && (
              <div className={styles.error} role="alert">
                {t('pane.relatedUnavailable', { error: relatedError })}
                <Button size="sm" variant="outline" onClick={() => void load()}>
                  {t('common.retry')}
                </Button>
              </div>
            )}
            {!relatedError &&
              (candidates.length === 0 ? (
                <div className={styles.empty}>{t('pane.empty.related')}</div>
              ) : (
                candidates.map(m => (
                  <article className={styles.usage} key={m.id}>
                    <div className={styles.between}>
                      <div className={styles.badges}>
                        <Tag tone="neutral">{t('pane.savedNotCited')}</Tag>
                        <Tag tone="outline">{sourceLabel(m)}</Tag>
                      </div>
                      <span className={styles.meta}>v{m.revision}</span>
                    </div>
                    <div className={styles.snapshot}>{m.content}</div>
                    <p className={styles.meta}>
                      {t('pane.source', { kind: m.source.kind })} ·{' '}
                      {m.source.complete ? t('pane.source.complete') : t('pane.truncated')}
                    </p>
                    <div className={styles.actions}>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || !scope}
                        onClick={() =>
                          void setPolicyValue({
                            scopeId: scope!,
                            sessionId: String(sessionId),
                            memoryId: m.id,
                            mode: policy?.preferredIds.includes(m.id)
                              ? 'normal'
                              : 'prefer',
                          })
                        }
                      >
                        {policy?.preferredIds.includes(m.id)
                          ? t('pane.action.unprioritize')
                          : t('pane.action.prioritize')}
                      </Button>
                    </div>
                  </article>
                ))
              ))}
          </div>
        )}
      </div>
      <footer className={styles.paneFooter}>
        <div className={styles.actions}>
          <Button variant="outline" onClick={openSave}>
            {t('pane.action.remember')}
          </Button>
          <Button variant="primary" onClick={onManage}>
            {t('pane.action.manageAll')}
          </Button>
        </div>
        <p className={styles.hint}>
          {t('pane.hint.planning')}
        </p>
      </footer>
      <ContextModal
        open={saveOpen}
        onClose={() => !busy && setSaveOpen(false)}
        title={t('pane.action.remember')}
        description={t('pane.remember.description')}
        closeLabel={t('common.close')}
        footer={
          <div className={styles.actions}>
            <Button
              variant="ghost"
              onClick={() => setSaveOpen(false)}
              disabled={busy}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={busy || !content.trim()}
            >
              {busy ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        }
      >
        <div className={styles.modalContent}>
          <div className={styles.field}>
            <label htmlFor="context-pane-content">{t('pane.field.content')}</label>
            <textarea
              id="context-pane-content"
              value={content}
              onChange={e => setContent(e.currentTarget.value)}
              disabled={busy}
            />
          </div>
          {saveError && <p className={styles.errorText}>{saveError}</p>}
        </div>
      </ContextModal>
    </section>
  )
}
