/**
 * tools-summary — Session summary and memory consolidation tools.
 *
 * These tools allow agents to generate and manage session summaries,
 * consolidating scattered interactions into higher-level memories.
 */
import { classifyBackendError, toolError, toolOk } from "./errors.js";
import { resolveContextScope } from "./context/scope.js";
// Shared output definition for summary tools
const SUMMARY_OUTPUT = {
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            ok: { type: "boolean" },
            code: { type: "string" },
            message: { type: "string" },
            data: {
                type: "object",
                additionalProperties: true,
            },
        },
    },
    render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value) }];
    },
};
function defineTool(spec) {
    return { ...spec, output: spec.output ?? SUMMARY_OUTPUT };
}
function publicAndCompatibility(tool, publicName) {
    return [
        { ...tool, name: publicName },
        { ...tool, description: `Compatibility alias for ${publicName}. Prefer ${publicName} in new workflows.` },
    ];
}
function asRecord(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    return {};
}
function coerceLimit(value, fallback, max) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return fallback;
    return Math.max(1, Math.min(max, Math.floor(value)));
}
async function runTool(fn) {
    try {
        const value = await fn();
        if (value && typeof value === "object" && "ok" in value) {
            return value;
        }
        return toolOk(value);
    }
    catch (error) {
        const cls = classifyBackendError(error);
        return toolError(cls.code, cls.message);
    }
}
function asScopeConfig(ctx, config) {
    const scopeId = resolveContextScope(ctx, config);
    const userId = ctx.userId || scopeId;
    return { scopeId, userId };
}
/**
 * Create the session summary tool
 */
function createSessionSummaryTool(backend, config) {
    return defineTool({
        name: "oc_session_summary",
        kind: "read",
        description: "Generate and store a summary of the current session. Use this at natural breakpoints (task completion, context switches).",
        parameters: {
            summary: {
                type: "string",
                required: true,
                description: "The session summary text",
            },
            tags: {
                type: "array",
                items: { type: "string" },
                description: "Optional tags for categorization (e.g. ['task-complete', 'decision-made'])",
            },
            metadata: {
                type: "object",
                additionalProperties: true,
                description: "Optional metadata (e.g. { project: 'X', milestone: 'Y' })",
            },
        },
        execute: async (args, ctx) => runTool(async () => {
            const summary = String(args.summary ?? "").trim();
            if (!summary)
                return toolError("invalid_arguments", "summary is required");
            const { scopeId, userId } = asScopeConfig(ctx, config);
            const tags = Array.isArray(args.tags) ? args.tags.map((t) => String(t)) : [];
            const result = await backend.remember({
                content: summary,
                sourceType: "session-summary",
                metadata: {
                    ...asRecord(args.metadata),
                    tags,
                    ts: Date.now(),
                },
                scopeId,
                userId,
            }, { signal: ctx.signal, timeoutMs: config.timeoutMs });
            const id = result.ids?.[0] ?? "";
            return toolOk({ id });
        }),
    });
}
/**
 * Create the task outcome tool
 */
function createTaskOutcomeTool(backend, config) {
    return defineTool({
        name: "oc_task_outcome",
        kind: "read",
        description: "Record a task outcome or achievement. Use this when a task is completed, a decision is made, or a deliverable is produced.",
        parameters: {
            outcome: {
                type: "string",
                required: true,
                description: "Description of the outcome or achievement",
            },
            taskName: { type: "string", description: "Optional task name" },
            status: {
                type: "string",
                description: "Status: completed, failed, blocked, or in-progress (default: completed)",
            },
            metadata: {
                type: "object",
                additionalProperties: true,
                description: "Optional metadata",
            },
        },
        execute: async (args, ctx) => runTool(async () => {
            const outcome = String(args.outcome ?? "").trim();
            if (!outcome)
                return toolError("invalid_arguments", "outcome is required");
            const { scopeId, userId } = asScopeConfig(ctx, config);
            const taskName = typeof args.taskName === "string" ? args.taskName.trim() : undefined;
            const status = String(args.status ?? "completed").toLowerCase();
            const result = await backend.remember({
                content: outcome,
                sourceType: "task-outcome",
                metadata: {
                    ...asRecord(args.metadata),
                    taskName,
                    status,
                    ts: Date.now(),
                },
                scopeId,
                userId,
            }, { signal: ctx.signal, timeoutMs: config.timeoutMs });
            const id = result.ids?.[0] ?? "";
            return toolOk({ id });
        }),
    });
}
/**
 * Create the recent summaries tool
 */
function createRecentSummariesTool(backend, config) {
    return defineTool({
        name: "oc_recent_summaries",
        kind: "read",
        description: "List recent session summaries and task outcomes",
        parameters: {
            limit: {
                type: "number",
                description: "Maximum items to return (default 20, max 100).",
            },
            sourceTypes: {
                type: "array",
                items: { type: "string" },
                description: "Filter by source type (e.g. ['session-summary', 'task-outcome'])",
            },
        },
        execute: async (args, ctx) => runTool(async () => {
            const { scopeId, userId } = asScopeConfig(ctx, config);
            // Use list with source type filter
            const items = await backend.list({
                limit: Math.min(500, coerceLimit(args.limit, 20, 100) * 5),
                scopeId,
                userId,
            }, { signal: ctx.signal, timeoutMs: config.timeoutMs });
            // Filter by source types if provided
            let filtered = items;
            if (Array.isArray(args.sourceTypes) && args.sourceTypes.length > 0) {
                const sourceTypes = new Set(args.sourceTypes.map((s) => String(s)));
                filtered = items.filter((item) => sourceTypes.has(item.metadata?.sourceType ?? item.sourceType ?? item.platform ?? ""));
            }
            // Only return summaries and outcomes
            const summaryTypes = new Set(["session-summary", "task-outcome", "turn-summary"]);
            filtered = filtered.filter((item) => summaryTypes.has(item.metadata?.sourceType ?? item.sourceType ?? item.platform ?? "")).slice(0, coerceLimit(args.limit, 20, 100));
            return toolOk({
                items: filtered.map((item) => ({
                    id: item.id,
                    content: item.content,
                    sourceType: item.metadata?.sourceType ?? item.sourceType ?? item.platform ?? "unknown",
                    timestamp: item.timestamp ?? Date.now(),
                    metadata: item.metadata ?? {},
                })),
            });
        }),
    });
}
export function makeSummaryTools(backend, config) {
    return [
        ...publicAndCompatibility(createSessionSummaryTool(backend, config), "memory_session_summary"),
        ...publicAndCompatibility(createTaskOutcomeTool(backend, config), "memory_task_outcome"),
        ...publicAndCompatibility(createRecentSummariesTool(backend, config), "memory_recent_summaries"),
    ];
}
export function registerSummaryTools(ctx, runtime, defineTool) {
    const tools = makeSummaryTools(runtime.backend, runtime.config);
    const disposers = [];
    for (const tool of tools) {
        disposers.push(ctx.tools.register(defineTool(tool)));
    }
    return () => {
        for (const dispose of disposers) {
            try {
                dispose();
            }
            catch {
                // ignore
            }
        }
    };
}
//# sourceMappingURL=tools-summary.js.map
