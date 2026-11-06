import { useEffect, useMemo, useState } from 'react'
import { Button, Tag } from './ui-primitives.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextApi } from './context-api.ts'
import type {
  ContextMemory,
  ContextWarningDetail,
  MemoryLayer,
} from './context-types.ts'
import { ContextGraph } from './ContextGraph.tsx'
import { ContextReview } from './ContextReview.tsx'
import { ContextSettings } from './ContextSettings.tsx'
import { ContextKnowledge } from './ContextKnowledge.tsx'
import {
  epistemicLabel,
  formatScopeLabel,
  formatTime,
  memoryKindLabel,
  memoryLayerLabel,
  plainError,
  sourceLabel,
  useLoad,
  useLiveContextRefresh,
  useMutationGuard,
} from './context-ui-helpers.tsx'
import { ContextModal } from './ContextModal.tsx'
import { ALL_SCOPES_ID, withAllScopes } from './context-all-scopes.ts'
import styles from './Context.module.css'
import responsive from './ContextResponsive.module.css'
import { t, type AgentosContextLocaleKey, type AgentosT } from './i18n.ts'
type Tab = 'memories' | 'knowledge' | 'graph' | 'review' | 'settings'
type LifecycleFilter = 'all' | 'active' | 'candidate' | 'expired' | 'retired'
const MEMORY_LAYERS: MemoryLayer[] = [
  'working',
  'episodic',
  'semantic',
  'procedural',
]
const GLOBAL_SCOPE_ID = 'dsh-default'
const changeLabel = (action: string) => ({
  'memory.save': t('workbench.change.save'),
  'memory.revise': t('workbench.change.revise'),
  'memory.transition': t('workbench.change.transition'),
  'memory.reinforce': t('workbench.change.reinforce'),
  'memory.expire': t('workbench.change.expire'),
  'memory.retire': t('workbench.change.retire'),
}[action] ?? t('workbench.change.generic'))
const toLocalDateTime = (value: number | null | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  const date = new Date(value)
  return new Date(value - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
}
const WORKBENCH_TABS: [Tab, AgentosContextLocaleKey][] = [
  ['memories', 'nav'],
  ['knowledge', 'workbench.tab.knowledge'],
  ['graph', 'memoryView.tab.graph'],
  ['review', 'workbench.tab.review'],
  ['settings', 'workbench.tab.settings'],
]

/** Host warning code -> locale key; unknown codes keep the host message. */
const WARNING_KEYS: Record<string, AgentosContextLocaleKey> = {
  LEGACY_READ_FAILED: 'warning.legacyReadFailed',
  LEGACY_PAGING_UNSUPPORTED: 'warning.legacyPagingUnsupported',
  LEGACY_SCAN_TRUNCATED: 'warning.legacyScanTruncated',
}

function warningCopy(
  t: AgentosT,
  warnings: string[],
  details: ContextWarningDetail[] | undefined,
): { key: string; text: string }[] {
  // Prefer structured host diagnostics; fall back to the legacy plain strings
  // when an older host does not send warningDetails.
  if (details !== undefined && details.length > 0) {
    return details.map((detail, index) => {
      const localeKey = WARNING_KEYS[detail.code]
      return {
        key: 'warning:' + index,
        text: localeKey === undefined ? detail.message : t(localeKey, detail.params),
      }
    })
  }
  return warnings.map((text, index) => ({ key: 'warning:' + index, text }))
}
function MemoryManager({
  api,
  scopeId,
  writeScopeId,
  allowEntityEditing = true,
}: {
  api: ContextApi
  scopeId: string
  writeScopeId: string
  allowEntityEditing?: boolean
}) {
  // M5: bind the guard to the write scope. Switching scope aborts in-flight
  // writes so a response can never land on the newly selected scope.
  const runMutation = useMutationGuard(writeScopeId)
  const [query, setQuery] = useState(''),
    [lifecycle, setLifecycle] = useState<LifecycleFilter>('all'),
    [layerFilter, setLayerFilter] = useState<'all' | MemoryLayer>('all'),
    [mode, setMode] = useState<'memories' | 'entities'>('memories'),
    [selected, setSelected] = useState<ContextMemory | null>(null),
    [editor, setEditor] = useState<
      | 'save'
      | 'revise'
      | 'transition'
      | 'retire'
      | 'entity'
      | 'relation'
      | 'merge'
      | null
    >(null),
    [content, setContent] = useState(''),
    [reason, setReason] = useState(''),
    [kind, setKind] = useState('note'),
    [layer, setLayer] = useState<MemoryLayer>('semantic'),
    [importance, setImportance] = useState('0.7'),
    [expiresAt, setExpiresAt] = useState(''),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState(''),
    [notice, setNotice] = useState(''),
    [entityType, setEntityType] = useState(''),
    [aliases, setAliases] = useState(''),
    [subject, setSubject] = useState(''),
    [object, setObject] = useState(''),
    [predicate, setPredicate] = useState(''),
    [quote, setQuote] = useState(''),
    [sourceMemoryId, setSourceMemoryId] = useState(''),
    [mergeId, setMergeId] = useState('')
  const memories = useLoad(
    api,
    'mem:' + scopeId + ':' + query + ':' + lifecycle + ':' + layerFilter,
    async (s) => {
      const options = {
        query,
        ...(layerFilter === 'all' ? {} : { layer: layerFilter }),
        limit: 500,
      }
      const load = (state: 'active' | 'candidate' | 'retired') =>
        api.memories(scopeId, { ...options, lifecycle: state }, s)
      if (lifecycle === 'active' || lifecycle === 'candidate') return load(lifecycle)
      const now = Date.now()
      if (lifecycle === 'expired')
        return (await load('retired')).filter(row => row.expiresAt !== null && row.expiresAt <= now)
      if (lifecycle === 'retired')
        return (await load('retired')).filter(row => row.expiresAt === null || row.expiresAt > now)
      const rows = (await Promise.all([load('active'), load('candidate'), load('retired')])).flat()
      return [...new Map(rows.map(row => [`${row.scopeId}\0${row.id}`, row])).values()]
        .sort((left, right) => (right.recordedAt ?? 0) - (left.recordedAt ?? 0))
    },
  )
  const entities = useLoad(api, 'ent:' + scopeId + ':' + query, s =>
    api.entities(scopeId, query || undefined, s),
  )
  const versions = useLoad(
    api,
    'versions:' + (selected?.scopeId ?? scopeId) + ':' + (selected?.id ?? 'none'),
    s =>
      selected
        ? api.versions(selected.scopeId, selected.id, s)
        : Promise.resolve([]),
  )
  const schema = useLoad(api, 'schema-relations', s => api.schema(s))
  useEffect(() => {
    if (
      selected &&
      !memories.data?.some(
        x => x.id === selected.id && x.scopeId === selected.scopeId,
      )
    )
      setSelected(null)
  }, [memories.data, selected])
  useEffect(() => {
    const types = schema.data?.types ?? []
    if (!types.some(type => type.id === entityType))
      setEntityType(types[0]?.id ?? '')
    const relations = schema.data?.relations ?? []
    if (!relations.some(relation => relation.id === predicate))
      setPredicate(relations[0]?.id ?? '')
  }, [schema.data, entityType, predicate])
  const resetForm = () => {
    setContent('')
    setReason('')
    setKind('note')
    setLayer('semantic')
    setImportance('0.7')
    setExpiresAt('')
    setFormError('')
    setAliases('')
    setQuote('')
    setSourceMemoryId('')
    setMergeId('')
  }
  const open = (type: typeof editor) => {
    resetForm()
    if ((type === 'revise' || type === 'transition') && selected) {
      setContent(selected.content)
      setKind(selected.kind)
      setLayer(selected.layer ?? 'semantic')
      setImportance(String(selected.importance ?? 0.5))
      setExpiresAt(toLocalDateTime(selected.expiresAt))
    }
    setEditor(type)
  }
  const perform = async () => {
    if (!editor || busy) return
    setBusy(true)
    setFormError('')
    try {
      const parsedImportance = Number(importance)
      const parsedExpiry = expiresAt ? Date.parse(expiresAt) : undefined
      const placement = {
        layer,
        importance: parsedImportance,
        ...(parsedExpiry === undefined ? {} : { expiresAt: parsedExpiry }),
      }
      await runMutation(async (signal) => {
        if (editor === 'save')
          await api.saveMemory(
            {
              scopeId: writeScopeId,
              content: content.trim(),
              kind: kind as any,
              ...placement,
              idempotencyKey: 'ui:' + crypto.randomUUID(),
            },
            signal,
          )
        if (editor === 'revise' && selected)
          await api.reviseMemory(
            {
              scopeId: selected.scopeId,
              id: selected.id,
              expectedRevision: selected.revision,
              content: content.trim(),
              kind: kind as any,
              ...placement,
              reason: reason.trim(),
            },
            signal,
          )
        if (editor === 'transition' && selected)
          await api.transitionMemory(
            {
              scopeId: selected.scopeId,
              id: selected.id,
              expectedRevision: selected.revision,
              ...placement,
              reason: reason.trim(),
            },
            signal,
          )
        if (editor === 'retire' && selected)
          await api.retireMemory(
            {
              scopeId: selected.scopeId,
              id: selected.id,
              expectedRevision: selected.revision,
              reason: reason.trim(),
            },
            signal,
          )
        if (editor === 'entity')
          await api.createEntity(
            {
              scopeId: writeScopeId,
              name: content.trim(),
              type: entityType,
              aliases: aliases
                .split(/[，,]/)
                .map(x => x.trim())
                .filter(Boolean),
            },
            signal,
          )
        if (editor === 'relation')
          await api.createRelation(
            {
              scopeId: writeScopeId,
              subjectId: subject,
              predicate,
              objectId: object,
              sourceMemoryId,
              quote: quote.trim(),
            },
            signal,
          )
        if (editor === 'merge') {
          const keep = entities.data?.find(x => x.id === subject),
            merge = entities.data?.find(x => x.id === mergeId)
          if (!keep || !merge) throw new Error(t('workbench.error.chooseTwoEntities'))
          await api.mergeEntities(
            {
              scopeId: writeScopeId,
              keepId: keep.id,
              mergeId: merge.id,
              keepRevision: keep.revision,
              mergeRevision: merge.revision,
              reason: reason.trim(),
            },
            signal,
          )
        }
      })
      setNotice(
        editor === 'relation'
          ? t('workbench.notice.relationPending')
          : t('workbench.notice.saved'),
      )
      setEditor(null)
      setSelected(null)
      memories.reload()
      entities.reload()
      resetForm()
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setFormError(plainError(e))
    } finally {
      setBusy(false)
    }
  }
  const copySelectedToGlobal = async () => {
    if (!selected || busy || selected.scopeId === GLOBAL_SCOPE_ID) return
    setBusy(true)
    setFormError('')
    try {
      await runMutation(signal =>
        api.saveMemory(
          {
            scopeId: GLOBAL_SCOPE_ID,
            content: selected.content,
            kind: selected.kind,
            layer: selected.layer === 'procedural' ? 'procedural' : 'semantic',
            importance: Math.max(0.7, selected.importance ?? 0.7),
            expiresAt: null,
            metadata: {
              promotedFromScope: selected.scopeId,
              promotedFromMemoryId: selected.id,
            },
            idempotencyKey: `ui-global:${selected.scopeId}:${selected.id}:${selected.revision}`,
          },
          signal,
        ),
      )
      setNotice(t('workbench.notice.copiedToGlobal'))
    } catch (error) {
      if ((error as Error).name !== 'AbortError') setFormError(plainError(error))
    } finally {
      setBusy(false)
    }
  }
  const title = {
    save: t('pane.action.remember'),
    revise: t('workbench.change.revise'),
    transition: t('workbench.editor.transition'),
    retire: t('workbench.change.retire'),
    entity: t('workbench.editor.entity'),
    relation: t('workbench.editor.relation'),
    merge: t('workbench.editor.merge'),
  }[editor ?? 'save']
  const importanceValue = Number(importance)
  const placementValid =
    importance.trim() !== '' &&
    Number.isFinite(importanceValue) &&
    importanceValue >= 0 &&
    importanceValue <= 1 &&
    (!expiresAt || Number.isFinite(Date.parse(expiresAt)))
  const canSubmit =
    editor === 'retire'
      ? !!reason.trim()
      : editor === 'revise'
        ? !!reason.trim() && !!content.trim() && placementValid
        : editor === 'transition'
          ? !!reason.trim() && placementValid
          : editor === 'relation'
            ? !!subject && !!object && !!sourceMemoryId && !!quote.trim()
            : editor === 'merge'
              ? !!subject && !!mergeId && subject !== mergeId && !!reason.trim()
              : editor === 'entity'
                ? !!content.trim() && !!entityType
                : editor === 'save'
                  ? !!content.trim() && placementValid
                  : !!content.trim()
  return (
    <div className={styles.stack}>
      {notice && (
        <div className={styles.notice} role="status">
          {notice}
        </div>
      )}
      <div className={styles.toolbar}>
        <input
          aria-label={t('aria.searchMemoryOrEntity')}
          value={query}
          onChange={e => setQuery(e.currentTarget.value)}
          placeholder={t('aria.searchMemoryOrEntity')}
        />
        <select
          aria-label={t('aria.lifecycleFilter')}
          value={lifecycle}
          onChange={e => setLifecycle(e.currentTarget.value as LifecycleFilter)}
          disabled={mode === 'entities'}
        >
          <option value="all">{t('workbench.filter.allStates')}</option>
          <option value="active">{t('workbench.filter.active')}</option>
          <option value="candidate">{t('workbench.filter.candidate')}</option>
          <option value="expired">{t('workbench.filter.expired')}</option>
          <option value="retired">{t('workbench.filter.retired')}</option>
        </select>
        <select
          aria-label={t('aria.layerFilter')}
          value={layerFilter}
          onChange={e =>
            setLayerFilter(e.currentTarget.value as 'all' | MemoryLayer)
          }
          disabled={mode === 'entities'}
        >
          <option value="all">{t('workbench.filter.allLayers')}</option>
          {MEMORY_LAYERS.map(value => (
            <option value={value} key={value}>
              {t('workbench.layerMemory', { layer: memoryLayerLabel[value] })}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant={mode === 'memories' ? 'primary' : 'outline'}
          onClick={() => setMode('memories')}
        >
          {t('nav')}
        </Button>
        {allowEntityEditing && (
          <Button
            size="sm"
            variant={mode === 'entities' ? 'primary' : 'outline'}
            onClick={() => setMode('entities')}
          >
            {t('workbench.mode.entities')}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => open(mode === 'memories' ? 'save' : 'entity')}
        >
          {mode === 'memories' ? (writeScopeId === GLOBAL_SCOPE_ID ? t('workbench.action.rememberGlobal') : t('pane.action.remember')) : t('workbench.editor.entity')}
        </Button>
        {mode === 'entities' && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => open('relation')}
            >
              {t('workbench.editor.relation')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => open('merge')}>
              {t('workbench.action.mergeAliases')}
            </Button>
          </>
        )}
      </div>
      {mode === 'memories' ? (
        <div className={styles.memoryLayout}>
          <section className={styles.memoryList} aria-label={t('aria.memoryList')}>
            {memories.phase === 'loading' && !memories.data ? (
              <div className={styles.loading}>{t('workbench.loading.memories')}</div>
            ) : memories.error && !memories.data ? (
              <div className={styles.error} role="alert">
                {memories.error}
                <Button onClick={memories.reload}>{t('common.retry')}</Button>
              </div>
            ) : !memories.data?.length ? (
              <div className={styles.empty}>{t('workbench.empty.memories')}</div>
            ) : (
              memories.data.map(m => (
                <button
                  key={m.scopeId + ':' + m.id}
                  className={styles.memoryCard}
                  onClick={() => setSelected(m)}
                >
                  <div className={styles.memoryText}>{m.content}</div>
                  <div className={styles.badges}>
                    <Tag tone="neutral">
                      {memoryKindLabel[m.kind] ?? m.kind}
                    </Tag>
                    <Tag tone={m.layer === 'working' ? 'warning' : 'info'}>
                      {t('workbench.layerMemory', { layer: memoryLayerLabel[m.layer ?? 'semantic'] })}
                    </Tag>
                    <Tag tone="outline">
                      {t('workbench.importance', { percent: Math.round((m.importance ?? 0.5) * 100) })}
                    </Tag>
                    <Tag
                      tone={
                        m.epistemic === 'supported'
                          ? 'success'
                          : m.epistemic === 'contested'
                            ? 'warning'
                            : 'outline'
                      }
                    >
                      {epistemicLabel[m.epistemic] ?? m.epistemic}
                    </Tag>
                    {m.legacy && <Tag tone="info">{t('memoryView.detail.legacy')}</Tag>}
                    <Tag tone={m.lifecycle === 'active' ? 'success' : m.lifecycle === 'candidate' ? 'warning' : 'neutral'}>
                      {m.lifecycle === 'active' ? t('workbench.lifecycle.active') : m.lifecycle === 'candidate' ? t('workbench.filter.candidate') : m.expiresAt !== null && m.expiresAt <= Date.now() ? t('workbench.filter.expired') : t('workbench.filter.retired')}
                    </Tag>
                    <Tag tone="outline">{m.source.actorRole === 'assistant' ? t('memoryView.capture.autoDistilled') : m.source.actorRole === 'human' ? t('workbench.source.userContent') : sourceLabel(m)}</Tag>
                    <span className={styles.meta}>
                      {formatTime(m.recordedAt)}
                    </span>
                  </div>
                </button>
              ))
            )}
          </section>
          {selected && !editor && (
            <aside className={styles.panel + ' ' + styles.detailDialog} role="dialog" aria-modal="true" aria-label={t('memoryView.detail.title')}>
              <div className={styles.stack}>
                <div className={styles.between}>
                  <h3 className={styles.sectionTitle}>{t('memoryView.detail.title')}</h3>
                  <div className={styles.actions}>
                    <Tag tone={selected.lifecycle === 'retired' ? 'neutral' : 'info'}>v{selected.revision}</Tag>
                    <Button size="sm" variant="ghost" onClick={() => setSelected(null)} aria-label={t('aria.closeMemoryDetail')}>{t('common.close')}</Button>
                  </div>
                </div>
                <p>{selected.content}</p>
                <div>
                  <div className={styles.meta}>
                    {sourceLabel(selected)} · {selected.source.kind}
                  </div>
                  <p className={styles.source}>{selected.source.content}</p>
                </div>
                <div className={styles.meta}>
                  ID：{selected.id}
                  <br />
                  {t('workbench.detail.scope', { scope: formatScopeLabel(selected.scopeId, selected.scopeId) })}
                  <br />
                  {t('workbench.detail.layer', { layer: memoryLayerLabel[selected.layer ?? 'semantic'] })}
                  {t('workbench.detail.importance', { percent: Math.round((selected.importance ?? 0.5) * 100) })}
                  <br />
                  {t('workbench.detail.expires')}
                  {selected.expiresAt === null
                    ? t('workbench.detail.longTerm')
                    : formatTime(selected.expiresAt)}
                  <br />
                  {t('workbench.detail.effective')}
                  {selected.validFrom === null
                    ? t('common.unknown')
                    : formatTime(selected.validFrom)}
                </div>
                <div className={styles.actions}>
                  {selected.scopeId !== GLOBAL_SCOPE_ID && selected.lifecycle !== 'retired' && (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy}
                      onClick={() => void copySelectedToGlobal()}
                    >
                      {t('workbench.action.copyToGlobal')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => open('revise')}
                  >
                    {t('workbench.action.revise')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={selected.lifecycle === 'retired'}
                    onClick={() => open('transition')}
                  >
                    {t('workbench.action.transitionLayer')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={selected.lifecycle === 'retired'}
                    onClick={() => open('retire')}
                  >
                    {t('workbench.change.retire')}
                  </Button>
                </div>
                <div>
                  <h3 className={styles.sectionTitle}>{t('memoryView.detail.version')}</h3>
                  {versions.phase === 'loading' && (
                    <div className={styles.loading}>{t('workbench.loading.versions')}</div>
                  )}
                  {versions.error && (
                    <div className={styles.error} role="alert">
                      {t('workbench.versionsUnavailable', { error: versions.error })}
                      <Button onClick={versions.reload}>{t('common.retry')}</Button>
                    </div>
                  )}
                  {versions.data?.map(v => (
                    <div className={styles.usage} key={v.revision}>
                      <b>v{v.revision}</b> · {formatTime(v.recordedAt)}
                      <div className={styles.snapshot}>{v.content}</div>
                      <div className={styles.meta}>
                        {t('workbench.versionLine', { layer: memoryLayerLabel[v.layer ?? 'semantic'] })}
                        {Math.round((v.importance ?? 0.5) * 100)}% · {sourceLabel(v)} · {v.source.kind}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </aside>
          )}
        </div>
      ) : (
        <div className={styles.list}>
          {entities.phase === 'loading' && !entities.data ? (
            <div className={styles.loading}>{t('workbench.loading.entities')}</div>
          ) : entities.error ? (
            <div className={styles.error} role="alert">
              {entities.error}
              <Button onClick={entities.reload}>{t('common.retry')}</Button>
            </div>
          ) : !entities.data?.length ? (
            <div className={styles.empty}>
              {t('workbench.empty.entities')}
            </div>
          ) : (
            entities.data.map(e => (
              <div key={e.id} className={styles.item}>
                <div className={styles.between}>
                  <div>
                    <div className={styles.itemTitle}>{e.name}</div>
                    <div className={styles.badges}>
                      <Tag tone="neutral">{e.type}</Tag>
                      {e.aliases.map(a => (
                        <Tag tone="outline" key={a}>
                          {a}
                        </Tag>
                      ))}
                    </div>
                  </div>
                  <span className={styles.meta}>v{e.revision}</span>
                </div>
              </div>
            ))
          )}
        </div>
      )}
      <ContextModal
        open={!!editor}
        onClose={() => !busy && setEditor(null)}
        title={title}
        description={
          editor === 'relation'
            ? t('workbench.hint.relation')
            : editor === 'merge'
              ? t('workbench.hint.merge')
              : t('workbench.hint.revise')
        }
        closeLabel={t('common.close')}
        footer={
          <div className={styles.actions}>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setEditor(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={busy || !canSubmit}
              onClick={() => void perform()}
            >
              {busy ? t('common.saving') : t('common.confirm')}
            </Button>
          </div>
        }
      >
        <div className={styles.modalContent + ' ' + styles.form}>
          {(editor === 'save' || editor === 'revise') && (
            <>
              <div className={styles.field}>
                <label>{t('workbench.field.type')}</label>
                <select
                  value={kind}
                  onChange={e => setKind(e.currentTarget.value)}
                >
                  {Object.entries(memoryKindLabel).map(([v, l]) => (
                    <option value={v} key={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label>{t('pane.field.content')}</label>
                <textarea
                  value={content}
                  onChange={e => setContent(e.currentTarget.value)}
                />
              </div>
            </>
          )}
          {(editor === 'save' ||
            editor === 'revise' ||
            editor === 'transition') && (
            <>
              <div className={styles.field}>
                <label>{t('workbench.field.layer')}</label>
                <select
                  aria-label={t('workbench.field.layer')}
                  value={layer}
                  onChange={(e) => {
                    setLayer(e.currentTarget.value as MemoryLayer)
                    setExpiresAt('')
                  }}
                >
                  {MEMORY_LAYERS.map(value => (
                    <option value={value} key={value}>
                      {t('workbench.layerMemory', { layer: memoryLayerLabel[value] })}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label htmlFor="context-memory-importance">
                  {t('workbench.field.importance')}
                </label>
                <input
                  id="context-memory-importance"
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={importance}
                  onChange={e => setImportance(e.currentTarget.value)}
                />
              </div>
              <div className={styles.field}>
                <label htmlFor="context-memory-expires">{t('workbench.field.expiresAt')}</label>
                <input
                  id="context-memory-expires"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={e => setExpiresAt(e.currentTarget.value)}
                />
                <span className={styles.hint}>
                  {t('workbench.field.expiresHint')}
                </span>
              </div>
            </>
          )}
          {editor === 'entity' && (
            <>
              <div className={styles.field}>
                <label>{t('workbench.field.entityType')}</label>
                <select
                  value={entityType}
                  onChange={e => setEntityType(e.currentTarget.value)}
                >
                  {schema.data?.types.map(t => (
                    <option value={t.id} key={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label>{t('workbench.field.name')}</label>
                <input
                  value={content}
                  onChange={e => setContent(e.currentTarget.value)}
                />
              </div>
              <div className={styles.field}>
                <label>{t('workbench.field.aliases')}</label>
                <input
                  value={aliases}
                  onChange={e => setAliases(e.currentTarget.value)}
                />
              </div>
            </>
          )}
          {editor === 'relation' && (
            <>
              <div className={styles.field}>
                <label>{t('workbench.field.subject')}</label>
                <select
                  value={subject}
                  onChange={e => setSubject(e.currentTarget.value)}
                >
                  <option value="">{t('workbench.field.choose')}</option>
                  {entities.data?.map(e => (
                    <option value={e.id} key={e.id}>
                      {e.name} · {e.type}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label>{t('workbench.field.relation')}</label>
                <select
                  value={predicate}
                  onChange={e => setPredicate(e.currentTarget.value)}
                >
                  {schema.data?.relations.map(r => (
                    <option value={r.id} key={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label>{t('workbench.field.object')}</label>
                <select
                  value={object}
                  onChange={e => setObject(e.currentTarget.value)}
                >
                  <option value="">{t('workbench.field.choose')}</option>
                  {entities.data?.map(e => (
                    <option value={e.id} key={e.id}>
                      {e.name} · {e.type}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label>{t('workbench.field.sourceMemory')}</label>
                <select
                  value={sourceMemoryId}
                  onChange={e => setSourceMemoryId(e.currentTarget.value)}
                >
                  <option value="">{t('workbench.field.choose')}</option>
                  {memories.data?.map(m => (
                    <option value={m.id} key={m.id}>
                      {m.content.slice(0, 60)}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label>{t('workbench.field.quote')}</label>
                <textarea
                  value={quote}
                  onChange={e => setQuote(e.currentTarget.value)}
                  placeholder={t('workbench.field.quotePlaceholder')}
                />
              </div>
            </>
          )}
          {editor === 'merge' && (
            <>
              <div className={styles.field}>
                <label>{t('workbench.field.keepEntity')}</label>
                <select
                  value={subject}
                  onChange={e => setSubject(e.currentTarget.value)}
                >
                  <option value="">{t('workbench.field.choose')}</option>
                  {entities.data?.map(e => (
                    <option value={e.id} key={e.id}>
                      {e.name} · {e.type}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label>{t('workbench.field.mergeEntity')}</label>
                <select
                  value={mergeId}
                  onChange={e => setMergeId(e.currentTarget.value)}
                >
                  <option value="">{t('workbench.field.choose')}</option>
                  {entities.data?.map(e => (
                    <option value={e.id} key={e.id}>
                      {e.name} · {e.type}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
          {['revise', 'transition', 'retire', 'merge'].includes(
            editor ?? '',
          ) && (
            <div className={styles.field}>
              <label>{t('workbench.field.reason')}</label>
              <textarea
                value={reason}
                onChange={e => setReason(e.currentTarget.value)}
              />
            </div>
          )}
          {formError && (
            <p className={styles.errorText} role="alert">
              {formError}
            </p>
          )}
        </div>
      </ContextModal>
    </div>
  )
}
export interface ContextWorkbenchProps {
  api: ContextApi
  sessionId?: SessionId
  onClose: () => void
  surface?: 'settings' | 'conversation'
}
export function ContextWorkbench({
  api,
  sessionId,
  onClose,
  surface = 'settings',
}: ContextWorkbenchProps) {
  const boot = useLoad(api, 'bootstrap:' + String(sessionId ?? ''), s =>
    api.bootstrap(sessionId ? String(sessionId) : undefined, s),
  )
  const [scopeId, setScopeId] = useState(''),
    [tab, setTab] = useState<Tab>('memories')
  const orderedScopes = useMemo(
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
      count: orderedScopes.reduce((total, item) => total + item.count, 0),
      knowledgeCount: orderedScopes.reduce((total, item) => total + (item.knowledgeCount ?? 0), 0),
    }),
    [orderedScopes],
  )
  const displayedScopes = useMemo(
    () => [allScope, ...orderedScopes],
    [allScope, orderedScopes],
  )
  const scopedApi = useMemo(
    () => withAllScopes(api, orderedScopes.map(item => item.id)),
    [api, orderedScopes],
  )
  const activity = useLoad(scopedApi, 'activity:' + scopeId, signal =>
    scopeId ? scopedApi.changes(scopeId, signal) : Promise.resolve([]),
  )
  const latestMemoryChange = activity.data?.find(row => row.action.startsWith('memory.'))
  const writeScopeId =
    boot.data?.sessionScope ??
    boot.data?.defaultScope ??
    orderedScopes[0]?.id ??
    ''
  const knowledgeScopeId =
    scopeId === ALL_SCOPES_ID
      ? ALL_SCOPES_ID
      : (boot.data?.globalScope ?? scopeId)
  const knowledgeWriteScopeId = boot.data?.globalScope ?? writeScopeId
  useEffect(() => {
    setScopeId('')
    setTab('memories')
  }, [sessionId])
  useEffect(() => {
    if (
      boot.data &&
      (!scopeId ||
        (scopeId !== ALL_SCOPES_ID &&
          !boot.data.scopes.some(s => s.id === scopeId)))
    ) {
      setScopeId(ALL_SCOPES_ID)
    }
  }, [boot.data, orderedScopes, scopeId])
  useLiveContextRefresh(scopedApi, scopeId)
  const selectedScope = displayedScopes.find(scope => scope.id === scopeId)
  const sessionScope = boot.data?.sessionScope
    ? orderedScopes.find(scope => scope.id === boot.data?.sessionScope)
    : undefined
  return (
    <section
      className={`${styles.root} ${responsive.root} ${surface === 'conversation' ? styles.conversationSurface : ''}`}
      aria-label={t('aria.workbench')}
      data-context-surface={surface}
    >
      <header className={styles.header}>
        <div className={styles.titleRow + ' ' + responsive.headerRow}>
          <div>
            <h1 className={styles.title + ' ' + responsive.title}>{t('nav')}</h1>
            <p className={styles.subtitle}>{t('workbench.subtitle')}</p>
          </div>
          <div className={styles.actions + ' ' + responsive.headerActions}>
            {orderedScopes.length ? (
              <select
                className={styles.scope + ' ' + responsive.scope}
                aria-label={t('aria.memoryScope')}
                value={scopeId}
                onChange={e => setScopeId(e.currentTarget.value)}
              >
                {displayedScopes.map(s => (
                  <option value={s.id} key={s.id}>
                    {t('workbench.scopeOption', { scope: formatScopeLabel(s.id, s.label), count: s.count, knowledge: s.knowledgeCount ? t('workbench.scopeKnowledge', { count: s.knowledgeCount }) : '' })}
                  </option>
                ))}
              </select>
            ) : null}
            <Button variant="toolbar" size="sm" onClick={onClose}>
              {surface === 'conversation' ? t('memoryView.backToChat') : t('common.close')}
            </Button>
          </div>
        </div>
        {selectedScope && (
          <div className={styles.scopeSummary}>
            <div className={styles.memoryActivity} aria-label={t('aria.autoMemoryStatus')}>
              <span className={boot.data?.features.capture ? styles.activityDotOn : styles.activityDotOff}/>
              <b>{boot.data?.features.capture ? t('workbench.captureOn') : t('workbench.captureOff')}</b>
              {latestMemoryChange
                ? <span>{t('workbench.recentChange', { label: changeLabel(latestMemoryChange.action), time: formatTime(latestMemoryChange.at) })}</span>
                : <span>{t('workbench.noRecentChange')}</span>}
            </div>
            <span>
              {t('workbench.viewingScope', { scope: formatScopeLabel(selectedScope.id, selectedScope.label), count: selectedScope.count })}
            </span>
            <span>
              {selectedScope.id === ALL_SCOPES_ID
                ? t('workbench.summary.allScopes')
                : selectedScope.id === boot.data?.globalScope
                  ? t('workbench.summary.globalScope')
                  : (boot.data?.recallOrder?.length ?? (boot.data?.globalScope ? 2 : 1)) > 1
                    ? (boot.data?.recallOrder ? t('workbench.summary.recallOrder') : t('workbench.summary.recallBoth'))
                    : t('workbench.summary.singleScope')}
            </span>
            {sessionScope && sessionScope.id !== selectedScope.id && (
              <button type="button" className={styles.scopeAction} onClick={() => setScopeId(sessionScope.id)}>
                {t('workbench.switchToSessionScope', { count: sessionScope.count })}
              </button>
            )}
          </div>
        )}
        <nav className={styles.tabs} role="tablist">
          {WORKBENCH_TABS.map(([id, labelKey], index) => (
            <button
              id={'agentos-context-tab-' + id}
              aria-controls={'agentos-context-panel-' + id}
              key={id}
              role="tab"
              tabIndex={tab === id ? 0 : -1}
              aria-selected={tab === id}
              className={
                styles.tab + ' ' + (tab === id ? styles.tabActive : '')
              }
              onClick={() => setTab(id)}
              onKeyDown={(event) => {
                let next = index
                if (event.key === 'ArrowRight')
                  next = (index + 1) % WORKBENCH_TABS.length
                else if (event.key === 'ArrowLeft')
                  next =
                    (index + WORKBENCH_TABS.length - 1) % WORKBENCH_TABS.length
                else if (event.key === 'Home') next = 0
                else if (event.key === 'End') next = WORKBENCH_TABS.length - 1
                else return
                event.preventDefault()
                const target = WORKBENCH_TABS[next]?.[0]
                if (!target) return
                setTab(target)
                requestAnimationFrame(() =>
                  document
                    .getElementById('agentos-context-tab-' + target)
                    ?.focus(),
                )
              }}
            >
              {t(labelKey)}
            </button>
          ))}
        </nav>
      </header>
      <main
        id={'agentos-context-panel-' + tab}
        role="tabpanel"
        aria-labelledby={'agentos-context-tab-' + tab}
        className={styles.body}
      >
        {boot.phase === 'loading' && !boot.data ? (
          <div className={styles.loading}>{t('workbench.loading.root')}</div>
        ) : boot.error && !boot.data ? (
          <div className={styles.error} role="alert">
            {boot.error}
            <Button onClick={boot.reload}>{t('common.retry')}</Button>
          </div>
        ) : !boot.data || !scopeId ? (
          <div className={styles.empty}>{t('workbench.empty.scopes')}</div>
        ) : (
          <>
            {warningCopy(t, boot.data.warnings, boot.data.warningDetails).map(item => (
              <div className={styles.notice} key={item.key}>
                {item.text}
              </div>
            ))}
            {tab === 'memories' && (
              <MemoryManager
                key={'memory:' + scopeId}
                api={scopedApi}
                scopeId={scopeId}
                writeScopeId={writeScopeId}
                allowEntityEditing={scopeId !== ALL_SCOPES_ID || orderedScopes.length === 1}
              />
            )}{' '}
            {tab === 'knowledge' && (
              <ContextKnowledge
                key={'knowledge:' + knowledgeScopeId}
                api={scopedApi}
                scopeId={knowledgeScopeId}
                writeScopeId={knowledgeWriteScopeId}
              />
            )}{' '}
            {tab === 'graph' && (
              <ContextGraph
                key={'graph:' + scopeId}
                api={scopedApi}
                scopeId={scopeId}
              />
            )}{' '}
            {tab === 'review' && (
              <ContextReview
                key={'review:' + scopeId}
                api={scopedApi}
                scopeId={scopeId}
              />
            )}{' '}
            {tab === 'settings' && (
              <ContextSettings
                key={'settings:' + scopeId}
                api={api}
                scopeId={scopeId === ALL_SCOPES_ID ? writeScopeId : scopeId}
                bootstrap={boot.data}
              />
            )}
          </>
        )}
      </main>
    </section>
  )
}
