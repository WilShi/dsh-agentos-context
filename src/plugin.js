/**
 * agentOS context — compatibility-preserving host entry point.
 *
 * Loaded by the DSH plugin loader as a Cordis plugin. The loader calls
 * `apply(ctx, config)` after resolving the schema and merging env vars.
 *
 * Wiring (in order):
 *   1. Resolve config (already done by the loader; we re-merge for env safety).
 *   2. Pick a backend (lib or http) based on `OPENCONTEXT_DSH_HTTP_URL`.
 *   3. Load DSH tools peer dependency for proper tool registration.
 *   4. Register the core memory/context tools and their `oc_*` aliases.
 *   5. Register insights tools (2 tools, if enabled).
 *   6. Register knowledge/RAG tools (6 public tools plus compatibility aliases, if enabled).
 *   7. Register summary tools (3 tools).
 *   8. Register the `agent/pre-step` recall waterfall.
 *   9. Register the capture wrapper around the recall waterfall.
 *   10. Register the `turn/end` listener (for session summarization).
 *   11. Register the `tool/result` listener (for tool output capture).
 *   12. Register the `agentos-context` skill (if the skill service is injected).
 *   13. Register `/memory` and its compatible `/oc` alias.
 *   14. Own bridge resources before child RPC/listener registrations for reverse-order cleanup.
 */
