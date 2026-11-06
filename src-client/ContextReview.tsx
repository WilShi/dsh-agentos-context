import { useEffect, useMemo, useState } from 'react'
import { Button, Tag } from './ui-primitives.tsx'
import type { ContextApi } from './context-api.ts'
import type { ContextRelation } from './context-types.ts'
import { plainError, useLoad, useMutationGuard } from './context-ui-helpers.tsx'
import styles from './Context.module.css'
import { t } from './i18n.ts'

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
  const entityLabel = (id: string) => names.get(id) ?? t('review.entity', { id: id.slice(0, 8) })
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
  if (state.phase === 'loading' && !state.data) return <div className={styles.loading}>{t('review.loading')}</div>
  if (state.error && !state.data) return <div className={styles.error} role="alert">{state.error}<Button onClick={state.reload}>{t('common.retry')}</Button></div>
  const items = state.data ?? []
  if (!items.length) return <div className={styles.empty}>{t('review.empty')}</div>
  return <div className={styles.review}>
    <nav className={styles.reviewQueue} aria-label={t('aria.reviewQueue')}>
      {items.map(item => <button className={styles.reviewCard + ' ' + (selected?.id === item.id ? styles.reviewCardActive : '')} key={item.id} onClick={() => { setSelected(item); setReason('') }}>
        <div className={styles.badges}><Tag tone="warning">{t('review.badge.pending')}</Tag><Tag tone="neutral">{predicateLabel(item.predicate)}</Tag></div>
        <div className={styles.itemTitle}>{entityLabel(item.subjectId)} → {entityLabel(item.objectId)}</div>
        <div className={styles.meta}>{t('review.meta.revision', { revision: item.revision })} · {item.sourceId ? t('review.meta.hasEvidence') : t('review.meta.missingSource')}</div>
      </button>)}
    </nav>
    <section className={styles.panel}>{selected && <div className={styles.stack}>
      <div className={styles.between}><h3 className={styles.sectionTitle}>{t('review.section.verify')}</h3><Tag tone="warning">{t('review.badge.awaitingHuman')}</Tag></div>
      <div className={styles.reviewPath}>
        <span>{entityLabel(selected.subjectId)}</span>
        <b>{predicateLabel(selected.predicate)}</b>
        <span>{entityLabel(selected.objectId)}</span>
      </div>
      <div><div className={styles.graphDrawerSectionLabel}>{t('review.section.evidence')}</div><p className={styles.source}>{selected.quote || t('review.noQuote')}</p></div>
      <div className={styles.field}><label htmlFor="review-reason">{t('review.reason.label')}</label><div className={styles.reviewQuickReasons}><button type="button" onClick={() => setReason(t('review.reason.quickMatchValue'))}>{t('review.reason.quickMatch')}</button><button type="button" onClick={() => setReason(t('review.reason.quickInsufficientValue'))}>{t('review.reason.quickInsufficient')}</button></div><textarea id="review-reason" placeholder={t('review.reason.placeholder')} value={reason} onChange={event => setReason(event.currentTarget.value)} disabled={busy}/></div>
      {error && <p className={styles.errorText}>{error}</p>}
      <div className={styles.actions}><Button variant="primary" disabled={busy || !reason.trim() || !selected.sourceId || !selected.quote} onClick={() => void decide('confirm')}>{t('review.action.confirm')}</Button><Button variant="outline" disabled={busy || !reason.trim()} onClick={() => void decide('reject')}>{t('review.action.reject')}</Button></div>
      <p className={styles.hint}>{t('review.hint')}</p>
      <details className={styles.technicalDetails}><summary>{t('review.technical.summary')}</summary><dl><div><dt>{t('review.technical.subject')}</dt><dd>{selected.subjectId}</dd></div><div><dt>{t('review.technical.predicate')}</dt><dd>{selected.predicate}</dd></div><div><dt>{t('review.technical.object')}</dt><dd>{selected.objectId}</dd></div><div><dt>{t('review.technical.source')}</dt><dd>{selected.sourceId ?? t('common.none')}</dd></div></dl></details>
    </div>}</section>
  </div>
}
