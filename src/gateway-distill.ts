/**
 * M6: distillation client — extract long-term memories from user messages
 * via the model gateway chat model (per-call credential resolve).
 *
 * 模型网关通路：
 *   GET  {base}/models  Authorization: Bearer <AGENTOS_CONTEXT_API_KEY>
 *     → {data: [{id}]} — 11 个 chat 模型 + bgem3-embedding / qwen3-embedding-06b /
 *       qwen3-rerank-06b / web-search-v2（非 chat，须过滤）
 *   POST {base}/chat/completions  body {model, messages, max_tokens}
 *     → {choices: [{message: {content}}]}; 错误在响应体 JSON code 字段:
 *       803 = apiKey 不合法, 804 = apiKey 无该模型权限（）
 *
 * base = distillBaseUrl || embeddingBaseUrl（ distill 与 embedding 同网关时留空即可）。
 * 密钥不固化：每次调用经 cordis `credentials` 服务按次 resolve（同
 * gateway-embedding-provider，轮换即时生效）；服务缺席时回退 process.env[apiKeyEnv]。
 *
 * distillStructured() 返回经过边界校验的分层候选；distill() 保留旧的
 * string[] 契约。null = 模型输出不可用；capture 安全跳过，不回退保存原文。
 */

import { assertTrustedGatewayBase } from './gateway-policy.js'

export interface DistillConfig {
  embeddingBaseUrl: string
  apiKeyEnv: string
  distillModel: string
  distillBaseUrl: string
  distillTimeoutMs: number
  distillMaxTokens: number
}

