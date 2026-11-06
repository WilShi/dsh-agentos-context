/**
 * agentOS context 独立记忆设置页（兼容 dsh-opencontext 配置命名空间）。
 *
 * 草稿 key 通过 authenticated Connection RPC 在固定网关验证，成功后才写入
 * credentials；密钥字面量永不回显。普通设置采用 SettingsScope 草稿和单次
 * revision-fenced mutate 保存，高级字段提供独立保存/重置。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from './ui-primitives.tsx'
/**
 * Structural subset of `@deepseek-ai/dsh-client-ui-settings/client`.
 *
 * The host module exists at runtime; this source tree does not install its
 * declarations, and importing the types made the card (and every consumer of
 * `ConfigCardFace`) untypable. The members used by this file are declared here.
 */
interface ConfigFormSnapshot<T> {
  readonly value?: T | undefined
  readonly user?: unknown
  readonly revision: number
  readonly status: string
  readonly writable?: boolean
}
interface ConfigForm<T> {
  subscribe(listener: () => void): () => void
  getSnapshot(): ConfigFormSnapshot<T>
  mutate(ops: readonly unknown[], expectedRevision?: number): Promise<boolean | void>
}
import type { ModelsResult, OcApi, VerifyKeyResult } from './api.ts'
import type { ContextApi } from './context-api.ts'
import { ContextModal } from './ContextModal.tsx'
import { ContextWorkbench } from './ContextWorkbench.tsx'
import css from './ConfigCard.module.css'
import { t } from './i18n.ts'

export interface OpenContextSection {
  embeddingModel?: string
  capturePrompts?: boolean
  distillOnCapture?: boolean
  distillModel?: string
  ontologyEnabled?: boolean
  recallEnabled?: boolean
  memoryLayeringEnabled?: boolean
  autoConsolidate?: boolean
  workingMemoryHours?: number
  episodicMemoryDays?: number
  scopeUserId?: string
  scopeAgentId?: string
  scopeAppId?: string
  [key: string]: unknown
}

export interface ConfigCardFace {
  api: OcApi
  contextApi: ContextApi
  scope: ConfigForm<OpenContextSection>
  subscribeCredentialsUpdated?: ((listener: (ref: string) => void) => (() => void) | undefined) | undefined
}

const MODEL_OPTIONS = [
  { id: 'bgem3-embedding', labelKey: 'config.model.bgem3' as const },
  { id: 'qwen3-embedding-06b', labelKey: null },
]

const DEFAULTS = {
  embeddingModel: 'bgem3-embedding',
  apiKeyEnv: 'AGENTOS_CONTEXT_API_KEY',
  embeddingBaseUrl: '',
  capturePrompts: true,
  distillOnCapture: true,
  distillModel: '',
  ontologyEnabled: true,
  recallEnabled: true,
  memoryLayeringEnabled: true,
  autoConsolidate: true,
  workingMemoryHours: 24,
  episodicMemoryDays: 90,
  scopeUserId: '',
  scopeAgentId: '',
  scopeAppId: '',
}

type VerifyState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'ok'; dimensions?: number }
  | { phase: 'failed'; result: VerifyKeyResult }

function fieldValue<T>(snapshot: ConfigFormSnapshot<OpenContextSection>, key: string, fallback: T): T {
  const value = snapshot.value?.[key]
  return (value === undefined ? fallback : value) as T
}

function isOverridden(snapshot: ConfigFormSnapshot<OpenContextSection>, key: string): boolean {
  const user = snapshot.user
  return typeof user === 'object' && user !== null && key in user
}

