/** Authenticated RPC helpers for credential verification and model discovery. */
import { assertTrustedGatewayBase } from './gateway-policy.js'

const APPLY_URL = ''
const invalid = (): Error & { code: 'INVALID_INPUT' } => Object.assign(
  new Error('请求字段不正确'),
  { code: 'INVALID_INPUT' as const },
)

export interface VerifyKeyConfig {
  embeddingBaseUrl: string
  embeddingModel: string
  apiKeyEnv: string
  embeddingTimeoutMs: number
}

export interface ModelsRouteConfig {
  apiKeyEnv: string
  distillModel: string
  embeddingBaseUrl: string
}

interface CredentialsSeam {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

interface DistillerSeam {
  listChatModels(): Promise<string[]>
  resolveChatModel(): Promise<string>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function gateway(base: string): string {
  try {
    return `${assertTrustedGatewayBase(base)}/bge/embeddings`
  } catch {
    throw invalid()
  }
}

function payload(value: unknown): { apiKey: string } {
  const input = record(value)
  if (
    input === undefined
    || Object.keys(input).some(key => key !== 'apiKey')
    || typeof input.apiKey !== 'string'
    || input.apiKey.trim().length === 0
    || input.apiKey.length > 8192
  ) throw invalid()
  return { apiKey: input.apiKey.trim() }
}

function errorCode(error: unknown): string | undefined {
  const details = record(error)
  return typeof details?.code === 'string' ? details.code : undefined
}

export async function verifyDraftKey(
  request: unknown,
  config: VerifyKeyConfig,
  fetcher: typeof fetch = fetch,
  caller?: AbortSignal,
) {
  const { apiKey } = payload(request)
  try {
    const signal = caller === undefined
      ? AbortSignal.timeout(config.embeddingTimeoutMs)
      : AbortSignal.any([caller, AbortSignal.timeout(config.embeddingTimeoutMs)])
    const response = await fetcher(gateway(config.embeddingBaseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: config.embeddingModel, input: ['.'] }),
      signal,
      redirect: 'error',
    })
    const raw: unknown = await response.json().catch(() => ({}))
    const body = record(raw) ?? {}
    const code = typeof body.code === 'number' ? body.code : undefined
    const data = Array.isArray(body.data) ? body.data : []
    const first = record(data[0])
    const embedding = Array.isArray(first?.embedding) ? first.embedding : undefined
    if (response.ok) return { ok: true, code: 'OK', dimensions: embedding?.length }
    if (code === 803) return { ok: false, code: 'KEY_INVALID', hint: '密钥不合法，请重新填写' }
    if (code === 804) {
      return {
        ok: false,
        code: 'NO_PERMISSION',
        hint: '当前密钥没有所需模型权限，请确认密钥拥有该模型权限',
        applyUrl: APPLY_URL,
      }
    }
    return { ok: false, code: 'UPSTREAM', hint: '模型网关暂不可用' }
  } catch (error: unknown) {
    if (errorCode(error) === 'INVALID_INPUT') throw error
    return { ok: false, code: 'NETWORK', hint: '模型网关暂不可达' }
  }
}

export async function listConfiguredModels(
  credentials: CredentialsSeam,
  config: ModelsRouteConfig,
  distiller: DistillerSeam,
) {
  const configured = config.distillModel || null
  const runtime = { apiKeyEnv: config.apiKeyEnv, embeddingBaseUrl: config.embeddingBaseUrl }
  let key: string | undefined
  try {
    key = (await credentials.resolve(config.apiKeyEnv))?.value
  } catch (_error) {
    // Credential-provider failure is presented as an unavailable key to this read-only discovery route.
  }
  if (key === undefined || key.length === 0) {
    return { keyConfigured: false, models: [], auto: null, configured, ...runtime }
  }
  try {
    const models = await distiller.listChatModels()
    const auto = configured === null ? await distiller.resolveChatModel() : null
    return { keyConfigured: true, models, auto, configured, ...runtime }
  } catch (error: unknown) {
    const safeCode = error instanceof Error
      && error.name === 'DistillError'
      && errorCode(error) !== undefined
      ? errorCode(error) ?? 'INTERNAL'
      : 'INTERNAL'
    return {
      keyConfigured: true,
      models: [],
      auto: null,
      configured,
      ...runtime,
      error: safeCode,
      hint: safeCode === 'DISTILL_NO_PERMISSION'
        ? '当前凭据没有模型权限'
        : '模型列表暂不可用',
      ...(safeCode === 'DISTILL_NO_PERMISSION' ? { applyUrl: APPLY_URL } : {}),
    }
  }
}
