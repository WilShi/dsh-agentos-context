import { useEffect, useState } from 'react'
import { Button, Tag } from './ui-primitives.tsx'
import type { ContextApi } from './context-api.ts'
import type { ContextBootstrap } from './context-types.ts'
import {
  plainError,
  useLoad,
  useMutationGuard,
} from './context-ui-helpers.tsx'
import styles from './Context.module.css'
import { t } from './i18n.ts'
export function ContextSettings({
  api,
  scopeId,
  bootstrap,
}: {
  api: ContextApi
  scopeId: string
  bootstrap: ContextBootstrap
}) {
  const runMutation = useMutationGuard()
  const schemaState = useLoad(api, 'schema', s => api.schema(s)),
    entityState = useLoad(api, 'schema-entities:' + scopeId, s =>
      api.entities(scopeId, undefined, s),
    )
  const schema = schemaState.data,
    entities = entityState.data ?? []
  const [subject, setSubject] = useState(''),
    [predicate, setPredicate] = useState(''),
    [object, setObject] = useState(''),
    [result, setResult] = useState<string>(''),
    [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!subject && entities[0]) setSubject(entities[0].id)
    if (!object && entities[1]) setObject(entities[1].id)
    if (!predicate && schema?.relations[0])
      setPredicate(schema.relations[0].id)
  }, [entities, schema, subject, object, predicate])
  const check = async () => {
    if (!subject || !object || !predicate) return
    setBusy(true)
    try {
      const out = await runMutation(signal =>
        api.checkRelation(
          { scopeId, subjectId: subject, predicate, objectId: object },
          signal,
        ),
      )
      setResult(
        out.ok
          ? t('settings.check.ok')
          : out.errors.map(x => x.message).join(t('common.listSeparator')),
      )
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setResult(plainError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={styles.stack}>
      <section className={styles.panel}>
        <h3 className={styles.sectionTitle}>{t('settings.capabilities')}</h3>
        <div className={styles.badges}>
          <Tag tone={bootstrap.features.capture ? 'success' : 'neutral'}>
            {t('settings.feature.capture')} {bootstrap.features.capture ? t('common.enabled') : t('common.disabled')}
          </Tag>
          <Tag tone={bootstrap.features.recall ? 'success' : 'neutral'}>
            {t('settings.feature.recall')} {bootstrap.features.recall ? t('common.enabled') : t('common.disabled')}
          </Tag>
          <Tag tone={bootstrap.features.ontology ? 'success' : 'neutral'}>
            {t('settings.feature.ontology')} {bootstrap.features.ontology ? t('common.enabled') : t('common.disabled')}
          </Tag>
        </div>
        <p className={styles.hint}>
          {t('settings.hint.managed')}
        </p>
      </section>
      <section className={styles.panel}>
        <h3 className={styles.sectionTitle}>{t('aria.memoryScope')}</h3>
        <p className={styles.hint}>
          {bootstrap.globalScope
            ? t('settings.scopeHint.global')
            : t('settings.scopeHint.single')}
        </p>
      </section>
      <section className={styles.panel}>
        <h3 className={styles.sectionTitle}>{t('settings.compat.title')}</h3>
        <p className={styles.hint}>
          {t('settings.compat.body')}
        </p>
      </section>
      <section className={styles.panel}>
        <h3 className={styles.sectionTitle}>{t('settings.types.title')}</h3>
        {schemaState.error && (
          <p className={styles.errorText} role="alert">
            {schemaState.error}
            <Button onClick={schemaState.reload}>{t('common.retry')}</Button>
          </p>
        )}
        {schema && (
          <>
            <p className={styles.meta}>
              {t('settings.types.meta', { version: schema.version })}
            </p>
            <div className={styles.badges}>
              {schema.types.map(t => (
                <Tag tone="neutral" key={t.id}>
                  {t.label}
                </Tag>
              ))}
            </div>
            <table className={styles.schemaTable}>
              <thead>
                <tr>
                  <th>{t('workbench.field.relation')}</th>
                  <th>{t('settings.table.subjectType')}</th>
                  <th>{t('settings.table.objectType')}</th>
                </tr>
              </thead>
              <tbody>
                {schema.relations.map(r => (
                  <tr key={r.id}>
                    <td>{r.label}</td>
                    <td>{r.domain.join('、')}</td>
                    <td>{r.range.join('、')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
      <section className={styles.panel}>
        <h3 className={styles.sectionTitle}>{t('settings.check.title')}</h3>
        {entityState.phase === 'loading' ? (
          <p className={styles.loading}>{t('workbench.loading.entities')}</p>
        ) : entityState.error ? (
          <p className={styles.errorText} role="alert">
            {t('settings.entitiesUnavailable', { error: entityState.error })}
            <Button onClick={entityState.reload}>{t('common.retry')}</Button>
          </p>
        ) : entities.length < 2 ? (
          <p className={styles.muted}>{t('settings.needTwoEntities')}</p>
        ) : !schema?.relations.length ? (
          <p className={styles.muted}>{t('settings.noRelations')}</p>
        ) : (
          <div className={styles.form}>
            <div className={styles.field}>
              <label>{t('workbench.field.subject')}</label>
              <select
                value={subject}
                onChange={e => setSubject(e.currentTarget.value)}
              >
                {entities.map(e => (
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
                {schema.relations.map(r => (
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
                {entities.map(e => (
                  <option value={e.id} key={e.id}>
                    {e.name} · {e.type}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.actions}>
              <Button
                variant="primary"
                disabled={busy || !subject || !object || !predicate}
                onClick={() => void check()}
              >
                {t('settings.action.check')}
              </Button>
            </div>
            {result && (
              <div className={styles.notice} role="status">
                {result}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
