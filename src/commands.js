/**
 * Register the user-facing `/memory` diagnostics command and the legacy
 * `/oc` compatibility alias.
 */
import { constants, classifyBackendError } from "./errors.js";
async function describeEmbedding(ctx, config, embeddingProvider) {
    if (!embeddingProvider)
        return undefined;
    let keyConfigured = null;
    try {
        keyConfigured = (await ctx.credentials?.describe?.(config.apiKeyEnv))?.configured ?? null;
    }
    catch {
        keyConfigured = null;
    }
    return {
        model: embeddingProvider.getModelName(),
        // undefined until the first successful embed teaches the true width
        dimensions: embeddingProvider.getDimensions() ?? null,
        keyConfigured,
    };
}
async function handleDoctor(ctx, backend, config, embeddingProvider) {
    const probe = await backend.health();
    const scope = config.scopeId || "(auto)";
    const embedding = await describeEmbedding(ctx, config, embeddingProvider);
    let recentCount = null;
    try {
        const items = await backend.list({ limit: 1, scopeId: scope, userId: scope }, { timeoutMs: Math.min(config.timeoutMs, 2000) });
        recentCount = items.length;
    }
    catch (error) {
        const cls = classifyBackendError(error);
        return {
            kind: "error",
            text: JSON.stringify({
                ok: false,
                plugin: constants.PLUGIN_NAME,
                backend: backend.mode,
                scope,
                probe,
                embedding,
                listError: { code: cls.code, message: cls.message },
            }, null, 2),
        };
    }
    return {
        kind: probe.ok ? "success" : "error",
        text: JSON.stringify({
            ok: probe.ok,
            plugin: constants.PLUGIN_NAME,
            backend: backend.mode,
            scope,
            storage: "agentos-context-sidecar",
            legacyCompatibility: backend.mode === "lib",
            probe,
            embedding,
            recentCount,
        }, null, 2),
    };
}
export function registerCommand(ctx, backend, config, embeddingProvider = null) {
    const commands = ctx.get("commands");
    if (!commands || typeof commands.register !== "function") {
        ctx.logger?.warn?.("[agentOS context] commands service not available");
        return () => undefined;
    }
    const createHandler = (commandName) => async (invocation) => {
            try {
                const trimmed = (invocation.rawInput ?? "").trim();
                const sub = trimmed.split(/\s+/).filter(Boolean)[0] ?? "";
                if (sub === "doctor" || sub === "") {
                    return await handleDoctor(ctx, backend, config, embeddingProvider);
                }
                return {
                    kind: "error",
                    text: `Unknown /${commandName} subcommand: ${sub}. Try /${commandName} doctor.`,
                };
            }
            catch (error) {
                const classified = classifyBackendError(error);
                return { kind: "error", text: `Command failed (${classified.code}): ${classified.message}` };
            }
        };
    const disposers = [];
    try {
        disposers.push(commands.register({
            name: "memory",
            description: "Check agentOS context memory status and diagnostics.",
            handler: createHandler("memory"),
        }));
        disposers.push(commands.register({
            name: "oc",
            description: "Compatibility alias for /memory. Prefer /memory in new workflows.",
            handler: createHandler("oc"),
        }));
    }
    catch (error) {
        for (const dispose of disposers.reverse()) dispose?.();
        throw error;
    }
    return () => {
        for (const dispose of disposers.reverse()) dispose?.();
    };
}
//# sourceMappingURL=commands.js.map
