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
          ? '类型与方向符合当前定义。'
          : out.errors.map(x => x.message).join('；'),
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
        <h3 className={styles.sectionTitle}>当前能力</h3>
        <div className={styles.badges}>
          <Tag tone={bootstrap.features.capture ? 'success' : 'neutral'}>
            自动记忆 {bootstrap.features.capture ? '开启' : '关闭'}
          </Tag>
          <Tag tone={bootstrap.features.recall ? 'success' : 'neutral'}>
            回答召回 {bootstrap.features.recall ? '开启' : '关闭'}
          </Tag>
          <Tag tone={bootstrap.features.ontology ? 'success' : 'neutral'}>
            关联理解 {bootstrap.features.ontology ? '开启' : '关闭'}
          </Tag>
        </div>
        <p className={styles.hint}>
          模型、密钥和自动记忆配置仍在插件设置卡管理；这里不复制一套配置。
        </p>
      </section>
      <section className={styles.panel}>
        <h3 className={styles.sectionTitle}>记忆范围</h3>
        <p className={styles.hint}>
          {bootstrap.globalScope
            ? '自动捕获默认写入当前 Workspace；全局记忆可由用户明确保存或从工作区复制。回答时会自动联合检索当前 Workspace 与全局记忆，其他 Workspace 的私有记忆不会串入。'
            : '当前管理员配置固定了单一记忆范围，不启用跨范围的全局层。'}
        </p>
      </section>
      <section className={styles.panel}>
        <h3 className={styles.sectionTitle}>升级与回滚兼容</h3>
        <p className={styles.hint}>
          旧 OpenContext
          记忆保持原位并按页只读加载，升级不会重写旧数据库；新建、修订和停用记录写入
          agentOS context
          侧车库。若回滚到只识别旧库的插件，新写入内容不可见，且在新版中停用的旧记录可能重新出现。回滚前请保留两个数据库的完整备份。
        </p>
      </section>
      <section className={styles.panel}>
        <h3 className={styles.sectionTitle}>类型与关系</h3>
        {schemaState.error && (
          <p className={styles.errorText} role="alert">
            {schemaState.error}
            <Button onClick={schemaState.reload}>重试</Button>
          </p>
        )}
        {schema && (
          <>
            <p className={styles.meta}>
              本体版本 {schema.version} ·
              有限类型与受控关系，不执行任意OWL或脚本。
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
                  <th>关系</th>
                  <th>主语类型</th>
                  <th>宾语类型</th>
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
        <h3 className={styles.sectionTitle}>关系类型校验</h3>
        {entityState.phase === 'loading' ? (
          <p className={styles.loading}>正在读取对象…</p>
        ) : entityState.error ? (
          <p className={styles.errorText} role="alert">
            对象暂不可用：{entityState.error}
            <Button onClick={entityState.reload}>重试</Button>
          </p>
        ) : entities.length < 2 ? (
          <p className={styles.muted}>至少创建两个对象后，才能验证关系方向。</p>
        ) : !schema?.relations.length ? (
          <p className={styles.muted}>当前本体没有可校验的关系定义。</p>
        ) : (
          <div className={styles.form}>
            <div className={styles.field}>
              <label>主语对象</label>
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
              <label>关系</label>
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
              <label>宾语对象</label>
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
                校验
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
