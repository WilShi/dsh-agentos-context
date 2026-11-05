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
type PaneTab = 'requested' | 'other' | 'related'
const PANE_TABS: [PaneTab, string][] = [
  ['requested', '已进入请求'],
  ['other', '待处理记录'],
  ['related', '已存记忆'],
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
    <section className={styles.pane} aria-label="agentOS context 本轮记忆">
      <header className={styles.paneHeader}>
        <div className={styles.titleRow}>
          <div>
            <h2 className={styles.title}>本轮记忆</h2>
            <p className={styles.subtitle}>真实引用记录与本会话使用策略</p>
          </div>
          <Button
            variant="toolbar"
            size="sm"
            disabled={busy}
            onClick={onClose}
            aria-label="关闭记忆"
          >
            关闭
          </Button>
        </div>
        <nav className={styles.tabs} role="tablist" aria-label="本轮记忆分类">
          {PANE_TABS.map(([id, label], index) => (
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
              {label}{' '}
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
          <div className={styles.loading}>正在读取当前会话的记忆记录…</div>
        )}
        {boot && (
          <div className={styles.between}>
            <span className={styles.meta}>范围：{scope}</span>
            <div className={styles.inline}>
              <span className={styles.meta}>暂停后续召回</span>
              <Switch
                checked={policy?.paused ?? false}
                disabled={busy}
                label="暂停后续召回"
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
                <b>引用记录暂不可用</b>
                <div>{error}</div>
                <Button size="sm" variant="outline" onClick={() => void load()}>
                  重试
                </Button>
              </div>
            )}
            {!error && boot && (
              <div className={styles.stack}>
                {(view === 'requested' ? requested : other).length === 0 ? (
                  <div className={styles.empty}>
                    {view === 'requested'
                      ? '当前会话还没有已进入模型请求的记忆快照。'
                      : '当前没有计划中、已加入会话或失败的记忆记录。'}
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
                            {m.truncated && <Tag tone="warning">片段</Tag>}
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
                              ? '恢复候选'
                              : '下轮不用'}
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
                              ? '取消优先'
                              : '下轮优先'}
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
                已存记忆暂不可用：{relatedError}
                <Button size="sm" variant="outline" onClick={() => void load()}>
                  重试
                </Button>
              </div>
            )}
            {!relatedError &&
              (candidates.length === 0 ? (
                <div className={styles.empty}>没有其他当前有效记忆。</div>
              ) : (
                candidates.map(m => (
                  <article className={styles.usage} key={m.id}>
                    <div className={styles.between}>
                      <div className={styles.badges}>
                        <Tag tone="neutral">已保存 · 未引用</Tag>
                        <Tag tone="outline">{sourceLabel(m)}</Tag>
                      </div>
                      <span className={styles.meta}>v{m.revision}</span>
                    </div>
                    <div className={styles.snapshot}>{m.content}</div>
                    <p className={styles.meta}>
                      来源：{m.source.kind} ·{' '}
                      {m.source.complete ? '完整记录' : '片段'}
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
                          ? '取消下轮优先'
                          : '下轮优先'}
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
            记住一条
          </Button>
          <Button variant="primary" onClick={onManage}>
            管理全部记忆
          </Button>
        </div>
        <p className={styles.hint}>
          计划使用不代表已进入模型请求；暂停不会删除记忆或已发送上下文。
        </p>
      </footer>
      <ContextModal
        open={saveOpen}
        onClose={() => !busy && setSaveOpen(false)}
        title="记住一条"
        description="保存到当前会话范围；保存不等于事实已经证实。"
        closeLabel="关闭"
        footer={
          <div className={styles.actions}>
            <Button
              variant="ghost"
              onClick={() => setSaveOpen(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => void save()}
              disabled={busy || !content.trim()}
            >
              {busy ? '保存中…' : '保存'}
            </Button>
          </div>
        }
      >
        <div className={styles.modalContent}>
          <div className={styles.field}>
            <label htmlFor="context-pane-content">内容</label>
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