import { createBackend } from "./backend.js";
import { registerCapture } from "./capture.js";
import { registerCommand } from "./commands.js";
import { ConfigSchema, resolveConfig } from "./config.js";
import { registerToolResultListener } from "./events-tool-result.js";
import { registerTurnEndListener } from "./events-turn-end.js";
import { getOpenContextDir } from "@melandlabs/env-config";
import { createContextStore } from "./context/store.js";
import { createContextService } from "./context/service.js";
import { createBackendBridge } from "./context/backend-bridge.js";
import { createUsageTracker } from "./context/usage.js";
import { createContextVectorIndex } from "./context/vector-index.js";
import { prepareContextDbPath } from "./context/runtime.js";
import { createContextRpcHandler, safeContextError } from "./context/rpc-service.js";
import { CONTEXT_RPC_ENDPOINTS, createContextRpcRoute } from "./context/rpc-route.ts";
import { createDistiller } from "./gateway-distill.ts";
import { assertTrustedGatewayBase } from "./gateway-policy.js";
import { createGatewayEmbeddingProvider } from "./gateway-embedding-provider.ts";
import { loadPeer } from "./peers.js";
import { registerRecall } from "./recall.js";
import { registerSkill } from "./skill.js";
import { registerInsightsTools } from "./tools-insights.js";
import { registerKnowledgeTools } from "./tools-knowledge.js";
import { registerSummaryTools } from "./tools-summary.js";
import { registerTools } from "./tools.js";
import { restoreNativeReadableStream } from "./web-runtime-compat.js";
import { dirname } from "node:path";
export const name = "dsh-agentos-context";
export const inject = [
    "tools",
    "agents",
    "agentDefaultModel",
    "systemPrompt",
    "commands",
    "llm",
    "sessions",
    "credentials",
    "connection",
];
export { ConfigSchema };
export const Config = ConfigSchema;
export async function apply(ctx, config) {
    // Older OpenContext dependencies can replace the native constructor while
    // this entry module is loading. Undici requires constructor identity, so
    // repair it before any DSH HTTP/RPC request can be bridged.
    restoreNativeReadableStream();
    const resolved = resolveConfig(config);
    resolved.compatibilityWorkspaceScopeIds = [...new Set([
        'local:default',
        `local:${process.cwd()}`,
        `local:${dirname(process.execPath)}`,
    ])];
    resolved.embeddingBaseUrl = resolved.embeddingBaseUrl ? assertTrustedGatewayBase(resolved.embeddingBaseUrl) : '';
    if (resolved.distillBaseUrl) resolved.distillBaseUrl = assertTrustedGatewayBase(resolved.distillBaseUrl);
    const restartOnly = { baseUrl: resolved.baseUrl, enableInsights: resolved.enableInsights, enableKnowledge: resolved.enableKnowledge, apiKeyEnv: resolved.apiKeyEnv, embeddingBaseUrl: resolved.embeddingBaseUrl, distillBaseUrl: resolved.distillBaseUrl };
    // Official 0.2.1 Settings projects this Loader entry's volatile Config fields.
    // The custom page owns presentation, while ConfigEditor owns validation,
    // persistence, revision fencing, and live reference updates.
    ctx.inject(["settings"], (settingsCtx) => {
        settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber));
    });
    ctx.on("loader/volatile-update", () => {
        const openContextDb = resolved.contextDbPath;
        Object.assign(resolved, resolveConfig(config), restartOnly, { contextDbPath: openContextDb });
    });
    // model gateway embedding: resolves the key per call through the
    // credentials seam, so a saved/rotated key reaches the next embed without
    // a restart. Embedding failures degrade to plain-text memories (the
    // backend never lets an embed error block a write).
    const embeddingProvider = createGatewayEmbeddingProvider(ctx, resolved);
    const legacyBackend = createBackend(resolved, { embeddingProvider, credentials: ctx.credentials });
    const contextDbPath = prepareContextDbPath(resolved, process.env, getOpenContextDir());
    resolved.contextDbPath = contextDbPath;
    const contextStore = createContextStore({ dbPath: contextDbPath });
    let vectorIndex;
    let contextService;
    let backend;
    let usage;
    try {
        try { vectorIndex = createContextVectorIndex({ dbPath: contextDbPath + ".vectors", provider: embeddingProvider }); }
        catch (error) { ctx.logger.warn("[agentOS context] semantic sidecar unavailable; lexical and graph search remain active (" + (error?.code ?? "VECTOR_UNAVAILABLE") + ")"); }
        contextService = createContextService({ store: contextStore, legacy: legacyBackend, config: resolved, sessions: ctx.sessions, vectorIndex, defaultScope: () => resolved.scopeId || "local:default" });
        backend = createBackendBridge({ service: contextService, legacy: legacyBackend, defaultScope: () => resolved.scopeId || "local:default", config: resolved });
        usage = createUsageTracker(ctx, contextStore);
    } catch (error) {
        await Promise.allSettled([Promise.resolve().then(() => vectorIndex?.close?.()), Promise.resolve().then(() => contextStore.close()), Promise.resolve().then(() => legacyBackend.dispose?.())]);
        throw error;
    }
    // Own native resources before any consumer/child registration. Cordis disposes in reverse order.
    ctx.effect(() => async () => { usage.dispose(); await backend.dispose?.(); });
    // M6 蒸馏器：capture 分支按 config.distillOnCapture 决定是否调用；
    // 与 embedding 同样按次 resolve 密钥，轮换即时生效。
    const distiller = createDistiller(ctx, resolved);
    // Authenticated Client Connection routes; no raw public webServer memory or credential endpoints.
    const rpcHandler = createContextRpcHandler({ service: contextService, credentials: ctx.credentials, config: resolved, distiller });
    ctx.inject(["connection"], (inner) => {
        for (const endpoint of CONTEXT_RPC_ENDPOINTS) inner.connection.fetch.register(createContextRpcRoute(endpoint, async (method, payload, signal) => {
            try { return { ok: true, value: await rpcHandler(method, payload, signal) }; }
            catch (error) { return { ok: false, error: safeContextError(error) }; }
        }));
    });
    // Log enabled features
    const features = [];
    if (resolved.enableInsights)
        features.push("insights");
    if (resolved.enableKnowledge)
        features.push("knowledge");
    if (resolved.autoSummarize)
        features.push("auto-summarize");
    if (resolved.captureToolResults)
        features.push("tool-capture");
    if (resolved.capturePrompts)
        features.push("prompt-capture");
    ctx.logger.info?.(`[agentOS context] active backend=${backend.mode} scope=${resolved.scopeId || "(auto)"} maxBytes=${resolved.maxBytes} features=${features.join(",") || "core"}`);
    const disposers = [];
    // Load DSH tools peer dependency for proper tool registration
    const toolsMod = await loadPeer("@deepseek-ai/dsh-tools");
    const runtime = { backend, config: resolved };
    // Core tools (always registered)
    disposers.push(registerTools(ctx, runtime, toolsMod.defineTool));
    // Optional tools based on config
    if (resolved.enableInsights) {
        disposers.push(registerInsightsTools(ctx, runtime, toolsMod.defineTool));
    }
    if (resolved.enableKnowledge) {
        disposers.push(registerKnowledgeTools(ctx, runtime, toolsMod.defineTool));
    }
    // Summary tools (always available)
    disposers.push(registerSummaryTools(ctx, runtime, toolsMod.defineTool));
    // Event listeners
    // Capture wraps recall: both observe the downstream-admitted human snapshot,
    // while recall executes before capture writes and cannot echo the current prompt.
    disposers.push(registerCapture(ctx, backend, resolved, { distiller }));
    disposers.push(registerRecall(ctx, backend, resolved, { usage }));
    disposers.push(registerTurnEndListener(ctx, backend, resolved));
    disposers.push(registerToolResultListener(ctx, backend, resolved));
    // Skill and command
    disposers.push(registerSkill(ctx));
    disposers.push(registerCommand(ctx, backend, resolved, embeddingProvider));
    ctx.effect(() => {
        return async () => {
            for (const dispose of disposers) {
                try {
                    await dispose();
                }
                catch {
                    // ignore
                }
            }
        };
    });
}
//# sourceMappingURL=index.js.map
