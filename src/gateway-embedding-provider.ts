/**
 * model gateway embedding provider (per-call credential resolve).
 *
 * 模型网关通路：
 *   POST {embeddingBaseUrl}/bge/embeddings  (非标路径，/v1/embeddings 是 404)
 *   Authorization: Bearer <AGENTOS_CONTEXT_API_KEY>  body: {model, input: string[]}
 *   200 → {data: [{embedding, index}]}; 错误在响应体 JSON code 字段:
 *     803 = apiKey 不合法, 804 = apiKey 无该模型权限（）
 *
 * 密钥不固化：每次调用经 cordis `credentials` 服务按次 resolve（llm-pi-ai
 * 先例，轮换即时生效）；服务缺席时回退 process.env[apiKeyEnv]。
 */

import { assertTrustedGatewayBase } from './gateway-policy.js'

export interface GatewayEmbeddingConfig {
  embeddingBaseUrl: string
  embeddingModel: string
  apiKeyEnv: string
  embeddingBatchSize: number
  embeddingTimeoutMs: number
}

interface CredentialsSeam {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

export interface GatewayEmbeddingContext {
  credentials?: CredentialsSeam
  /** ctx.get('credentials') shape is also accepted (cordis service lookup). */
  get?(name: 'credentials'): CredentialsSeam | undefined
}

const APPLY_URL = ''
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const retryDelay = (attempt: number) => new Promise(resolve => setTimeout(resolve, 200 * attempt))

export class GatewayEmbeddingError extends Error {
  code: string
  applyUrl?: string | undefined
  constructor(code: string, message: string, applyUrl?: string) {
    super(message)
    this.name = 'GatewayEmbeddingError'
    this.code = code
    this.applyUrl = applyUrl
  }
}

export function createGatewayEmbeddingProvider(
  ctx: GatewayEmbeddingContext,
  config: GatewayEmbeddingConfig,
  options: { fetcher?: typeof fetch } = {},
) {
  let dimensions: number | undefined
  const credentialRef = config.apiKeyEnv
  const fetcher = options.fetcher ?? fetch

  async function readKey(): Promise<string | undefined> {
    const credentials = ctx.credentials ?? ctx.get?.('credentials')
    return credentials !== undefined
      ? (await credentials.resolve(credentialRef))?.value
      : process.env[credentialRef]
  }

  async function resolveKey(): Promise<string> {
    const hit = await readKey()
    if (hit !== undefined && hit.length > 0) return hit
    throw new GatewayEmbeddingError(
      'EMBEDDING_KEY_MISSING',
      `未配置 ${credentialRef}：请到 设置 → agentOS context 填入模型网关密钥`,
    )
  }

  async function embedBatch(texts: string[]): Promise<number[][]> {
    const base = assertTrustedGatewayBase(config.embeddingBaseUrl)
    const key = await resolveKey()
    let response: Response | undefined
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await fetcher(`${base}/bge/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: config.embeddingModel, input: texts }),
          signal: AbortSignal.timeout(config.embeddingTimeoutMs),
          redirect: 'error',
        })
        if (response.ok) break
        const body = await response.json().catch(() => ({})) as { code?: number }
        if (body.code === 803) throw new GatewayEmbeddingError('EMBEDDING_KEY_INVALID', '密钥不合法，请重新填写')
        if (body.code === 804) {
          throw new GatewayEmbeddingError(
            'EMBEDDING_NO_PERMISSION',
            `当前密钥没有 ${config.embeddingModel} 模型权限，请确认密钥拥有该模型权限`,
            APPLY_URL,
          )
        }
        if (!RETRYABLE_STATUS.has(response.status) || attempt === 3) {
          throw new GatewayEmbeddingError('EMBEDDING_UPSTREAM', `embedding 网关异常（HTTP ${response.status}）`)
        }
      }
      catch (error) {
        if (error instanceof GatewayEmbeddingError || attempt === 3) {
          if (error instanceof GatewayEmbeddingError) throw error
          throw new GatewayEmbeddingError('EMBEDDING_UPSTREAM', 'embedding 网关暂时无法连接')
        }
      }
      await retryDelay(attempt)
    }
    if (!response?.ok) throw new GatewayEmbeddingError('EMBEDDING_UPSTREAM', 'embedding 网关暂时无法连接')
    const data = await response.json() as { data: { embedding: number[]; index?: number }[] }
    const rows = data.data
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map(d => d.embedding)
    dimensions = rows[0]?.length ?? dimensions
    return rows
  }

  return {
    getModelName: () => config.embeddingModel,
    getDimensions: () => dimensions,
    // Callers use this cheap capability probe to select lexical fallback
    // before constructing an upstream semantic-search request. It resolves on
    // every operation, so adding or rotating the credential takes effect
    // without restarting DSH and the secret is never retained here.
    isConfigured: async () => {
      try {
        const hit = await readKey()
        return hit !== undefined && hit.length > 0
      }
      catch {
        return false
      }
    },
    embedQuery: async (text: string) => (await embedBatch([text]))[0],
    embedDocuments: async (texts: string[]) => {
      const out: number[][] = []
      for (let i = 0; i < texts.length; i += config.embeddingBatchSize) {
        out.push(...await embedBatch(texts.slice(i, i + config.embeddingBatchSize)))
      }
      return out
    },
  }
}

export type GatewayEmbeddingProvider = ReturnType<typeof createGatewayEmbeddingProvider>