interface CredentialsSeam {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

export interface DistillContext {
  credentials?: CredentialsSeam
  /** ctx.get('credentials') shape is also accepted (cordis service lookup). */
  get?(name: 'credentials'): CredentialsSeam | undefined
}

const APPLY_URL = ''
const NON_CHAT = /embedding|rerank|web-search/i
/** 自动选型偏好序：便宜/快的在前，命中在场者即用。 */
const PREFERENCE = [
  'saas-doubao-seed-20-lite',
  'saas-deepseek-v4-flash',
  'local-deepseek-v4-flash',
  'saas-qwen36-plus',
  'saas-glm-53',
  'saas-glm-52',
  'saas-glm-51',
  'saas-kimi-k26',
  'saas-kimi-k3',
  'saas-deepseek-v4-pro',
  'saas-doubao-seed-20-pro',
]

const SYSTEM_PROMPT = [
  '你是记忆提炼器。从「用户消息」中抽取值得保存的记忆。',
  '规则：',
  '- 没有长期价值（寒暄、一次性指令、对助手或插件本身的提问）→ 只输出 EMPTY',
  '- 有 → 只输出 JSON：{"memories":[{"content":"...","kind":"fact|decision|preference|constraint|outcome|plan|note","layer":"semantic|procedural","importance":0.0}],"entities":[{"name":"...","type":"Project|Person|Requirement|API|Service|Constraint|Decision|Document","aliases":[]}],"relations":[{"subject":"实体名称","predicate":"belongs_to|has_constraint|implements|assigned_to|depends_on|decided_by|related_to","object":"实体名称","quote":"用户消息中的逐字原文"}]}',
  '- semantic 保存稳定事实、偏好、决定和约束；procedural 只保存可复用的方法、流程与经验',
  '- importance 表示未来任务的重要程度，范围 0 到 1',
  '- 只有消息明确提到的对象才放入 entities；没有对象时输出空数组',
  '- relations 的 subject/object 必须与 entities.name 完全一致，quote 必须逐字复制用户消息；不确定就不要输出关系',
  '- 每条一句话（≤50字），第三人称陈述（如「用户偏好…」），不要保留指令语气',
  '- memories 最多 3 条，entities 和 relations 各最多 12 条',
].join('\n')

const KINDS = new Set(['fact', 'decision', 'preference', 'constraint', 'outcome', 'plan', 'note'])
const LAYERS = new Set(['semantic', 'procedural'])
const ENTITY_TYPES = new Set(['Project', 'Person', 'Requirement', 'API', 'Service', 'Constraint', 'Decision', 'Document'])
const PREDICATES = new Set(['belongs_to', 'has_constraint', 'implements', 'assigned_to', 'depends_on', 'decided_by', 'related_to'])
const DISTILL_RETRY_DELAYS_MS = [250, 750]
export interface DistilledMemory {
  content: string
  kind: 'fact' | 'decision' | 'preference' | 'constraint' | 'outcome' | 'plan' | 'note'
  layer: 'semantic' | 'procedural'
  importance: number
}
export interface DistilledEntity {
  name: string
  type: 'Project' | 'Person' | 'Requirement' | 'API' | 'Service' | 'Constraint' | 'Decision' | 'Document'
  aliases: string[]
}
export interface DistilledRelation {
  subject: string
  predicate: 'belongs_to' | 'has_constraint' | 'implements' | 'assigned_to' | 'depends_on' | 'decided_by' | 'related_to'
  object: string
  quote: string
}
export interface DistilledEnvelope {
  memories: DistilledMemory[]
  entities: DistilledEntity[]
  relations: DistilledRelation[]
}

export class DistillError extends Error {
  code: string
  applyUrl?: string | undefined
  constructor(code: string, message: string, applyUrl?: string) {
    super(message)
    this.name = 'DistillError'
    this.code = code
    this.applyUrl = applyUrl
  }
}

export function createDistiller(ctx: DistillContext, config: DistillConfig) {
  /** 同一实例 /models 只拉一次；失败不缓存（下次重试）。 */
  let chatModelsPromise: Promise<string[]> | undefined
  const credentialRef = config.apiKeyEnv

  const base = () => assertTrustedGatewayBase(config.distillBaseUrl || config.embeddingBaseUrl)

  async function resolveKey(): Promise<string> {
    const credentials = ctx.credentials ?? ctx.get?.('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(credentialRef))?.value
      : process.env[credentialRef]
    if (hit !== undefined && hit.length > 0) return hit
    throw new DistillError(
      'DISTILL_KEY_MISSING',
      `未配置 ${credentialRef}：请到 设置 → agentOS context 填入模型网关密钥`,
    )
  }

  const networkError = () =>
    new DistillError('DISTILL_NETWORK', '模型网关暂不可达')

  /** 200 路径的 body 读取：非 JSON → UPSTREAM；读取途中 abort/timeout → NETWORK。 */
  async function readJson(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : undefined
      if (name === 'AbortError' || name === 'TimeoutError') throw networkError()
      throw new DistillError('DISTILL_UPSTREAM', '网关响应非 JSON')
    }
  }

  function fetchChatModels(): Promise<string[]> {
    chatModelsPromise ??= (async () => {
      const gateway = base()
      const key = await resolveKey()
      const response = await fetch(`${gateway}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(config.distillTimeoutMs),
        redirect: 'error',
      }).catch(() => { throw networkError() })
      if (!response.ok) {
        // 与 chat 路径一致：803/804 在 body code 字段，需给用户可操作的报错。
        const body = await response.json().catch(() => ({})) as { code?: number }
        if (body.code === 803) {
          throw new DistillError('DISTILL_KEY_INVALID', '密钥不合法，请重新填写')
        }
        if (body.code === 804) {
          throw new DistillError('DISTILL_NO_PERMISSION', '当前密钥没有访问模型列表的权限，请确认密钥拥有该模型权限', APPLY_URL)
        }
        throw new DistillError('DISTILL_UPSTREAM', `模型列表异常（HTTP ${response.status}）`)
      }
      const data = await readJson(response) as { data?: ({ id?: string } | null)[] }
      return (data.data ?? [])
        .map(m => m?.id ?? '')
        .filter(id => id.length > 0 && !NON_CHAT.test(id))
    })().catch((error: unknown) => {
      chatModelsPromise = undefined
      throw error
    })
    return chatModelsPromise
  }

  /** 过滤后的 chat 模型全量列表（Task 6.5 models 路由用）。 */
  async function listChatModels(): Promise<string[]> {
    return [...await fetchChatModels()]
  }

  async function resolveChatModel(): Promise<string> {
    if (config.distillModel) return config.distillModel
    const ids = await fetchChatModels()
    const model = PREFERENCE.find(p => ids.includes(p)) ?? ids[0]
    if (model === undefined) {
      throw new DistillError('DISTILL_UPSTREAM', '密钥没有任何 chat 模型权限')
    }
    return model
  }

  const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))

  async function requestDistillation(
    gateway: string,
    key: string,
    model: string,
    sourceText: string,
  ): Promise<{ response: Response; data?: unknown }> {
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await fetch(`${gateway}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            max_tokens: config.distillMaxTokens,
            // Distillation is a short extraction task.  Keeping reasoning low
            // prevents reasoning-capable models from consuming the complete
            // output budget before they emit the required JSON object.
            reasoning_effort: 'low',
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: `用户消息：${sourceText}` },
            ],
          }),
          signal: AbortSignal.timeout(config.distillTimeoutMs),
          redirect: 'error',
        })
      } catch {
        const delay = DISTILL_RETRY_DELAYS_MS[attempt]
        if (delay !== undefined) {
          await wait(delay)
          continue
        }
        throw networkError()
      }
      const retryableStatus = response.status === 429 || response.status >= 500
      const retryDelay = DISTILL_RETRY_DELAYS_MS[attempt]
      if (retryableStatus && retryDelay !== undefined) {
        await response.body?.cancel().catch(() => undefined)
        await wait(retryDelay)
        continue
      }
      if (!response.ok) return { response }
      try {
        return { response, data: await readJson(response) }
      } catch (error) {
        const delay = DISTILL_RETRY_DELAYS_MS[attempt]
        if (error instanceof DistillError && error.code === 'DISTILL_NETWORK' && delay !== undefined) {
          await wait(delay)
          continue
        }
        throw error
      }
    }
  }

  async function distillEnvelope(text: string): Promise<DistilledEnvelope | null> {
    const sourceText = text.slice(0, 2000)
    const gateway = base()
    const [key, model] = await Promise.all([resolveKey(), resolveChatModel()])
    const { response, data: responseData } = await requestDistillation(gateway, key, model, sourceText)
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { code?: number }
      if (body.code === 803) {
        throw new DistillError('DISTILL_KEY_INVALID', '密钥不合法，请重新填写')
      }
      if (body.code === 804) {
        throw new DistillError(
          'DISTILL_NO_PERMISSION',
          `当前密钥没有 ${model} 权限，请确认密钥拥有该模型权限`,
          APPLY_URL,
        )
      }
      throw new DistillError('DISTILL_UPSTREAM', `蒸馏网关异常（HTTP ${response.status}）`)
    }
    const data = responseData as { choices?: { message?: { content?: string } }[] }
    const out = (data.choices?.[0]?.message?.content ?? '').trim()
    if (!out || out === 'EMPTY') return { memories: [], entities: [], relations: [] }
    const stripped = out.replace(/^```(?:json)?\s*|\s*```$/gi, '')
    if (stripped.trim() === 'EMPTY') return { memories: [], entities: [], relations: [] }
    try {
      const parsed = JSON.parse(stripped) as { memories?: unknown; entities?: unknown; relations?: unknown }
      if (!Array.isArray(parsed.memories)) return null
      const memories = parsed.memories
        .map((memory): DistilledMemory | null => {
          if (typeof memory === 'string') {
            const content = memory.trim().slice(0, 120)
            return content ? { content, kind: 'fact', layer: 'semantic', importance: 0.7 } : null
          }
          if (!memory || typeof memory !== 'object' || Array.isArray(memory)) return null
          const row = memory as Record<string, unknown>
          const content = typeof row.content === 'string' ? row.content.trim().slice(0, 120) : ''
          if (!content) return null
          const kind = typeof row.kind === 'string' && KINDS.has(row.kind) ? row.kind as DistilledMemory['kind'] : 'fact'
          const layer = typeof row.layer === 'string' && LAYERS.has(row.layer) ? row.layer as DistilledMemory['layer'] : 'semantic'
          const importance = typeof row.importance === 'number' && Number.isFinite(row.importance) ? Math.max(0, Math.min(1, row.importance)) : layer === 'procedural' ? 0.8 : 0.7
          return { content, kind, layer, importance }
        })
        .filter((memory): memory is DistilledMemory => memory !== null)
        .slice(0, 3)
      const entities = (Array.isArray(parsed.entities) ? parsed.entities : [])
        .map((entity): DistilledEntity | null => {
          if (!entity || typeof entity !== 'object' || Array.isArray(entity)) return null
          const row = entity as Record<string, unknown>
          const name = typeof row.name === 'string' ? row.name.trim().slice(0, 120) : ''
          if (!name || typeof row.type !== 'string' || !ENTITY_TYPES.has(row.type)) return null
          const aliases = (Array.isArray(row.aliases) ? row.aliases : [])
            .filter((alias): alias is string => typeof alias === 'string')
            .map(alias => alias.trim().slice(0, 120))
            .filter((alias, index, all) => alias.length > 0 && alias !== name && all.indexOf(alias) === index)
            .slice(0, 12)
          return { name, type: row.type as DistilledEntity['type'], aliases }
        })
        .filter((entity): entity is DistilledEntity => entity !== null)
        .filter((entity, index, all) => all.findIndex(candidate => candidate.name === entity.name) === index)
        .slice(0, 12)
      const entityNames = new Set(entities.map(entity => entity.name))
      const relations = (Array.isArray(parsed.relations) ? parsed.relations : [])
        .map((relation): DistilledRelation | null => {
          if (!relation || typeof relation !== 'object' || Array.isArray(relation)) return null
          const row = relation as Record<string, unknown>
          const subject = typeof row.subject === 'string' ? row.subject.trim() : ''
          const object = typeof row.object === 'string' ? row.object.trim() : ''
          const quote = typeof row.quote === 'string' ? row.quote.trim() : ''
          if (!subject || !object || subject === object || !entityNames.has(subject) || !entityNames.has(object)) return null
          if (typeof row.predicate !== 'string' || !PREDICATES.has(row.predicate)) return null
          if (!quote || quote.length > 1000 || !sourceText.includes(quote)) return null
          return { subject, predicate: row.predicate as DistilledRelation['predicate'], object, quote }
        })
        .filter((relation): relation is DistilledRelation => relation !== null)
        .slice(0, 12)
      return { memories, entities, relations }
    } catch {
      return null
    }
  }

  async function distillStructured(text: string): Promise<DistilledMemory[] | null> {
    const envelope = await distillEnvelope(text)
    return envelope === null ? null : envelope.memories
  }

  async function distill(text: string): Promise<string[] | null> {
    const rows = await distillStructured(text)
    return rows === null ? null : rows.map(row => row.content)
  }

  return { distill, distillStructured, distillEnvelope, resolveChatModel, listChatModels }
}

export type Distiller = ReturnType<typeof createDistiller>
