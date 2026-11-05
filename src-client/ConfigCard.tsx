/**
 * agentOS context 独立记忆设置页（兼容 dsh-opencontext 配置命名空间）。
 *
 * 草稿 key 通过 authenticated Connection RPC 在固定网关验证，成功后才写入
 * credentials；密钥字面量永不回显。普通设置采用 SettingsScope 草稿和单次
 * revision-fenced mutate 保存，高级字段提供独立保存/重置。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from './ui-primitives.tsx'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelsResult, OcApi, VerifyKeyResult } from './api.ts'
import type { ContextApi } from './context-api.ts'
import { ContextModal } from './ContextModal.tsx'
import { ContextWorkbench } from './ContextWorkbench.tsx'
import css from './ConfigCard.module.css'

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
  { id: 'bgem3-embedding', label: 'bgem3-embedding（BGE-M3 多语言，默认）' },
  { id: 'qwen3-embedding-06b', label: 'qwen3-embedding-06b' },
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

  const refreshCredential = useCallback(async (ref: string) => {
    const epoch = ++credentialEpoch.current
    try { const next = await api.describeCredential(ref); if (epoch === credentialEpoch.current) setCredential(next) }
    catch { /* describe 失败保持现状 */ }
  }, [api])
  useEffect(() => () => { credentialEpoch.current++ }, [])

  useEffect(() => { if (snapshot.status === 'ready') void refreshCredential(apiKeyEnv) }, [apiKeyEnv, refreshCredential, snapshot.status])
  useEffect(() => {
    if (snapshot.status !== 'ready') return
    return props.subscribeCredentialsUpdated?.((ref) => { if (ref === apiKeyEnv) void refreshCredential(ref) })
  }, [props, apiKeyEnv, refreshCredential, snapshot.status])

  const checkAndSave = async () => {
    if (!editable || settingsBusy) return
    const key = draft.trim()
    if (!key) return
    setVerify({ phase: 'checking' })
    setSettingsBusy(true)
    try {
      const result = await api.verifyKey({ apiKey: key })
      if (result.ok) {
        await api.setCredential(apiKeyEnv, key)
        setDraft('')
        setVerify(result.dimensions === undefined ? { phase: 'ok' } : { phase: 'ok', dimensions: result.dimensions })
        await refreshCredential(apiKeyEnv)
      } else {
        setVerify({ phase: 'failed', result })
      }
    } catch {
      setVerify({ phase: 'failed', result: { ok: false, code: 'NETWORK', hint: '检查失败，请确认网络与配置后重试' } })
    } finally {
      setSettingsBusy(false)
    }
  }

  const copyApplyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用时不阻塞
    }
  }

  // 提炼需要密钥；自动记忆开关始终可用，以便无密钥时明确关闭后续捕获。
  const keyMissing = !credential.configured
  const keyMissingTitle = keyMissing ? '请先在上方配置网关密钥' : undefined

  const writeSetting = async (operation: () => Promise<boolean | void>) => {
    if (!editable || settingsBusy) return false
    setSettingsBusy(true)
    setSettingsError('')
    try {
      const accepted = await operation()
      if (accepted === false) {
        setSettingsError('设置保存失败或内容已被其他窗口更新，请刷新后重试')
        return false
      }
      return true
    }
    catch { setSettingsError('设置保存失败或内容已被其他窗口更新，请刷新后重试'); return false }
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
  const workbenchDialog = <ContextModal open={workbenchOpen} onClose={closeWorkbench} title="完整记忆工作台" headless className={css.workbenchDialog}>
    <div className={css.workbenchDialogBody}><ContextWorkbench api={contextApi} onClose={closeWorkbench} /></div>
  </ContextModal>

  if (snapshot.status !== 'ready') return (
    <>
      <section className={css.card} data-opencontext-config-card>
        <div className={css.header}>
          <div>
            <h3 className={css.title}>agentOS context</h3>
            <p className={css.description}>会话记忆、来源证据与受控关系（兼容 OpenContext 数据）</p>
          </div>
        </div>
        <p className={snapshot.status === 'loading' ? css.hint : css.error}>{snapshot.status === 'loading' ? '正在读取插件设置…' : '当前设置文档不可用；不会把默认值当成已保存配置。'}</p>
        <div className={css.managerRow}><div><span className={css.label}>记忆管理</span><p className={css.hint}>记忆数据面与设置文档独立，可继续查看现有记忆。</p></div><Button id="oc-open-workbench" variant="outline" onClick={() => setWorkbenchOpen(true)}>打开记忆工作台</Button></div>
      </section>
      {workbenchDialog}
    </>
  )

  const badge = credential.configured
    ? verify.phase === 'ok'
      ? { text: '已配置 · 有权限', cls: css.badgeOk }
      : { text: '已配置', cls: css.badgeOk }
    : verify.phase === 'failed' && verify.result.code === 'NO_PERMISSION'
      ? { text: '无权限', cls: css.badgeWarn }
      : { text: '未配置', cls: css.badgeMuted }

  return (
    <>
      <section className={css.card} data-opencontext-config-card>
        <div className={css.header}>
          <div>
            <h3 className={css.title}>agentOS context</h3>
            <p className={css.description}>会话记忆、来源证据与受控关系（兼容 OpenContext 数据）</p>
          </div>
          <div className={css.headerActions}>
            <span className={`${css.badge} ${badge.cls}`}>{badge.text}</span>
            <Button id="oc-open-workbench" variant="outline" onClick={() => setWorkbenchOpen(true)}>打开记忆工作台</Button>
          </div>
        </div>

        {settingsError ? <p className={css.error} role="alert">{settingsError}</p> : null}
        {!snapshot.writable ? <p className={css.hint}>当前设置文档只读，所有配置操作已禁用。</p> : null}

        <div className={css.field}>
          <label className={css.label} htmlFor="oc-api-key">网关密钥（{apiKeyEnv}）</label>
          <div className={css.row}>
            <input
              id="oc-api-key"
              type="password"
              value={draft}
              disabled={!credential.writable || !editable || settingsBusy}
              placeholder={credential.configured ? '已保存（输入新密钥可替换）' : '请输入网关密钥（可选，用于提炼/语义增强）'}
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
              {verify.phase === 'checking' ? '正在检查…' : '检查并保存'}
            </Button>
          </div>
          <p className={css.hint}>
            启用提炼或语义索引后，待处理文本会连同 Bearer 凭据发送到上方锁定的模型网关；自动记忆默认开启。
            提炼服务暂不可用时，原文仅作为低重要度、{workingMemoryHours} 小时有效的本地工作记忆保存，避免内容静默丢失。
          </p>
          {verify.phase === 'ok' ? (
            <p className={css.success}>密钥验证通过并已保存{verify.dimensions !== undefined ? `（${verify.dimensions} 维）` : ''}。记忆与知识库将使用公司 embedding。</p>
          ) : null}
          {verify.phase === 'failed' ? (
            <div className={css.error}>
              <p style={{ margin: 0 }}>{verify.result.hint ?? '验证失败'}</p>
              {verify.result.code === 'NO_PERMISSION' && verify.result.applyUrl ? (
                <div className={css.errorDetail}>
                  <button type="button" className={css.link} onClick={() => { void copyApplyUrl(verify.result.applyUrl!) }}>
                    {copied ? '已复制 ✓' : '复制申请地址'}
                  </button>
                  <span className={css.hint}>请确认密钥拥有 {embeddingModel} 权限后重试</span>
                </div>
              ) : null}
            </div>
          ) : null}
          {!credential.writable ? (
            <p className={css.hint}>当前密钥来自环境层（只读），请改用环境变量管理。</p>
          ) : null}
        </div>

        <div className={css.field}>
          <label className={css.label} htmlFor="oc-embedding-model">Embedding 模型</label>
          <div className={css.row}>
            <select
              id="oc-embedding-model"
              className={css.select}
              value={embeddingDraft}
              disabled={!editable || settingsBusy} onChange={event => setEmbeddingDraft(event.target.value)}
            >
              {MODEL_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            {isOverridden(snapshot, 'embeddingModel') ? <span className={css.overridden}>已覆盖</span> : null}
          </div>
          <p className={css.hint}>两个模型均为 1024 维；切换模型后新写入的记忆用新模型，旧向量按维度分表互不影响。</p>
        </div>

        <div className={css.automation}>
          <span className={css.automationTitle}>记忆自动化</span>
          {keyMissing ? <p className={css.hint}>未配置密钥时，内容仍会作为短期本地工作记忆保存；你也可以关闭自动记忆，让后续提示完全不落库。</p> : null}

          <div className={css.switchRow}>
            <div className={css.switchText}>
              <label className={css.switchLabel} htmlFor="oc-capture-prompts">自动记忆</label>
              <span className={css.switchSub}>关掉后捕获完全不落库——最大降本</span>
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
              <label className={css.switchLabel} htmlFor="oc-distill-on-capture">写入前提炼</label>
              <span className={css.switchSub}>消耗少量模型调用，把消息提炼成事实再入库</span>
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
              <label className={css.switchLabel} htmlFor="oc-ontology-enabled">关联理解</label>
              <span className={css.switchSub}>按对象、证据和受控关系整理新记忆</span>
            </div>
            <input id="oc-ontology-enabled" type="checkbox" className={css.switch} checked={ontologyDraft} disabled={!editable || settingsBusy} onChange={event => setOntologyDraft(event.target.checked)} />
          </div>

          <div className={css.switchRow}>
            <div className={css.switchText}>
              <label className={css.switchLabel} htmlFor="oc-memory-layering-enabled">自动分层</label>
              <span className={css.switchSub}>按工作、情节、语义、程序四层管理保存期限和召回范围</span>
            </div>
            <input id="oc-memory-layering-enabled" type="checkbox" className={css.switch} checked={layeringDraft} disabled={!editable || settingsBusy} onChange={event => setLayeringDraft(event.target.checked)} />
          </div>

          <div className={css.switchRow}>
            <div className={css.switchText}>
              <label className={css.switchLabel} htmlFor="oc-auto-consolidate">自动强化与晋升</label>
              <span className={css.switchSub}>重复证据增强可信度；近似冲突只生成候选，不覆盖旧事实</span>
            </div>
            <input id="oc-auto-consolidate" type="checkbox" className={css.switch} checked={consolidateDraft} disabled={!layeringDraft || !editable || settingsBusy} onChange={event => setConsolidateDraft(event.target.checked)} />
          </div>

          <div className={css.row}>
            <div className={css.field} style={{ flex: 1 }}>
              <label className={css.label} htmlFor="oc-working-memory-hours">工作记忆保留小时</label>
              <input id="oc-working-memory-hours" className={css.input} type="number" min="1" max="168" step="1" value={workingHoursDraft} disabled={!layeringDraft || !editable || settingsBusy} onChange={event => setWorkingHoursDraft(event.target.value)} />
            </div>
            <div className={css.field} style={{ flex: 1 }}>
              <label className={css.label} htmlFor="oc-episodic-memory-days">情节记忆保留天数</label>
              <input id="oc-episodic-memory-days" className={css.input} type="number" min="1" max="3650" step="1" value={episodicDaysDraft} disabled={!layeringDraft || !editable || settingsBusy} onChange={event => setEpisodicDaysDraft(event.target.value)} />
            </div>
          </div>
          {!retentionValid ? <p className={css.error} role="alert">工作记忆须为 1–168 小时，情节记忆须为 1–3650 天。</p> : null}

          <div className={css.switchRow}>
            <div className={css.switchText}>
              <label className={css.switchLabel} htmlFor="oc-recall-enabled">回答时使用记忆</label>
              <span className={css.switchSub}>关闭只停止后续召回，不删除已有记忆</span>
            </div>
            <input id="oc-recall-enabled" type="checkbox" className={css.switch} checked={recallDraft} disabled={!editable || settingsBusy} onChange={event => setRecallDraft(event.target.checked)} />
          </div>

          <div className={css.field} title={keyMissingTitle}>
            <label className={css.label} htmlFor="oc-distill-model">提炼模型</label>
            <div className={css.row}>
              <input
                id="oc-distill-model"
                type="text"
                list="oc-distill-models"
                className={css.input}
                value={distillDraft}
                disabled={keyMissing || !editable || settingsBusy}
                placeholder={models?.auto ? `自动（${models.auto}）` : '自动'}
                onChange={event => setDistillDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Escape') setDistillDraft(distillModel) }}
              />
              <datalist id="oc-distill-models">
                {(models?.models ?? []).map(model => <option key={model} value={model} />)}
              </datalist>
              {isOverridden(snapshot, 'distillModel') ? <span className={css.overridden}>已覆盖</span> : null}
            </div>
            {models?.error !== undefined ? (
              <p className={css.hint}>
                模型列表暂不可用：{models.hint ?? models.error}
                {models.applyUrl !== undefined ? (
                  <>
                    {'（'}
                    <button type="button" className={css.link} onClick={() => { void copyApplyUrl(models.applyUrl!) }}>
                      {copied ? '已复制 ✓' : '复制申请地址'}
                    </button>
                    {'）'}
                  </>
                ) : null}
              </p>
            ) : models === null ? (
              <p className={css.hint}>模型列表不可用（宿主 RPC 通道未就绪）；仍可手动输入模型名，留空 = 自动。</p>
            ) : (
              <p className={css.hint}>留空 = 自动选择；候选来自网关 /models（chat 模型）。</p>
            )}
          </div>
        </div>

        {settingsDirty ? <div className={css.saveBar}><span className={css.hint}>有尚未保存的设置</span><Button variant="ghost" disabled={settingsBusy} onClick={cancelSettingsDraft}>取消</Button><Button variant="primary" disabled={settingsBusy || snapshot.revision === undefined || !retentionValid || !scopeIdsValid} onClick={() => { void saveSettingsDraft() }}>{settingsBusy ? '保存中…' : '保存设置'}</Button></div> : null}

        <button type="button" disabled={!editable || settingsBusy} className={`${css.link} ${css.advancedToggle}`} onClick={() => setAdvancedOpen(open => !open)}>
          {advancedOpen ? '收起高级设置 ▴' : '高级设置 ▾'}
        </button>
        {advancedOpen ? (
          <div className={css.advanced}>
            <div className={css.field}>
              <span className={css.label}>多维记忆范围（可选）</span>
              <p className={css.hint}>留空时不会虚构身份范围。Agent 未填写时可使用当前会话可信的 Agent 预设；自动捕获仍写入工作区。</p>
              <div className={css.row}>
                <input id="oc-scope-user-id" aria-label="用户记忆标识" className={css.input} value={scopeUserDraft} disabled={!editable||settingsBusy} placeholder="用户标识" onChange={event=>setScopeUserDraft(event.target.value)}/>
                <input id="oc-scope-agent-id" aria-label="Agent 记忆标识" className={css.input} value={scopeAgentDraft} disabled={!editable||settingsBusy} placeholder="Agent 标识" onChange={event=>setScopeAgentDraft(event.target.value)}/>
                <input id="oc-scope-app-id" aria-label="应用记忆标识" className={css.input} value={scopeAppDraft} disabled={!editable||settingsBusy} placeholder="应用标识" onChange={event=>setScopeAppDraft(event.target.value)}/>
              </div>
              {!scopeIdsValid?<p className={css.error} role="alert">范围标识不能包含控制字符，且不能超过 512 个字符。</p>:null}
            </div>
            <div className={css.field}>
              <span className={css.label}>凭证引用名（受主机锁定）</span>
              <code className={css.meta}>{apiKeyEnv}</code>
              <p className={css.hint}>为防止把凭证转发到非受信端点，此引用只能由启动时的受信配置或环境变量确定；请在 DSH 凭证库中更新该引用的值。</p>
            </div>
            <div className={css.field}>
              <span className={css.label}>Embedding 网关（受信固定端点）</span>
              <code className={css.meta}>{embeddingBaseUrl}</code>
              <p className={css.hint}>
                默认仅允许固定公司内网兼容地址（HTTP）和本机地址；其他地址必须是启动时批准的 HTTPS 端点。
                迁移网关请由管理员通过 OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES 与启动配置完成。
              </p>
            </div>
          </div>
        ) : null}
      </section>
      {workbenchDialog}
    </>
  )
}