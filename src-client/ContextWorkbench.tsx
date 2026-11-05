import { useEffect, useMemo, useState } from 'react'
import { Button, Tag } from './ui-primitives.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextApi } from './context-api.ts'
import type {
  ContextMemory,
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
  'memory.save': '新增记忆',
  'memory.revise': '修订记忆',
  'memory.transition': '调整层级',
  'memory.reinforce': '强化记忆',
  'memory.expire': '记忆到期',
  'memory.retire': '停止召回',
}[action] ?? '记忆已更新')
const toLocalDateTime = (value: number | null | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  const date = new Date(value)
  return new Date(value - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
}
const WORKBENCH_TABS: [Tab, string][] = [
  ['memories', '记忆'],
  ['knowledge', '知识库'],
  ['graph', '图谱'],
  ['review', '待确认'],
  ['settings', '设置'],
]
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
  const runMutation = useMutationGuard()
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
          if (!keep || !merge) throw new Error('请选择两个对象')
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
          ? '关系已提交到“待确认”，尚未作为事实使用。'
          : '操作已保存。',
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
      setNotice('已复制到全局记忆，之后可在任意工作区参与召回。')
    } catch (error) {
      if ((error as Error).name !== 'AbortError') setFormError(plainError(error))
    } finally {
      setBusy(false)
    }
  }
  const title = {
    save: '记住一条',
    revise: '修订记忆',
    transition: '迁移记忆层级',
    retire: '停止召回',
    entity: '创建对象',
    relation: '建立关系',
    merge: '对齐对象别名',
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
          aria-label="搜索记忆或对象"
          value={query}
          onChange={e => setQuery(e.currentTarget.value)}
          placeholder="搜索记忆或对象"
        />
        <select
          aria-label="状态筛选"
          value={lifecycle}
          onChange={e => setLifecycle(e.currentTarget.value as LifecycleFilter)}
          disabled={mode === 'entities'}
        >
          <option value="all">全部状态</option>
          <option value="active">当前有效</option>
          <option value="candidate">候选</option>
          <option value="expired">已过期</option>
          <option value="retired">已停用</option>
        </select>
        <select
          aria-label="层级筛选"
          value={layerFilter}
          onChange={e =>
            setLayerFilter(e.currentTarget.value as 'all' | MemoryLayer)
          }
          disabled={mode === 'entities'}
        >
          <option value="all">全部层级</option>
          {MEMORY_LAYERS.map(value => (
            <option value={value} key={value}>
              {memoryLayerLabel[value]}记忆
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant={mode === 'memories' ? 'primary' : 'outline'}
          onClick={() => setMode('memories')}
        >
          记忆
        </Button>
        {allowEntityEditing && (
          <Button
            size="sm"
            variant={mode === 'entities' ? 'primary' : 'outline'}
            onClick={() => setMode('entities')}
          >
            对象
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => open(mode === 'memories' ? 'save' : 'entity')}
        >
          {mode === 'memories' ? (writeScopeId === GLOBAL_SCOPE_ID ? '记住到全局' : '记住一条') : '创建对象'}
        </Button>
        {mode === 'entities' && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => open('relation')}
            >
              建立关系
            </Button>
            <Button size="sm" variant="outline" onClick={() => open('merge')}>
              对齐别名
            </Button>
          </>
        )}
      </div>
      {mode === 'memories' ? (
        <div className={styles.memoryLayout}>
          <section className={styles.memoryList} aria-label="记忆列表">
            {memories.phase === 'loading' && !memories.data ? (
              <div className={styles.loading}>正在读取记忆…</div>
            ) : memories.error && !memories.data ? (
              <div className={styles.error} role="alert">
                {memories.error}
                <Button onClick={memories.reload}>重试</Button>
              </div>
            ) : !memories.data?.length ? (
              <div className={styles.empty}>当前筛选下没有记忆。</div>
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
                      {memoryLayerLabel[m.layer ?? 'semantic']}记忆
                    </Tag>
                    <Tag tone="outline">
                      重要度 {Math.round((m.importance ?? 0.5) * 100)}%
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
                    {m.legacy && <Tag tone="info">旧记忆</Tag>}
                    <Tag tone={m.lifecycle === 'active' ? 'success' : m.lifecycle === 'candidate' ? 'warning' : 'neutral'}>
                      {m.lifecycle === 'active' ? '有效' : m.lifecycle === 'candidate' ? '候选' : m.expiresAt !== null && m.expiresAt <= Date.now() ? '已过期' : '已停用'}
                    </Tag>
                    <Tag tone="outline">{m.source.actorRole === 'assistant' ? '自动提炼' : m.source.actorRole === 'human' ? '用户内容' : sourceLabel(m)}</Tag>
                    <span className={styles.meta}>
                      {formatTime(m.recordedAt)}
                    </span>
                  </div>
                </button>
              ))
            )}
          </section>
          {selected && !editor && (
            <aside className={styles.panel + ' ' + styles.detailDialog} role="dialog" aria-modal="true" aria-label="记忆详情">
              <div className={styles.stack}>
                <div className={styles.between}>
                  <h3 className={styles.sectionTitle}>记忆详情</h3>
                  <div className={styles.actions}>
                    <Tag tone={selected.lifecycle === 'retired' ? 'neutral' : 'info'}>v{selected.revision}</Tag>
                    <Button size="sm" variant="ghost" onClick={() => setSelected(null)} aria-label="关闭记忆详情">关闭</Button>
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
                  范围：{formatScopeLabel(selected.scopeId, selected.scopeId)}
                  <br />
                  层级：{memoryLayerLabel[selected.layer ?? 'semantic']}
                  （重要度 {Math.round((selected.importance ?? 0.5) * 100)}%）
                  <br />
                  到期：
                  {selected.expiresAt === null
                    ? '长期保留'
                    : formatTime(selected.expiresAt)}
                  <br />
                  生效：
                  {selected.validFrom === null
                    ? '未知'
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
                      复制到全局
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => open('revise')}
                  >
                    修订
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={selected.lifecycle === 'retired'}
                    onClick={() => open('transition')}
                  >
                    迁移层级
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={selected.lifecycle === 'retired'}
                    onClick={() => open('retire')}
                  >
                    停止召回
                  </Button>
                </div>
                <div>
                  <h3 className={styles.sectionTitle}>版本</h3>
                  {versions.phase === 'loading' && (
                    <div className={styles.loading}>正在读取版本…</div>
                  )}
                  {versions.error && (
                    <div className={styles.error} role="alert">
                      版本暂不可用：{versions.error}
                      <Button onClick={versions.reload}>重试</Button>
                    </div>
                  )}
                  {versions.data?.map(v => (
                    <div className={styles.usage} key={v.revision}>
                      <b>v{v.revision}</b> · {formatTime(v.recordedAt)}
                      <div className={styles.snapshot}>{v.content}</div>
                      <div className={styles.meta}>
                        {memoryLayerLabel[v.layer ?? 'semantic']}记忆 · 重要度
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
            <div className={styles.loading}>正在读取对象…</div>
          ) : entities.error ? (
            <div className={styles.error} role="alert">
              {entities.error}
              <Button onClick={entities.reload}>重试</Button>
            </div>
          ) : !entities.data?.length ? (
            <div className={styles.empty}>
              还没有对象。创建项目、需求、接口等对象后，可以建立有来源的关系。
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
            ? '关系先进入待确认；必须引用一条记忆中的原文。'
            : editor === 'merge'
              ? '仅同类型对象可对齐，历史身份与证据保留。'
              : '更改会记录新版本，不覆盖历史。'
        }
        closeLabel="关闭"
        footer={
          <div className={styles.actions}>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setEditor(null)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              disabled={busy || !canSubmit}
              onClick={() => void perform()}
            >
              {busy ? '保存中…' : '确认'}
            </Button>
          </div>
        }
      >
        <div className={styles.modalContent + ' ' + styles.form}>
          {(editor === 'save' || editor === 'revise') && (
            <>
              <div className={styles.field}>
                <label>类型</label>
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
                <label>内容</label>
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
                <label>记忆层级</label>
                <select
                  aria-label="记忆层级"
                  value={layer}
                  onChange={(e) => {
                    setLayer(e.currentTarget.value as MemoryLayer)
                    setExpiresAt('')
                  }}
                >
                  {MEMORY_LAYERS.map(value => (
                    <option value={value} key={value}>
                      {memoryLayerLabel[value]}记忆
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label htmlFor="context-memory-importance">
                  重要度（0–1）
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
                <label htmlFor="context-memory-expires">到期时间（可选）</label>
                <input
                  id="context-memory-expires"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={e => setExpiresAt(e.currentTarget.value)}
                />
                <span className={styles.hint}>
                  留空时，工作和情节记忆使用系统保留策略；语义和程序记忆长期保留。
                </span>
              </div>
            </>
          )}
          {editor === 'entity' && (
            <>
              <div className={styles.field}>
                <label>对象类型</label>
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
                <label>名称</label>
                <input
                  value={content}
                  onChange={e => setContent(e.currentTarget.value)}
                />
              </div>
              <div className={styles.field}>
                <label>别名（逗号分隔）</label>
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
                <label>主语对象</label>
                <select
                  value={subject}
                  onChange={e => setSubject(e.currentTarget.value)}
                >
                  <option value="">请选择</option>
                  {entities.data?.map(e => (
                    <option value={e.id} key={e.id}>
                      {e.name} · {e.type}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label>关系</label>
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
                <label>宾语对象</label>
                <select
                  value={object}
                  onChange={e => setObject(e.currentTarget.value)}
                >
                  <option value="">请选择</option>
                  {entities.data?.map(e => (
                    <option value={e.id} key={e.id}>
                      {e.name} · {e.type}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label>来源记忆</label>
                <select
                  value={sourceMemoryId}
                  onChange={e => setSourceMemoryId(e.currentTarget.value)}
                >
                  <option value="">请选择</option>
                  {memories.data?.map(m => (
                    <option value={m.id} key={m.id}>
                      {m.content.slice(0, 60)}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label>原文片段</label>
                <textarea
                  value={quote}
                  onChange={e => setQuote(e.currentTarget.value)}
                  placeholder="必须与来源中的文字完全一致"
                />
              </div>
            </>
          )}
          {editor === 'merge' && (
            <>
              <div className={styles.field}>
                <label>保留对象</label>
                <select
                  value={subject}
                  onChange={e => setSubject(e.currentTarget.value)}
                >
                  <option value="">请选择</option>
                  {entities.data?.map(e => (
                    <option value={e.id} key={e.id}>
                      {e.name} · {e.type}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label>并入对象</label>
                <select
                  value={mergeId}
                  onChange={e => setMergeId(e.currentTarget.value)}
                >
                  <option value="">请选择</option>
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
              <label>理由</label>
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
      label: '全部范围',
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
      aria-label="agentOS context 记忆工作台"
      data-context-surface={surface}
    >
      <header className={styles.header}>
        <div className={styles.titleRow + ' ' + responsive.headerRow}>
          <div>
            <h1 className={styles.title + ' ' + responsive.title}>记忆</h1>
            <p className={styles.subtitle}>跨会话记忆、知识库与关系图谱</p>
          </div>
          <div className={styles.actions + ' ' + responsive.headerActions}>
            {orderedScopes.length ? (
              <select
                className={styles.scope + ' ' + responsive.scope}
                aria-label="记忆范围"
                value={scopeId}
                onChange={e => setScopeId(e.currentTarget.value)}
              >
                {displayedScopes.map(s => (
                  <option value={s.id} key={s.id}>
                    {formatScopeLabel(s.id, s.label)} · {s.count} 条记忆{s.knowledgeCount ? ` · ${s.knowledgeCount} 篇知识` : ''}
                  </option>
                ))}
              </select>
            ) : null}
            <Button variant="toolbar" size="sm" onClick={onClose}>
              {surface === 'conversation' ? '返回对话' : '关闭'}
            </Button>
          </div>
        </div>
        {selectedScope && (
          <div className={styles.scopeSummary}>
            <div className={styles.memoryActivity} aria-label="自动记忆状态">
              <span className={boot.data?.features.capture ? styles.activityDotOn : styles.activityDotOff}/>
              <b>{boot.data?.features.capture ? '自动记忆已开启' : '自动记忆已关闭'}</b>
              {latestMemoryChange
                ? <span>最近：{changeLabel(latestMemoryChange.action)} · {formatTime(latestMemoryChange.at)}</span>
                : <span>当前范围还没有新的写入记录</span>}
            </div>
            <span>
              正在显示“{formatScopeLabel(selectedScope.id, selectedScope.label)}”中的 {selectedScope.count} 条记录
            </span>
            <span>
              {selectedScope.id === ALL_SCOPES_ID
                ? '这里汇总显示旧 OpenContext 与所有工作区的新记忆；自动捕获仍写入当前工作区。'
                : selectedScope.id === boot.data?.globalScope
                  ? '全局记忆可在任意工作区参与自动召回；自动捕获仍默认保存在当前工作区。'
                  : (boot.data?.recallOrder?.length ?? (boot.data?.globalScope ? 2 : 1)) > 1
                    ? (boot.data?.recallOrder ? '回答时会按本次会话、Agent、工作区、用户、应用、全局的可用范围联合检索。' : '回答时会联合检索当前工作区与全局记忆。')
                    : '当前配置固定为单一记忆范围。'}
            </span>
            {sessionScope && sessionScope.id !== selectedScope.id && (
              <button type="button" className={styles.scopeAction} onClick={() => setScopeId(sessionScope.id)}>
                切换到当前对话范围（{sessionScope.count}）
              </button>
            )}
          </div>
        )}
        <nav className={styles.tabs} role="tablist">
          {WORKBENCH_TABS.map(([id, label], index) => (
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
              {label}
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
          <div className={styles.loading}>正在读取 agentOS context…</div>
        ) : boot.error && !boot.data ? (
          <div className={styles.error} role="alert">
            {boot.error}
            <Button onClick={boot.reload}>重试</Button>
          </div>
        ) : !boot.data || !scopeId ? (
          <div className={styles.empty}>没有可用的记忆范围。</div>
        ) : (
          <>
            {boot.data.warnings.map(x => (
              <div className={styles.notice} key={x}>
                {x}
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