export function ConfigCard(props: ConfigCardFace) {
  const { api, contextApi, scope } = props
  // scope.subscribe/getSnapshot 是类方法、内部引用 this —— 必须箭头包装，
  // 裸方法引用传给 useSyncExternalStore 会在挂载时 this 失控直接崩掉整个卡。
  const snapshot = useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot(),
  )

  const embeddingModel = fieldValue(snapshot, 'embeddingModel', DEFAULTS.embeddingModel)
  const capturePrompts = fieldValue(snapshot, 'capturePrompts', DEFAULTS.capturePrompts)
  const distillOnCapture = fieldValue(snapshot, 'distillOnCapture', DEFAULTS.distillOnCapture)
  const distillModel = fieldValue(snapshot, 'distillModel', DEFAULTS.distillModel)
  const ontologyEnabled = fieldValue(snapshot, 'ontologyEnabled', DEFAULTS.ontologyEnabled)
  const recallEnabled = fieldValue(snapshot, 'recallEnabled', DEFAULTS.recallEnabled)
  const memoryLayeringEnabled = fieldValue(snapshot, 'memoryLayeringEnabled', DEFAULTS.memoryLayeringEnabled)
  const autoConsolidate = fieldValue(snapshot, 'autoConsolidate', DEFAULTS.autoConsolidate)
  const workingMemoryHours = fieldValue(snapshot, 'workingMemoryHours', DEFAULTS.workingMemoryHours)
  const episodicMemoryDays = fieldValue(snapshot, 'episodicMemoryDays', DEFAULTS.episodicMemoryDays)
  const scopeUserId = fieldValue(snapshot, 'scopeUserId', DEFAULTS.scopeUserId)
  const scopeAgentId = fieldValue(snapshot, 'scopeAgentId', DEFAULTS.scopeAgentId)
  const scopeAppId = fieldValue(snapshot, 'scopeAppId', DEFAULTS.scopeAppId)
  const editable = snapshot.status === 'ready' && snapshot.writable

  const [draft, setDraft] = useState('')
  const [verify, setVerify] = useState<VerifyState>({ phase: 'idle' })
  const [credential, setCredential] = useState<{ configured: boolean; writable: boolean }>({ configured: false, writable: true })
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [workbenchOpen, setWorkbenchOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [distillDraft, setDistillDraft] = useState(distillModel)
  const [embeddingDraft, setEmbeddingDraft] = useState(embeddingModel)
  const [captureDraft, setCaptureDraft] = useState(capturePrompts)
  const [distillOnDraft, setDistillOnDraft] = useState(distillOnCapture)
  const [ontologyDraft, setOntologyDraft] = useState(ontologyEnabled)
  const [recallDraft, setRecallDraft] = useState(recallEnabled)
  const [layeringDraft, setLayeringDraft] = useState(memoryLayeringEnabled)
  const [consolidateDraft, setConsolidateDraft] = useState(autoConsolidate)
  const [workingHoursDraft, setWorkingHoursDraft] = useState(String(workingMemoryHours))
  const [episodicDaysDraft, setEpisodicDaysDraft] = useState(String(episodicMemoryDays))
  const [scopeUserDraft, setScopeUserDraft] = useState(scopeUserId)
  const [scopeAgentDraft, setScopeAgentDraft] = useState(scopeAgentId)
  const [scopeAppDraft, setScopeAppDraft] = useState(scopeAppId)
  // undefined = 加载中；null = 路由未就绪/非 JSON（硬失败，与契约 error 形区分）
  const [models, setModels] = useState<ModelsResult | null | undefined>(undefined)
  const apiKeyEnv = models?.apiKeyEnv ?? DEFAULTS.apiKeyEnv
  const embeddingBaseUrl = models?.embeddingBaseUrl ?? DEFAULTS.embeddingBaseUrl
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const credentialEpoch = useRef(0)
  const copyTimer = useRef<number | undefined>(undefined)

  useEffect(() => { setDistillDraft(distillModel) }, [distillModel])
  useEffect(() => { setEmbeddingDraft(embeddingModel) }, [embeddingModel])
  useEffect(() => { setCaptureDraft(capturePrompts) }, [capturePrompts])
  useEffect(() => { setDistillOnDraft(distillOnCapture) }, [distillOnCapture])
  useEffect(() => { setOntologyDraft(ontologyEnabled) }, [ontologyEnabled])
  useEffect(() => { setRecallDraft(recallEnabled) }, [recallEnabled])
  useEffect(() => { setLayeringDraft(memoryLayeringEnabled) }, [memoryLayeringEnabled])
  useEffect(() => { setConsolidateDraft(autoConsolidate) }, [autoConsolidate])
  useEffect(() => { setWorkingHoursDraft(String(workingMemoryHours)) }, [workingMemoryHours])
  useEffect(() => { setEpisodicDaysDraft(String(episodicMemoryDays)) }, [episodicMemoryDays])
  useEffect(() => { setScopeUserDraft(scopeUserId) }, [scopeUserId])
  useEffect(() => { setScopeAgentDraft(scopeAgentId) }, [scopeAgentId])
  useEffect(() => { setScopeAppDraft(scopeAppId) }, [scopeAppId])

  // 提炼模型清单（keyConfigured/auto/configured 随密钥引用、配置状态与已选模型变化而变；
  // apiKeyEnv 必须在 deps——换成另一个"也已配置"的 ref 时 boolean 不翻转，列表/错误会滞留）
  useEffect(() => {
    if (snapshot.status !== 'ready') { setModels(undefined); return }
    let alive = true
    api.listModels()
      .then((result) => { if (alive) setModels(result) })
      .catch(() => { if (alive) setModels(null) })
    return () => { alive = false }
  }, [api, apiKeyEnv, credential.configured, distillModel])

  // M6: a key belongs to the CURRENT credential reference. Bumping the epoch
  // when apiKeyEnv changes makes an in-flight verify/save for the old reference
  // drop its result instead of writing the key into the new namespace.
  useEffect(() => { credentialEpoch.current++ }, [apiKeyEnv])

  const refreshCredential = useCallback(async (ref: string) => {
    const epoch = ++credentialEpoch.current
    try { const next = await api.describeCredential(ref); if (epoch === credentialEpoch.current) setCredential(next) }
    catch { /* describe 失败保持现状 */ }
  }, [api])
  useEffect(() => () => {
    credentialEpoch.current++
    if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
  }, [])

  useEffect(() => { if (snapshot.status === 'ready') void refreshCredential(apiKeyEnv) }, [apiKeyEnv, refreshCredential, snapshot.status])
  useEffect(() => {
    if (snapshot.status !== 'ready') return
    return props.subscribeCredentialsUpdated?.((ref) => { if (ref === apiKeyEnv) void refreshCredential(ref) })
  }, [props, apiKeyEnv, refreshCredential, snapshot.status])

  const checkAndSave = async () => {
    if (!editable || settingsBusy) return
    const key = draft.trim()
    if (!key) return
    // M6: capture the generation and the credential reference this key was
    // verified against. A model/ref switch (or a newer save) during the round
    // trip must not store the key under the now-current reference.
    const epoch = ++credentialEpoch.current
    const targetRef = apiKeyEnv
    setVerify({ phase: 'checking' })
    setSettingsBusy(true)
    try {
      const result = await api.verifyKey({ apiKey: key })
      if (epoch !== credentialEpoch.current) return
      if (result.ok) {
        await api.setCredential(targetRef, key)
        if (epoch !== credentialEpoch.current) return
        // Only clear the field when the user has not typed a newer key.
        setDraft(current => (current.trim() === key ? '' : current))
        setVerify(result.dimensions === undefined ? { phase: 'ok' } : { phase: 'ok', dimensions: result.dimensions })
        await refreshCredential(targetRef)
      } else {
        setVerify({ phase: 'failed', result })
      }
    } catch {
      if (epoch === credentialEpoch.current)
        setVerify({ phase: 'failed', result: { ok: false, code: 'NETWORK', hint: t('error.network') } })
    } finally {
      setSettingsBusy(false)
    }
  }

  const copyApplyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      // L4: one owned timer, cleared on re-copy and on unmount, so a copied
      // badge can never flip back after the card is gone.
      if (copyTimer.current !== undefined) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = undefined
        setCopied(false)
      }, 2000)
    } catch {
      // 剪贴板不可用时不阻塞
    }
  }

  // 提炼需要密钥；自动记忆开关始终可用，以便无密钥时明确关闭后续捕获。
  const keyMissing = !credential.configured
  const keyMissingTitle = keyMissing ? t('config.keyMissingTitle') : undefined

  const writeSetting = async (operation: () => Promise<boolean | void>) => {
    if (!editable || settingsBusy) return false
    setSettingsBusy(true)
    setSettingsError('')
    try {
      const accepted = await operation()
      if (accepted === false) {
        setSettingsError(t('config.saveFailed'))
        return false
      }
      return true
    }
    catch { setSettingsError(t('config.saveFailed')); return false }
    finally { setSettingsBusy(false) }
  }

  const workingHoursValue = Number(workingHoursDraft)
  const episodicDaysValue = Number(episodicDaysDraft)
  const retentionValid = Number.isInteger(workingHoursValue)
    && workingHoursValue >= 1
    && workingHoursValue <= 168
    && Number.isInteger(episodicDaysValue)
    && episodicDaysValue >= 1
    && episodicDaysValue <= 3650
  const scopeIdsValid = [scopeUserDraft,scopeAgentDraft,scopeAppDraft].every(value=>value.length<=512&&!/[\0-\x1f\x7f]/u.test(value))
  const settingsDirty = embeddingDraft !== embeddingModel
    || captureDraft !== capturePrompts
    || distillOnDraft !== distillOnCapture
    || ontologyDraft !== ontologyEnabled
    || recallDraft !== recallEnabled
    || layeringDraft !== memoryLayeringEnabled
    || consolidateDraft !== autoConsolidate
    || workingHoursValue !== workingMemoryHours
    || episodicDaysValue !== episodicMemoryDays
    || distillDraft.trim() !== distillModel
    || scopeUserDraft.trim() !== scopeUserId
    || scopeAgentDraft.trim() !== scopeAgentId
    || scopeAppDraft.trim() !== scopeAppId
  const cancelSettingsDraft = () => { setEmbeddingDraft(embeddingModel); setCaptureDraft(capturePrompts); setDistillOnDraft(distillOnCapture); setOntologyDraft(ontologyEnabled); setRecallDraft(recallEnabled); setLayeringDraft(memoryLayeringEnabled); setConsolidateDraft(autoConsolidate); setWorkingHoursDraft(String(workingMemoryHours)); setEpisodicDaysDraft(String(episodicMemoryDays)); setDistillDraft(distillModel); setScopeUserDraft(scopeUserId); setScopeAgentDraft(scopeAgentId); setScopeAppDraft(scopeAppId); setSettingsError('') }
  const saveSettingsDraft = async () => {
    const ops: any[] = []
    if (embeddingDraft !== embeddingModel) ops.push({ op: 'set', path: ['embeddingModel'], value: embeddingDraft })
    if (captureDraft !== capturePrompts) ops.push({ op: 'set', path: ['capturePrompts'], value: captureDraft })
    if (distillOnDraft !== distillOnCapture) ops.push({ op: 'set', path: ['distillOnCapture'], value: distillOnDraft })
    if (ontologyDraft !== ontologyEnabled) ops.push({ op: 'set', path: ['ontologyEnabled'], value: ontologyDraft })
    if (recallDraft !== recallEnabled) ops.push({ op: 'set', path: ['recallEnabled'], value: recallDraft })
    if (layeringDraft !== memoryLayeringEnabled) ops.push({ op: 'set', path: ['memoryLayeringEnabled'], value: layeringDraft })
    if (consolidateDraft !== autoConsolidate) ops.push({ op: 'set', path: ['autoConsolidate'], value: consolidateDraft })
    if (workingHoursValue !== workingMemoryHours) ops.push({ op: 'set', path: ['workingMemoryHours'], value: workingHoursValue })
    if (episodicDaysValue !== episodicMemoryDays) ops.push({ op: 'set', path: ['episodicMemoryDays'], value: episodicDaysValue })
    if (distillDraft.trim() !== distillModel) ops.push(distillDraft.trim() ? { op: 'set', path: ['distillModel'], value: distillDraft.trim() } : { op: 'unset', path: ['distillModel'] })
    for(const [key,draft,current] of [['scopeUserId',scopeUserDraft,scopeUserId],['scopeAgentId',scopeAgentDraft,scopeAgentId],['scopeAppId',scopeAppDraft,scopeAppId]] as const){const value=draft.trim();if(value!==current)ops.push(value?{ op:'set',path:[key],value }:{ op:'unset',path:[key] })}
    if (!ops.length) return
    await writeSetting(() => scope.mutate(ops, snapshot.revision))
  }

  const closeWorkbench = () => { setWorkbenchOpen(false); queueMicrotask(() => document.getElementById('oc-open-workbench')?.focus()) }
  const workbenchDialog = <ContextModal open={workbenchOpen} onClose={closeWorkbench} title={t('memoryView.workbench.title')} headless className={css.workbenchDialog}>
    <div className={css.workbenchDialogBody}><ContextWorkbench api={contextApi} onClose={closeWorkbench} /></div>
  </ContextModal>

  if (snapshot.status !== 'ready') return (
    <>
      <section className={css.card} data-opencontext-config-card>
        <div className={css.header}>
          <div>
            <h3 className={css.title}>agentOS context</h3>
            <p className={css.description}>{t('config.description')}</p>
          </div>
        </div>
        <p className={snapshot.status === 'loading' ? css.hint : css.error}>{snapshot.status === 'loading' ? t('config.loading') : t('config.unavailable')}</p>
        <div className={css.managerRow}><div><span className={css.label}>{t('config.memoryManagement')}</span><p className={css.hint}>{t('config.memoryManagementHint')}</p></div><Button id="oc-open-workbench" variant="outline" onClick={() => setWorkbenchOpen(true)}>{t('config.openWorkbench')}</Button></div>
      </section>
      {workbenchDialog}
    </>
  )

  const badge = credential.configured
    ? verify.phase === 'ok'
      ? { text: t('config.badge.configuredPermitted'), cls: css.badgeOk }
      : { text: t('config.badge.configured'), cls: css.badgeOk }
    : verify.phase === 'failed' && verify.result.code === 'NO_PERMISSION'
      ? { text: t('config.badge.noPermission'), cls: css.badgeWarn }
      : { text: t('config.badge.unconfigured'), cls: css.badgeMuted }

  return (
    <>
      <section className={css.card} data-opencontext-config-card>
        <div className={css.header}>
          <div>
            <h3 className={css.title}>agentOS context</h3>
            <p className={css.description}>{t('config.description')}</p>
          </div>
          <div className={css.headerActions}>
            <span className={`${css.badge} ${badge.cls}`}>{badge.text}</span>
            <Button id="oc-open-workbench" variant="outline" onClick={() => setWorkbenchOpen(true)}>{t('config.openWorkbench')}</Button>
          </div>
        </div>

        {settingsError ? <p className={css.error} role="alert">{settingsError}</p> : null}
        {!snapshot.writable ? <p className={css.hint}>{t('config.readOnly')}</p> : null}

        <div className={css.field}>
          <label className={css.label} htmlFor="oc-api-key">{t('config.gatewayKey', { env: apiKeyEnv })}</label>
          <div className={css.row}>
            <input
              id="oc-api-key"
              type="password"
              value={draft}
              disabled={!credential.writable || !editable || settingsBusy}
              placeholder={credential.configured ? t('config.key.placeholderConfigured') : t('config.key.placeholder')}
              onChange={(event) => { setDraft(event.target.value); setVerify({ phase: 'idle' }) }}
              style={{
                flex: 1,
                padding: '7px 10px',
                fontSize: 13,
                color: 'var(--dsw-alias-label-primary)',
                background: 'var(--dsw-alias-bg-layer-2, transparent)',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 8,
              }}
            />
            <Button variant="primary" disabled={!draft.trim() || verify.phase === 'checking' || !credential.writable || !editable || settingsBusy} onClick={() => { void checkAndSave() }}>
              {verify.phase === 'checking' ? t('config.verify.checking') : t('config.verify.checkAndSave')}
            </Button>
          </div>
          <p className={css.hint}>
            {t('config.gatewayNotice')}
            {t('config.localFallbackNotice', { hours: workingMemoryHours })}
          </p>
          {verify.phase === 'ok' ? (
            <p className={css.success}>{t('config.verify.ok', { dims: verify.dimensions !== undefined ? t('config.verify.dimensions', { dims: verify.dimensions }) : '' })}</p>
          ) : null}
          {verify.phase === 'failed' ? (
            <div className={css.error}>
              <p style={{ margin: 0 }}>{verify.result.hint ?? t('config.verify.failed')}</p>
              {verify.result.code === 'NO_PERMISSION' && verify.result.applyUrl ? (
                <div className={css.errorDetail}>
                  <button type="button" className={css.link} onClick={() => { void copyApplyUrl(verify.result.applyUrl!) }}>
                    {copied ? t('common.copied') : t('config.copyApplyUrl')}
                  </button>
                  <span className={css.hint}>{t('config.permissionHint', { model: embeddingModel })}</span>
                </div>
              ) : null}
            </div>
          ) : null}
          {!credential.writable ? (
            <p className={css.hint}>{t('config.envKeyReadOnly')}</p>
          ) : null}
        </div>

        <div className={css.field}>
          <label className={css.label} htmlFor="oc-embedding-model">{t('config.embeddingModel')}</label>
          <div className={css.row}>
            <select
              id="oc-embedding-model"
              className={css.select}
              value={embeddingDraft}
              disabled={!editable || settingsBusy} onChange={event => setEmbeddingDraft(event.target.value)}
            >
              {MODEL_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.labelKey === null ? option.id : t(option.labelKey)}</option>)}
            </select>
            {isOverridden(snapshot, 'embeddingModel') ? <span className={css.overridden}>{t('config.overridden')}</span> : null}
          </div>
          <p className={css.hint}>{t('config.embeddingHint')}</p>
        </div>

        <div className={css.automation}>
          <span className={css.automationTitle}>{t('config.automation')}</span>
          {keyMissing ? <p className={css.hint}>{t('config.automationHintNoKey')}</p> : null}

          <div className={css.switchRow}>
            <div className={css.switchText}>
              <label className={css.switchLabel} htmlFor="oc-capture-prompts">{t('config.switch.capture')}</label>
              <span className={css.switchSub}>{t('config.switch.captureHint')}</span>
            </div>
            <input
              id="oc-capture-prompts"
              type="checkbox"
              className={css.switch}
              checked={captureDraft}
              disabled={!editable || settingsBusy}
              onChange={event => setCaptureDraft(event.target.checked)}
            />
          </div>

          <div className={css.switchRow} title={keyMissingTitle}>
            <div className={css.switchText}>
              <label className={css.switchLabel} htmlFor="oc-distill-on-capture">{t('config.switch.distill')}</label>
              <span className={css.switchSub}>{t('config.switch.distillHint')}</span>
            </div>
            <input
              id="oc-distill-on-capture"
              type="checkbox"
              className={css.switch}
              checked={distillOnDraft}
              disabled={keyMissing || !editable || settingsBusy}
              onChange={event => setDistillOnDraft(event.target.checked)}
            />
          </div>

          <div className={css.switchRow}>
            <div className={css.switchText}>
              <label className={css.switchLabel} htmlFor="oc-ontology-enabled">{t('config.switch.ontology')}</label>
              <span className={css.switchSub}>{t('config.switch.ontologyHint')}</span>
            </div>
            <input id="oc-ontology-enabled" type="checkbox" className={css.switch} checked={ontologyDraft} disabled={!editable || settingsBusy} onChange={event => setOntologyDraft(event.target.checked)} />
          </div>

          <div className={css.switchRow}>
            <div className={css.switchText}>
              <label className={css.switchLabel} htmlFor="oc-memory-layering-enabled">{t('config.switch.layering')}</label>
              <span className={css.switchSub}>{t('config.switch.layeringHint')}</span>
            </div>
            <input id="oc-memory-layering-enabled" type="checkbox" className={css.switch} checked={layeringDraft} disabled={!editable || settingsBusy} onChange={event => setLayeringDraft(event.target.checked)} />
          </div>

          <div className={css.switchRow}>
            <div className={css.switchText}>
              <label className={css.switchLabel} htmlFor="oc-auto-consolidate">{t('config.switch.consolidate')}</label>
              <span className={css.switchSub}>{t('config.switch.consolidateHint')}</span>
            </div>
            <input id="oc-auto-consolidate" type="checkbox" className={css.switch} checked={consolidateDraft} disabled={!layeringDraft || !editable || settingsBusy} onChange={event => setConsolidateDraft(event.target.checked)} />
          </div>

          <div className={css.row}>
            <div className={css.field} style={{ flex: 1 }}>
              <label className={css.label} htmlFor="oc-working-memory-hours">{t('config.retention.workingHours')}</label>
              <input id="oc-working-memory-hours" className={css.input} type="number" min="1" max="168" step="1" value={workingHoursDraft} disabled={!layeringDraft || !editable || settingsBusy} onChange={event => setWorkingHoursDraft(event.target.value)} />
            </div>
            <div className={css.field} style={{ flex: 1 }}>
              <label className={css.label} htmlFor="oc-episodic-memory-days">{t('config.retention.episodicDays')}</label>
              <input id="oc-episodic-memory-days" className={css.input} type="number" min="1" max="3650" step="1" value={episodicDaysDraft} disabled={!layeringDraft || !editable || settingsBusy} onChange={event => setEpisodicDaysDraft(event.target.value)} />
            </div>
          </div>
          {!retentionValid ? <p className={css.error} role="alert">{t('config.retention.invalid')}</p> : null}

          <div className={css.switchRow}>
            <div className={css.switchText}>
              <label className={css.switchLabel} htmlFor="oc-recall-enabled">{t('config.switch.recall')}</label>
              <span className={css.switchSub}>{t('config.switch.recallHint')}</span>
            </div>
            <input id="oc-recall-enabled" type="checkbox" className={css.switch} checked={recallDraft} disabled={!editable || settingsBusy} onChange={event => setRecallDraft(event.target.checked)} />
          </div>

          <div className={css.field} title={keyMissingTitle}>
            <label className={css.label} htmlFor="oc-distill-model">{t('config.distillModel')}</label>
            <div className={css.row}>
              <input
                id="oc-distill-model"
                type="text"
                list="oc-distill-models"
                className={css.input}
                value={distillDraft}
                disabled={keyMissing || !editable || settingsBusy}
                placeholder={models?.auto ? t('config.modelAuto', { model: models.auto }) : t('config.modelAutoShort')}
                onChange={event => setDistillDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Escape') setDistillDraft(distillModel) }}
              />
              <datalist id="oc-distill-models">
                {(models?.models ?? []).map(model => <option key={model} value={model} />)}
              </datalist>
              {isOverridden(snapshot, 'distillModel') ? <span className={css.overridden}>{t('config.overridden')}</span> : null}
            </div>
            {models?.error !== undefined ? (
              <p className={css.hint}>
                {t('config.modelsUnavailable', { hint: models.hint ?? models.error })}
                {models.applyUrl !== undefined ? (
                  <>
                    {'（'}
                    <button type="button" className={css.link} onClick={() => { void copyApplyUrl(models.applyUrl!) }}>
                      {copied ? t('common.copied') : t('config.copyApplyUrl')}
                    </button>
                    {'）'}
                  </>
                ) : null}
              </p>
            ) : models === null ? (
              <p className={css.hint}>{t('config.modelsUnavailableCache')}</p>
            ) : (
              <p className={css.hint}>{t('config.modelsHint')}</p>
            )}
          </div>
        </div>

        {settingsDirty ? <div className={css.saveBar}><span className={css.hint}>{t('config.dirty')}</span><Button variant="ghost" disabled={settingsBusy} onClick={cancelSettingsDraft}>{t('common.cancel')}</Button><Button variant="primary" disabled={settingsBusy || snapshot.revision === undefined || !retentionValid || !scopeIdsValid} onClick={() => { void saveSettingsDraft() }}>{settingsBusy ? t('common.saving') : t('config.saveSettings')}</Button></div> : null}

        <button type="button" disabled={!editable || settingsBusy} className={`${css.link} ${css.advancedToggle}`} onClick={() => setAdvancedOpen(open => !open)}>
          {advancedOpen ? t('config.advanced.collapse') : t('config.advanced.expand')}
        </button>
        {advancedOpen ? (
          <div className={css.advanced}>
            <div className={css.field}>
              <span className={css.label}>{t('config.scope.title')}</span>
              <p className={css.hint}>{t('config.scope.hint')}</p>
              <div className={css.row}>
                <input id="oc-scope-user-id" aria-label={t('aria.scopeUser')} className={css.input} value={scopeUserDraft} disabled={!editable||settingsBusy} placeholder={t('config.scope.userPlaceholder')} onChange={event=>setScopeUserDraft(event.target.value)}/>
                <input id="oc-scope-agent-id" aria-label={t('aria.scopeAgent')} className={css.input} value={scopeAgentDraft} disabled={!editable||settingsBusy} placeholder={t('config.scope.agentPlaceholder')} onChange={event=>setScopeAgentDraft(event.target.value)}/>
                <input id="oc-scope-app-id" aria-label={t('aria.scopeApp')} className={css.input} value={scopeAppDraft} disabled={!editable||settingsBusy} placeholder={t('config.scope.appPlaceholder')} onChange={event=>setScopeAppDraft(event.target.value)}/>
              </div>
              {!scopeIdsValid?<p className={css.error} role="alert">{t('config.scope.invalid')}</p>:null}
            </div>
            <div className={css.field}>
              <span className={css.label}>{t('config.credentialRef')}</span>
              <code className={css.meta}>{apiKeyEnv}</code>
              <p className={css.hint}>{t('config.credentialRefHint')}</p>
            </div>
            <div className={css.field}>
              <span className={css.label}>{t('config.gatewayEndpoint')}</span>
              <code className={css.meta}>{embeddingBaseUrl}</code>
              <p className={css.hint}>
                {t('config.gatewayEndpointHint')}
                {t('config.gatewayMigration')}
              </p>
            </div>
          </div>
        ) : null}
      </section>
      {workbenchDialog}
    </>
  )
}