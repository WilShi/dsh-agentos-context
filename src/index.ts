import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import {
  apply as applyPlugin,
} from './plugin.js'
import { ConfigSchema } from './config.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Bounded memory or knowledge evidence recalled by agentOS Context.
     * Readers preserve the evidence and its source metadata even when this
     * producer is not installed.
     * @persistenceAttribution
     */
    'agentos-context': {
      readonly kind: 'agentos-context'
      readonly form: 'recall'
    }
  }
}

/** Loader name retained for existing Desktop profiles and plugin upgrades. */
export const name = 'dsh-agentos-context'

/** Host services required before the memory plugin activates. */
export const inject = [
  'tools',
  'agents',
  'agentDefaultModel',
  'systemPrompt',
  'commands',
  'llm',
  'sessions',
  'credentials',
  'connection',
]

/** Runtime-validated plugin configuration accepted by the Loader. */
export interface Config {
  /** Legacy OpenContext service base URL. */
  baseUrl?: string
  /** Credential-store reference for legacy HTTP authorization. */
  authorizationRef?: string
  /** Fixed scope override; an empty value derives the active Workspace scope. */
  scopeId?: string
  /** General backend-operation deadline in milliseconds. */
  timeoutMs?: number
  /** Interactive recall request deadline in milliseconds. */
  requestTimeoutMs?: number
  /** Maximum UTF-8 evidence bytes appended to one model request. */
  maxBytes?: number
  /** Whether accepted human prompts are captured automatically. */
  capturePrompts: Volatile<boolean>
  /** Whether capture requests an immediate legacy-backend flush. */
  flushOnCapture?: boolean
  /** Maximum memory records selected for one automatic recall. */
  maxRecallItems?: number
  /** Whether completed turns produce automatic summary memories. */
  autoSummarize?: boolean
  /** Whether successful tool results may be captured as memory. */
  captureToolResults?: boolean
  /** Whether tool-result capture includes outcome metadata. */
  captureToolOutcomes?: boolean
  /** Whether insight tools are registered. */
  enableInsights?: boolean
  /** Whether knowledge tools and document routes are registered. */
  enableKnowledge?: boolean
  /** Company embedding gateway base URL. */
  embeddingBaseUrl?: string
  /** Embedding model identifier sent to the configured gateway. */
  embeddingModel: Volatile<string>
  /** Credential-store reference used by embedding and distillation calls. */
  apiKeyEnv?: string
  /** Maximum texts sent in one embedding batch. */
  embeddingBatchSize?: number
  /** One embedding-request deadline in milliseconds. */
  embeddingTimeoutMs?: number
  /** Complete knowledge-indexing deadline in milliseconds. */
  knowledgeUploadTimeoutMs?: number
  /** Complete knowledge-search deadline in milliseconds. */
  knowledgeSearchTimeoutMs?: number
  /** Whether captured prompts are distilled before storage. */
  distillOnCapture: Volatile<boolean>
  /** Distillation model identifier; an empty value selects an available model. */
  distillModel: Volatile<string>
  /** Distillation gateway override; an empty value uses the embedding gateway. */
  distillBaseUrl?: string
  /** One distillation-request deadline in milliseconds. */
  distillTimeoutMs?: number
  /** Maximum output tokens requested for structured distillation. */
  distillMaxTokens?: number
  /** Whether semantic duplicate handling runs before a memory write. */
  dedupEnabled?: boolean
  /** Similarity at or above which an incoming memory is skipped. */
  dedupSkipThreshold?: number
  /** Similarity at or above which an incoming memory becomes a revision candidate. */
  dedupReviseThreshold?: number
  /** Absolute agentOS Context sidecar path; an empty value uses the managed default. */
  contextDbPath?: string
  /** Whether source-backed ontology extraction and graph operations are enabled. */
  ontologyEnabled: Volatile<boolean>
  /** Whether automatic prompt recall is enabled. */
  recallEnabled: Volatile<boolean>
  /** Whether the working, episodic, semantic and procedural hierarchy is enabled. */
  memoryLayeringEnabled: Volatile<boolean>
  /** Whether repeated evidence can reinforce and promote memory layers. */
  autoConsolidate: Volatile<boolean>
  /** Working-memory retention in hours. */
  workingMemoryHours: Volatile<number>
  /** Episodic-memory retention in days. */
  episodicMemoryDays: Volatile<number>
  /** Optional trusted user identity for a cross-Workspace user scope. */
  scopeUserId: Volatile<string>
  /** Optional trusted Agent identity for a cross-Workspace Agent scope. */
  scopeAgentId: Volatile<string>
  /** Optional trusted application identity for a cross-Workspace app scope. */
  scopeAppId: Volatile<string>
  /**
   * Opt-out of the identity-scope authorization introduced in 0.7.1. When true,
   * any user:/agent:/app: scope id the caller names is accepted (previous
   * behavior); workspace, run and global scopes are always available.
   */
  allowForeignScopeIds?: boolean
}

/** Schemastery validator used by Loader configuration and settings. */
export const Config = ConfigSchema

/**
 * Mount the memory, ontology, knowledge, command, tool, and RPC contributions.
 * @param ctx - Cordis context that owns every registered contribution.
 * @param config - Loader configuration validated by {@link Config}.
 * @returns a promise that settles after the Host capability is active.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await applyPlugin(ctx, config)
}
