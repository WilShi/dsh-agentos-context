import { useEffect, useMemo, useState } from 'react'
import { Button, Tag } from './ui-primitives.tsx'
import type { ContextApi } from './context-api.ts'
import type { ContextRelation } from './context-types.ts'
import { plainError, useLoad, useMutationGuard } from './context-ui-helpers.tsx'
import styles from './Context.module.css'

export function ContextReview({ api, scopeId }: { api: ContextApi; scopeId: string }) {
  const state = useLoad(api, 'reviews:' + scopeId, signal => api.reviews(scopeId, signal))
  const entityState = useLoad(api, 'review-entities:' + scopeId, signal => api.entities(scopeId, undefined, signal))
  const schemaState = useLoad(api, 'review-schema', signal => api.schema(signal))
  const [selected, setSelected] = useState<ContextRelation | null>(null),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  // M5: a decision is bound to one scope AND one relation; changing either
  // aborts the in-flight review so a stale decision can never be applied to the
  // newly selected item.
  const runMutation = useMutationGuard(
    scopeId + '\u0000' + (selected?.id ?? '') + '\u0000' + (selected?.revision ?? ''),
  )
  const typeLabels = useMemo(() => new Map((schemaState.data?.types ?? []).map(type => [type.id, type.label])), [schemaState.data])
  const names = useMemo(() => new Map((entityState.data ?? []).map(entity => [entity.id, `${entity.name} · ${typeLabels.get(entity.type) ?? entity.type}`])), [entityState.data, typeLabels])
  const predicates = useMemo(
    () => new Map((schemaState.data?.relations ?? []).map(relation => [relation.id, relation.label])),
    [schemaState.data],
  )
  const entityLabel = (id: string) => names.get(id) ?? `对象 ${id.slice(0, 8)}`
  const predicateLabel = (id: string) => predicates.get(id) ?? id.replaceAll('_', ' ')
  useEffect(() => {
    if (selected && !state.data?.some(item => item.id === selected.id)) setSelected(null)
    if (!selected && state.data?.[0]) setSelected(state.data[0])
  }, [state.data, selected])
  const decide = async (decision: 'confirm' | 'reject') => {
    if (!selected || !reason.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      await runMutation(signal => api.reviewRelation({
        scopeId: selected.scopeId,
        id: selected.id,
        expectedRevision: selected.revision,
        decision,
        reason: reason.trim(),
      }, signal))
      setReason('')
      setSelected(null)
      state.reload()
    } catch (cause) {
      if ((cause as Error).name !== 'AbortError') setError(plainError(cause))
    } finally {
      setBusy(false)
    }
  }
  if (state.phase === 'loading' && !state.data) return <div className={styles.loading}>正在读取待确认关系…</div>
  if (state.error && !state.data) return <div className={styles.error} role="alert">{state.error}<Button onClick={state.reload}>重试</Button></div>
  const items = state.data ?? []
  if (!items.length) return <div className={styles.empty}>当前没有待确认关系。模型提取出的新关系会先进入这里，不会未经确认直接当作事实使用。</div>
  return <div className={styles.review}>
    <nav className={styles.reviewQueue} aria-label="待确认关系">
      {items.map(item => <button className={styles.reviewCard + ' ' + (selected?.id === item.id ? styles.reviewCardActive : '')} key={item.id} onClick={() => { setSelected(item); setReason('') }}>
        <div className={styles.badges}><Tag tone="warning">待确认</Tag><Tag tone="neutral">{predicateLabel(item.predicate)}</Tag></div>
        <div className={styles.itemTitle}>{entityLabel(item.subjectId)} → {entityLabel(item.objectId)}</div>
        <div className={styles.meta}>第 {item.revision} 版 · {item.sourceId ? '有原文证据' : '缺少来源'}</div>
      </button>)}
    </nav>
    <section className={styles.panel}>{selected && <div className={styles.stack}>
      <div className={styles.between}><h3 className={styles.sectionTitle}>核对这条关系</h3><Tag tone="warning">等待人工确认</Tag></div>
      <div className={styles.reviewPath}>
        <span>{entityLabel(selected.subjectId)}</span>
        <b>{predicateLabel(selected.predicate)}</b>
        <span>{entityLabel(selected.objectId)}</span>
      </div>
      <div><div className={styles.graphDrawerSectionLabel}>支持这条关系的原文</div><p className={styles.source}>{selected.quote || '当前没有原文片段；这条关系只能驳回，不能确认。'}</p></div>
      <div className={styles.field}><label htmlFor="review-reason">处理说明</label><div className={styles.reviewQuickReasons}><button type="button" onClick={() => setReason('原文与关系方向一致。')}>原文一致</button><button type="button" onClick={() => setReason('原文不足以支持这条关系。')}>证据不足</button></div><textarea id="review-reason" placeholder="说明确认或驳回的依据" value={reason} onChange={event => setReason(event.currentTarget.value)} disabled={busy}/></div>
      {error && <p className={styles.errorText}>{error}</p>}
      <div className={styles.actions}><Button variant="primary" disabled={busy || !reason.trim() || !selected.sourceId || !selected.quote} onClick={() => void decide('confirm')}>确认关系</Button><Button variant="outline" disabled={busy || !reason.trim()} onClick={() => void decide('reject')}>驳回</Button></div>
      <p className={styles.hint}>确认表示“这段原文支持该关系”，不代表它永远正确；后续仍可根据新证据修订。</p>
      <details className={styles.technicalDetails}><summary>技术信息</summary><dl><div><dt>主语 ID</dt><dd>{selected.subjectId}</dd></div><div><dt>关系字段</dt><dd>{selected.predicate}</dd></div><div><dt>宾语 ID</dt><dd>{selected.objectId}</dd></div><div><dt>来源 ID</dt><dd>{selected.sourceId ?? '无'}</dd></div></dl></details>
    </div>}</section>
  </div>
}
