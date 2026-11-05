/**
 * tools-insights — Insights search and management tools.
 *
 * OpenContext's insights API provides structured, extracted insights
 * from historical conversations. These tools expose that capability
 * to DSH agents.
 */
import { classifyBackendError, toolError, toolOk } from "./errors.js";
import { resolveContextScope } from "./context/scope.js";
// Shared output definition for insights tools
const INSIGHTS_OUTPUT = {
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
    return { ...spec, output: spec.output ?? INSIGHTS_OUTPUT };
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
 * Insight categories supported by OpenContext
 */
const INSIGHT_CATEGORIES = [
    "decision",
    "preference",
    "outcome",
    "fact",
    "opinion",
    "plan",
    "question",
    "answer",
];
/**
 * Create the insights search tool
 */
function createInsightsSearchTool(backend, config) {
    return defineTool({
        name: "oc_insights_search",
        kind: "search",
        description: "Search structured insights extracted from historical conversations. Insights are higher-level abstractions like decisions, preferences, and outcomes.",
        parameters: {
            query: {
                type: "string",
                required: true,
                description: "Search query for insights",
            },
            categories: {
                type: "array",
                items: { type: "string" },
                description: `Filter by insight categories. Valid: ${INSIGHT_CATEGORIES.join(", ")}`,
            },
            limit: {
                type: "number",
                description: "Maximum insights to return (default 10, max 50).",
            },
            since: {
                type: "number",
                description: "Only return insights after this epoch ms timestamp.",
            },
        },
        execute: async (args, ctx) => runTool(async () => {
            const query = String(args.query ?? "").trim();
            if (!query)
                return toolError("invalid_arguments", "query is required");
            const { scopeId, userId } = asScopeConfig(ctx, config);
            // Validate categories if provided
            let categories;
            if (Array.isArray(args.categories)) {
                categories = args.categories
                    .map((c) => String(c).toLowerCase())
                    .filter((c) => INSIGHT_CATEGORIES.includes(c));
            }
            // Call backend - this will be implemented in backend-extended
            const result = await backend.searchInsights?.({
                query,
                categories,
                limit: coerceLimit(args.limit, 10, 50),
                since: typeof args.since === "number" && Number.isFinite(args.since) ? args.since : undefined,
                scopeId,
                userId,
            }, { signal: ctx.signal, timeoutMs: config.timeoutMs });
            if (!result) {
                // Fallback if backend doesn't support insights yet
                return toolOk({
                    insights: [],
                    note: "Insights search is not available because the backend does not expose an insights store.",
                });
            }
            return toolOk({
                insights: (result.insights ?? []).map((insight) => ({
                    id: insight.id,
                    content: insight.content,
                    category: insight.category,
                    score: insight.score ?? 0,
                    timestamp: insight.timestamp,
                    metadata: insight.metadata ?? {},
                })),
            });
        }),
    });
}
/**
 * Create the insight capture tool
 */
function createInsightCaptureTool(backend, config) {
    return defineTool({
        name: "oc_insight_capture",
        kind: "read",
        description: "Capture a structured insight. Use this when the conversation reveals a high-level abstraction like a decision, preference, or outcome.",
        parameters: {
            content: {
                type: "string",
                required: true,
                description: "The insight text to store",
            },
            category: {
                type: "string",
                description: `Insight category. Valid: ${INSIGHT_CATEGORIES.join(", ")}`,
            },
            metadata: {
                type: "object",
                additionalProperties: true,
                description: "Optional metadata (e.g. { relatedTo: 'project-X' })",
            },
        },
        execute: async (args, ctx) => runTool(async () => {
            const content = String(args.content ?? "").trim();
            if (!content)
                return toolError("invalid_arguments", "content is required");
            const category = String(args.category ?? "fact").toLowerCase();
            if (!INSIGHT_CATEGORIES.includes(category)) {
                return toolError("invalid_arguments", `category must be one of: ${INSIGHT_CATEGORIES.join(", ")}`);
            }
            const { scopeId, userId } = asScopeConfig(ctx, config);
            const result = await backend.captureInsight?.({
                content,
                category,
                metadata: asRecord(args.metadata),
                scopeId,
                userId,
            }, { signal: ctx.signal, timeoutMs: config.timeoutMs });
            if (!result) {
                return toolError("backend_unavailable", "Insight capture is not available because the backend does not expose an insights store.");
            }
            return toolOk({ id: result.id });
        }),
    });
}
export function makeInsightsTools(backend, config) {
    return [
        ...publicAndCompatibility(createInsightsSearchTool(backend, config), "memory_insights_search"),
        ...publicAndCompatibility(createInsightCaptureTool(backend, config), "memory_insight_capture"),
    ];
}
export function registerInsightsTools(ctx, runtime, defineTool) {
    const tools = makeInsightsTools(runtime.backend, runtime.config);
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
//# sourceMappingURL=tools-insights.js.map
