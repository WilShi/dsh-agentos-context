/**
 * Config schema for dsh-opencontext.
 *
 * Resolved precedence (highest first):
 *   1. `cordis.patch.yml` row under `id: dsh-opencontext` (config block).
 *   2. `OPENCONTEXT_DSH_*` environment variables.
 *   3. Defaults declared in the schemastery schema below.
 *
 * Env→field mapping:
 *   OPENCONTEXT_DSH_BASE_URL         → baseUrl
 *   OPENCONTEXT_DSH_AUTHORIZATION_REF → authorizationRef (DSH credential reference)
 *   OPENCONTEXT_DSH_AUTHORIZATION remains a process-only legacy environment fallback and never enters settings.
 *   OPENCONTEXT_DSH_SCOPE_ID         → scopeId
 *   OPENCONTEXT_DSH_CAPTURE_PROMPTS  → capturePrompts (`1` / `0`)
 *   OPENCONTEXT_DSH_FLUSH_ON_CAPTURE → flushOnCapture (`1` / `0`)
 *   OPENCONTEXT_DSH_MAX_BYTES        → maxBytes
 *   OPENCONTEXT_DSH_MAX_RECALL_ITEMS → maxRecallItems
 *   OPENCONTEXT_DSH_TIMEOUT_MS       → timeoutMs
 *   OPENCONTEXT_DSH_REQUEST_TIMEOUT  → requestTimeoutMs
 *   OPENCONTEXT_DSH_AUTO_SUMMARIZE   → autoSummarize (`1` / `0`)
 *   OPENCONTEXT_DSH_CAPTURE_TOOL_RESULTS → captureToolResults (`1` / `0`)
 *   OPENCONTEXT_DSH_CAPTURE_TOOL_OUTCOMES → captureToolOutcomes (`1` / `0`)
 *   OPENCONTEXT_DSH_ENABLE_INSIGHTS → enableInsights (`1` / `0`)
 *   OPENCONTEXT_DSH_ENABLE_KNOWLEDGE → enableKnowledge (`1` / `0`)
 *   OPENCONTEXT_DSH_EMBEDDING_BASE_URL → embeddingBaseUrl
 *   OPENCONTEXT_DSH_EMBEDDING_MODEL    → embeddingModel
 *   OPENCONTEXT_DSH_API_KEY_ENV        → apiKeyEnv
 *   OPENCONTEXT_DSH_EMBEDDING_BATCH_SIZE → embeddingBatchSize
 *   OPENCONTEXT_DSH_EMBEDDING_TIMEOUT_MS → embeddingTimeoutMs
 *   OPENCONTEXT_DSH_KNOWLEDGE_UPLOAD_TIMEOUT_MS → knowledgeUploadTimeoutMs
 *   OPENCONTEXT_DSH_KNOWLEDGE_SEARCH_TIMEOUT_MS → knowledgeSearchTimeoutMs
 *   OPENCONTEXT_DSH_DISTILL_ON_CAPTURE   → distillOnCapture (`1` / `0`)
 *   OPENCONTEXT_DSH_DISTILL_MODEL        → distillModel ('' = auto-pick)
 *   OPENCONTEXT_DSH_DISTILL_BASE_URL     → distillBaseUrl ('' = fall back to embeddingBaseUrl)
 *   OPENCONTEXT_DSH_DISTILL_TIMEOUT_MS   → distillTimeoutMs
 *   OPENCONTEXT_DSH_DISTILL_MAX_TOKENS   → distillMaxTokens
 *   OPENCONTEXT_DSH_DEDUP_ENABLED        → dedupEnabled (`1` / `0`)
 *   OPENCONTEXT_DSH_DEDUP_SKIP_THRESHOLD → dedupSkipThreshold
 *   OPENCONTEXT_DSH_DEDUP_REVISE_THRESHOLD → dedupReviseThreshold
 *   AGENTOS_CONTEXT_MEMORY_LAYERING_ENABLED → memoryLayeringEnabled (`1` / `0`)
 *   AGENTOS_CONTEXT_AUTO_CONSOLIDATE → autoConsolidate (`1` / `0`)
 *   AGENTOS_CONTEXT_WORKING_MEMORY_HOURS → workingMemoryHours (1–168)
 *   AGENTOS_CONTEXT_EPISODIC_MEMORY_DAYS → episodicMemoryDays (1–3650)
 *   AGENTOS_CONTEXT_USER_ID → scopeUserId (optional trusted user scope)
 *   AGENTOS_CONTEXT_AGENT_ID → scopeAgentId (optional trusted agent scope)
 *   AGENTOS_CONTEXT_APP_ID → scopeAppId (optional trusted application scope)
 *
 *   OPENCONTEXT_DSH_HTTP_URL (presence-only) flips the backend to HTTP mode.
 *   OPENCONTEXT_MEMORY_STORE_DB_PATH controls the SQLite path used by the
 *   lib backend; the plugin does not re-read it directly but documents it.
 */
import z from "@deepseek-ai/schemastery";

// Older schemastery builds (3.18.2 and earlier, shipped by some DSH profiles)
// predate the volatile() schema modifier; degrade it to a no-op so config
// validation still works. Live (no-restart) updates then require a restart.
{
    const schemaPrototype = Object.getPrototypeOf(z.any());
    if (typeof schemaPrototype.volatile !== "function") {
        schemaPrototype.volatile = function volatile() { return this; };
    }
}
export const ConfigSchema = z.object({
    baseUrl: z.string().default("http://127.0.0.1:8000"),
    authorizationRef: z.string().role("credential-ref").default("OPENCONTEXT_HTTP_AUTHORIZATION"),
    scopeId: z.string().default(""),
    timeoutMs: z.number().default(4000),
    requestTimeoutMs: z.number().default(1000),
    maxBytes: z.number().default(8000),
    capturePrompts: z.boolean().default(true).volatile(),
    flushOnCapture: z.boolean().default(false),
    maxRecallItems: z.number().default(8),
    autoSummarize: z.boolean().default(false),
    captureToolResults: z.boolean().default(false),
    captureToolOutcomes: z.boolean().default(true),
    enableInsights: z.boolean().default(true),
    enableKnowledge: z.boolean().default(true),
    /** model gateway embedding (see docs/plans/2026-08-31 design §5.4). */
    embeddingBaseUrl: z.string().default(""),
    embeddingModel: z.string().default("bgem3-embedding").volatile(),
    apiKeyEnv: z.string().role("credential-ref").default("AGENTOS_CONTEXT_API_KEY"),
    embeddingBatchSize: z.natural().default(10),
    embeddingTimeoutMs: z.natural().default(15000),
    // Knowledge indexing can span many bounded embedding batches. Keep its
    // deadline independent from the short interactive-memory timeout.
    knowledgeUploadTimeoutMs: z.natural().default(600000),
    knowledgeSearchTimeoutMs: z.natural().default(30000),
    /** M6: distill captured prompts through a chat model before storing. */
    distillOnCapture: z.boolean().default(true).volatile(),
    distillModel: z.string().default("").volatile(),
    distillBaseUrl: z.string().default(""),
    distillTimeoutMs: z.natural().default(20000),
    // Reasoning-capable gateway models may spend many tokens before emitting
    // the required JSON.  2048 prevents an empty final
    // response while keeping capture bounded to a single short call.
    distillMaxTokens: z.natural().default(2048),
    /** M6: semantic dedup on remember() write path. */
    dedupEnabled: z.boolean().default(true),
    dedupSkipThreshold: z.number().default(0.95),
    dedupReviseThreshold: z.number().default(0.85),
    /** agentOS context sidecar: empty path uses <OPENCONTEXT_HOME>/agentos-context/context.db. */
    contextDbPath: z.string().default(""),
    ontologyEnabled: z.boolean().default(true).volatile(),
    recallEnabled: z.boolean().default(true).volatile(),
    /** 3+1 memory hierarchy and deterministic retention/consolidation policy. */
    memoryLayeringEnabled: z.boolean().default(true).volatile(),
    autoConsolidate: z.boolean().default(true).volatile(),
    workingMemoryHours: z.natural().default(24).volatile(),
    episodicMemoryDays: z.natural().default(90).volatile(),
    /** Optional trusted entity identities. Empty values do not create scopes. */
    scopeUserId: z.string().default("").volatile(),
    scopeAgentId: z.string().default("").volatile(),
    scopeAppId: z.string().default("").volatile(),
    /** Explicit opt-out of the identity-scope authorization added in 0.7.1. */
    allowForeignScopeIds: z.boolean().default(false),
});
function plainValue(value) {
    return value && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
}
function plainConfig(config) {
    if (!config)
        return config;
    return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, plainValue(value)]));
}
function envString(name) {
    const value = process.env[name];
    return value && value.length > 0 ? value : undefined;
}
function envNumber(name) {
    const raw = envString(name);
    if (raw === undefined)
        return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function envBool(name) {
    const raw = envString(name);
    if (raw === undefined)
        return undefined;
    const lowered = raw.toLowerCase();
    if (lowered === "1" || lowered === "true" || lowered === "yes")
        return true;
    if (lowered === "0" || lowered === "false" || lowered === "no")
        return false;
    return undefined;
}
function clamp01(value) {
    return Math.min(1, Math.max(0, value));
}
export function resolveConfig(patchConfig) {
    patchConfig = plainConfig(patchConfig);
    const fromEnv = {};
    const envBase = envString("OPENCONTEXT_DSH_BASE_URL");
    if (envBase !== undefined)
        fromEnv.baseUrl = envBase;
    const envAuthorizationRef = envString("OPENCONTEXT_DSH_AUTHORIZATION_REF");
    if (envAuthorizationRef !== undefined)
        fromEnv.authorizationRef = envAuthorizationRef;
    const envScope = envString("OPENCONTEXT_DSH_SCOPE_ID");
    if (envScope !== undefined)
        fromEnv.scopeId = envScope;
    const envCapture = envBool("OPENCONTEXT_DSH_CAPTURE_PROMPTS");
    if (envCapture !== undefined)
        fromEnv.capturePrompts = envCapture;
    const envFlush = envBool("OPENCONTEXT_DSH_FLUSH_ON_CAPTURE");
    if (envFlush !== undefined)
        fromEnv.flushOnCapture = envFlush;
    const envMaxBytes = envNumber("OPENCONTEXT_DSH_MAX_BYTES");
    if (envMaxBytes !== undefined)
        fromEnv.maxBytes = envMaxBytes;
    const envMaxRecall = envNumber("OPENCONTEXT_DSH_MAX_RECALL_ITEMS");
    if (envMaxRecall !== undefined)
        fromEnv.maxRecallItems = envMaxRecall;
    const envTimeout = envNumber("OPENCONTEXT_DSH_TIMEOUT_MS");
    if (envTimeout !== undefined)
        fromEnv.timeoutMs = envTimeout;
    const envRequestTimeout = envNumber("OPENCONTEXT_DSH_REQUEST_TIMEOUT");
    if (envRequestTimeout !== undefined)
        fromEnv.requestTimeoutMs = envRequestTimeout;
    const envAutoSummarize = envBool("OPENCONTEXT_DSH_AUTO_SUMMARIZE");
    if (envAutoSummarize !== undefined)
        fromEnv.autoSummarize = envAutoSummarize;
    const envCaptureToolResults = envBool("OPENCONTEXT_DSH_CAPTURE_TOOL_RESULTS");
    if (envCaptureToolResults !== undefined)
        fromEnv.captureToolResults = envCaptureToolResults;
    const envCaptureToolOutcomes = envBool("OPENCONTEXT_DSH_CAPTURE_TOOL_OUTCOMES");
    if (envCaptureToolOutcomes !== undefined)
        fromEnv.captureToolOutcomes = envCaptureToolOutcomes;
    const envEnableInsights = envBool("OPENCONTEXT_DSH_ENABLE_INSIGHTS");
    if (envEnableInsights !== undefined)
        fromEnv.enableInsights = envEnableInsights;
    const envEnableKnowledge = envBool("OPENCONTEXT_DSH_ENABLE_KNOWLEDGE");
    if (envEnableKnowledge !== undefined)
        fromEnv.enableKnowledge = envEnableKnowledge;
    const envEmbeddingBaseUrl = envString("OPENCONTEXT_DSH_EMBEDDING_BASE_URL");
    if (envEmbeddingBaseUrl !== undefined)
        fromEnv.embeddingBaseUrl = envEmbeddingBaseUrl;
    const envEmbeddingModel = envString("OPENCONTEXT_DSH_EMBEDDING_MODEL");
    if (envEmbeddingModel !== undefined)
        fromEnv.embeddingModel = envEmbeddingModel;
    const envApiKeyEnv = envString("OPENCONTEXT_DSH_API_KEY_ENV");
    if (envApiKeyEnv !== undefined)
        fromEnv.apiKeyEnv = envApiKeyEnv;
    const envEmbeddingBatchSize = envNumber("OPENCONTEXT_DSH_EMBEDDING_BATCH_SIZE");
    if (envEmbeddingBatchSize !== undefined)
        fromEnv.embeddingBatchSize = envEmbeddingBatchSize;
    const envEmbeddingTimeoutMs = envNumber("OPENCONTEXT_DSH_EMBEDDING_TIMEOUT_MS");
    if (envEmbeddingTimeoutMs !== undefined)
        fromEnv.embeddingTimeoutMs = envEmbeddingTimeoutMs;
    const envKnowledgeUploadTimeoutMs = envNumber("OPENCONTEXT_DSH_KNOWLEDGE_UPLOAD_TIMEOUT_MS");
    if (envKnowledgeUploadTimeoutMs !== undefined)
        fromEnv.knowledgeUploadTimeoutMs = envKnowledgeUploadTimeoutMs;
    const envKnowledgeSearchTimeoutMs = envNumber("OPENCONTEXT_DSH_KNOWLEDGE_SEARCH_TIMEOUT_MS");
    if (envKnowledgeSearchTimeoutMs !== undefined)
        fromEnv.knowledgeSearchTimeoutMs = envKnowledgeSearchTimeoutMs;
    const envDistillOnCapture = envBool("OPENCONTEXT_DSH_DISTILL_ON_CAPTURE");
    if (envDistillOnCapture !== undefined)
        fromEnv.distillOnCapture = envDistillOnCapture;
    const envDistillModel = envString("OPENCONTEXT_DSH_DISTILL_MODEL");
    if (envDistillModel !== undefined)
        fromEnv.distillModel = envDistillModel;
    const envDistillBaseUrl = envString("OPENCONTEXT_DSH_DISTILL_BASE_URL");
    if (envDistillBaseUrl !== undefined)
        fromEnv.distillBaseUrl = envDistillBaseUrl;
    const envDistillTimeoutMs = envNumber("OPENCONTEXT_DSH_DISTILL_TIMEOUT_MS");
    if (envDistillTimeoutMs !== undefined)
        fromEnv.distillTimeoutMs = envDistillTimeoutMs;
    const envDistillMaxTokens = envNumber("OPENCONTEXT_DSH_DISTILL_MAX_TOKENS");
    if (envDistillMaxTokens !== undefined)
        fromEnv.distillMaxTokens = envDistillMaxTokens;
    const envDedupEnabled = envBool("OPENCONTEXT_DSH_DEDUP_ENABLED");
    if (envDedupEnabled !== undefined)
        fromEnv.dedupEnabled = envDedupEnabled;
    const envDedupSkipThreshold = envNumber("OPENCONTEXT_DSH_DEDUP_SKIP_THRESHOLD");
    if (envDedupSkipThreshold !== undefined)
        fromEnv.dedupSkipThreshold = envDedupSkipThreshold;
    const envDedupReviseThreshold = envNumber("OPENCONTEXT_DSH_DEDUP_REVISE_THRESHOLD");
    if (envDedupReviseThreshold !== undefined)
        fromEnv.dedupReviseThreshold = envDedupReviseThreshold;
    const envContextDbPath = envString("AGENTOS_CONTEXT_DB_PATH");
    const envOntologyEnabled = envBool("AGENTOS_CONTEXT_ONTOLOGY_ENABLED");
    const envRecallEnabled = envBool("AGENTOS_CONTEXT_RECALL_ENABLED");
    const envMemoryLayeringEnabled = envBool("AGENTOS_CONTEXT_MEMORY_LAYERING_ENABLED");
    const envAutoConsolidate = envBool("AGENTOS_CONTEXT_AUTO_CONSOLIDATE");
    const envWorkingMemoryHours = envNumber("AGENTOS_CONTEXT_WORKING_MEMORY_HOURS");
    const envEpisodicMemoryDays = envNumber("AGENTOS_CONTEXT_EPISODIC_MEMORY_DAYS");
    const envScopeUserId = envString("AGENTOS_CONTEXT_USER_ID");
    const envScopeAgentId = envString("AGENTOS_CONTEXT_AGENT_ID");
    const envScopeAppId = envString("AGENTOS_CONTEXT_APP_ID");
    const envAllowForeignScopeIds = envBool("AGENTOS_CONTEXT_ALLOW_FOREIGN_SCOPE_IDS");
    const merged = {
        baseUrl: patchConfig?.baseUrl ?? fromEnv.baseUrl ?? "http://127.0.0.1:8000",
        authorizationRef: patchConfig?.authorizationRef ?? fromEnv.authorizationRef ?? "OPENCONTEXT_HTTP_AUTHORIZATION",
        scopeId: patchConfig?.scopeId ?? fromEnv.scopeId ?? "",
        timeoutMs: patchConfig?.timeoutMs ?? fromEnv.timeoutMs ?? 4000,
        requestTimeoutMs: patchConfig?.requestTimeoutMs ?? fromEnv.requestTimeoutMs ?? 1000,
        maxBytes: patchConfig?.maxBytes ?? fromEnv.maxBytes ?? 8000,
        capturePrompts: patchConfig?.capturePrompts ?? fromEnv.capturePrompts ?? true,
        flushOnCapture: patchConfig?.flushOnCapture ?? fromEnv.flushOnCapture ?? false,
        maxRecallItems: patchConfig?.maxRecallItems ?? fromEnv.maxRecallItems ?? 8,
        autoSummarize: patchConfig?.autoSummarize ?? fromEnv.autoSummarize ?? false,
        captureToolResults: patchConfig?.captureToolResults ?? fromEnv.captureToolResults ?? false,
        captureToolOutcomes: patchConfig?.captureToolOutcomes ?? fromEnv.captureToolOutcomes ?? true,
        enableInsights: patchConfig?.enableInsights ?? fromEnv.enableInsights ?? true,
        enableKnowledge: patchConfig?.enableKnowledge ?? fromEnv.enableKnowledge ?? true,
        embeddingBaseUrl: patchConfig?.embeddingBaseUrl ?? fromEnv.embeddingBaseUrl ?? "",
        embeddingModel: patchConfig?.embeddingModel ?? fromEnv.embeddingModel ?? "bgem3-embedding",
        apiKeyEnv: patchConfig?.apiKeyEnv ?? fromEnv.apiKeyEnv ?? "AGENTOS_CONTEXT_API_KEY",
        embeddingBatchSize: patchConfig?.embeddingBatchSize ?? fromEnv.embeddingBatchSize ?? 10,
        embeddingTimeoutMs: patchConfig?.embeddingTimeoutMs ?? fromEnv.embeddingTimeoutMs ?? 15000,
        knowledgeUploadTimeoutMs: patchConfig?.knowledgeUploadTimeoutMs ?? fromEnv.knowledgeUploadTimeoutMs ?? 600000,
        knowledgeSearchTimeoutMs: patchConfig?.knowledgeSearchTimeoutMs ?? fromEnv.knowledgeSearchTimeoutMs ?? 30000,
        distillOnCapture: patchConfig?.distillOnCapture ?? fromEnv.distillOnCapture ?? true,
        distillModel: patchConfig?.distillModel ?? fromEnv.distillModel ?? "",
        distillBaseUrl: patchConfig?.distillBaseUrl ?? fromEnv.distillBaseUrl ?? "",
        distillTimeoutMs: patchConfig?.distillTimeoutMs ?? fromEnv.distillTimeoutMs ?? 20000,
        distillMaxTokens: patchConfig?.distillMaxTokens ?? fromEnv.distillMaxTokens ?? 2048,
        dedupEnabled: patchConfig?.dedupEnabled ?? fromEnv.dedupEnabled ?? true,
        dedupSkipThreshold: patchConfig?.dedupSkipThreshold ?? fromEnv.dedupSkipThreshold ?? 0.95,
        dedupReviseThreshold: patchConfig?.dedupReviseThreshold ?? fromEnv.dedupReviseThreshold ?? 0.85,
        contextDbPath: patchConfig?.contextDbPath ?? envContextDbPath ?? "",
        ontologyEnabled: patchConfig?.ontologyEnabled ?? envOntologyEnabled ?? true,
        recallEnabled: patchConfig?.recallEnabled ?? envRecallEnabled ?? true,
        memoryLayeringEnabled: patchConfig?.memoryLayeringEnabled ?? envMemoryLayeringEnabled ?? true,
        autoConsolidate: patchConfig?.autoConsolidate ?? envAutoConsolidate ?? true,
        workingMemoryHours: patchConfig?.workingMemoryHours ?? envWorkingMemoryHours ?? 24,
        episodicMemoryDays: patchConfig?.episodicMemoryDays ?? envEpisodicMemoryDays ?? 90,
        scopeUserId: patchConfig?.scopeUserId ?? envScopeUserId ?? "",
        scopeAgentId: patchConfig?.scopeAgentId ?? envScopeAgentId ?? "",
        scopeAppId: patchConfig?.scopeAppId ?? envScopeAppId ?? "",
        allowForeignScopeIds: patchConfig?.allowForeignScopeIds ?? envAllowForeignScopeIds ?? false,
    };
    // M6 defense: keep dedup thresholds inside [0,1] so a stray env/patch
    // value cannot disable or hyper-activate the dedup gate.
    merged.dedupSkipThreshold = clamp01(merged.dedupSkipThreshold);
    merged.dedupReviseThreshold = clamp01(merged.dedupReviseThreshold);
    // M6 defense: revise above skip would make the revise branch unreachable
    // (any similarity >= skip is already a skip), so pin revise down to skip.
    if (merged.dedupReviseThreshold > merged.dedupSkipThreshold)
        merged.dedupReviseThreshold = merged.dedupSkipThreshold;
    merged.workingMemoryHours = Math.max(1, Math.min(168, Math.trunc(merged.workingMemoryHours)));
    merged.episodicMemoryDays = Math.max(1, Math.min(3650, Math.trunc(merged.episodicMemoryDays)));
    merged.knowledgeUploadTimeoutMs = Math.max(15000, Math.min(1800000, Math.trunc(merged.knowledgeUploadTimeoutMs)));
    merged.knowledgeSearchTimeoutMs = Math.max(4000, Math.min(120000, Math.trunc(merged.knowledgeSearchTimeoutMs)));
    return merged;
}
export function isHttpMode() {
    return envString("OPENCONTEXT_DSH_HTTP_URL") !== undefined;
}
//# sourceMappingURL=config.js.map
