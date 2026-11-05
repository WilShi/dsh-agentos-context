/**
 * tools-knowledge — Knowledge/RAG search and document management tools.
 *
 * OpenContext's RAG capabilities allow agents to search uploaded documents
 * and knowledge bases. These tools expose document search and upload.
 */
import { classifyBackendError, toolError, toolOk } from "./errors.js";
import { GLOBAL_SCOPE_ID, resolveContextIdentity } from "./context/scope.js";
import * as validation from "./context/validation.js";
// Shared output definition for knowledge tools
const KNOWLEDGE_OUTPUT = {
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
    return { ...spec, output: spec.output ?? KNOWLEDGE_OUTPUT };
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
function asKnowledgeWriteScope(ctx, config) {
    const identity = resolveContextIdentity(ctx, config);
    const scopeId = typeof config.scopeId === "string" && config.scopeId.trim() ? identity.scopeId : GLOBAL_SCOPE_ID;
    return { scopeId, userId: scopeId };
}
async function asKnowledgeReadPlan(backend, ctx, config) {
    const identity = resolveContextIdentity(ctx, config);
    const current = identity.workspaceScope;
    const compatibility = typeof config.scopeId !== "string" || !config.scopeId.trim()
        ? await backend.compatibilityWorkspaceScopes?.(current) ?? []
        : [];
    const scopeIds = [...new Set([current, ...(Array.isArray(compatibility) ? compatibility : []), ...(config.scopeId ? [] : [GLOBAL_SCOPE_ID])])];
    return { scopeId: current, scopeIds };
}
async function scopesWithDocuments(backend, plan, ctx, limit = 1) {
    if (typeof backend.listDocuments !== "function") return plan.scopeIds;
    const rows = await Promise.all(plan.scopeIds.map(async (scopeId) => {
        const result = await backend.listDocuments({ scopeId, userId: scopeId, limit }, { signal: ctx.signal, timeoutMs: plan.timeoutMs });
        return (result?.documents?.length ?? 0) > 0 ? scopeId : null;
    }));
    return rows.filter(Boolean);
}
async function documentsByScope(backend, plan, ctx, limit = 1000) {
    if (typeof backend.listDocuments !== "function") return [];
    const batches = await Promise.all(plan.scopeIds.map(async (scopeId) => {
        const result = await backend.listDocuments({ scopeId, userId: scopeId, limit }, { signal: ctx.signal, timeoutMs: plan.timeoutMs });
        return (result?.documents ?? []).map((document) => ({ ...document, scopeId }));
    }));
    return batches.flat();
}
async function locateDocumentScope(backend, plan, id, ctx) {
    const documents = await documentsByScope(backend, plan, ctx);
    return documents.find((document) => document.id === id)?.scopeId ?? plan.scopeId;
}
function mergeKnowledgeChunks(batches, limit) {
    const unique = new Map();
    for (const batch of batches) for (const chunk of batch ?? []) {
        const key = `${chunk.scopeId ?? ""}\0${chunk.id}`;
        const previous = unique.get(key);
        if (!previous || Number(chunk.score ?? 0) > Number(previous.score ?? 0)) unique.set(key, chunk);
    }
    const ranked = [...unique.values()].sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0) || String(a.documentName).localeCompare(String(b.documentName)) || Number(a.chunkIndex ?? 0) - Number(b.chunkIndex ?? 0));
    const groups = new Map();
    for (const chunk of ranked) {
        const key = `${chunk.scopeId ?? ""}\0${chunk.documentId}`;
        const group = groups.get(key) ?? [];group.push(chunk);groups.set(key, group);
    }
    const out = [];
    for (let depth = 0; out.length < limit; depth++) {
        let added = false;
        for (const group of groups.values()) if (group[depth]) { out.push(group[depth]);added = true;if (out.length >= limit) break; }
        if (!added) break;
    }
    return out;
}
/**
 * Create the knowledge search tool
 */
function createKnowledgeSearchTool(backend, config) {
    return defineTool({
        name: "oc_knowledge_search",
        kind: "search",
        description: "Search uploaded documents and knowledge bases using RAG (Retrieval-Augmented Generation). Returns relevant document chunks.",
        parameters: {
            query: {
                type: "string",
                required: true,
                description: "Search query for document contents",
            },
            documentIds: {
                type: "array",
                items: { type: "string" },
                description: "Optional list of document IDs to search within",
            },
            limit: {
                type: "number",
                description: "Maximum chunks to return (default 5, max 20).",
            },
            threshold: {
                type: "number",
                description: "Minimum similarity threshold (0-1, default 0.6)",
            },
            searchMode: {
                type: "string",
                enum: ["hybrid", "semantic", "keyword"],
                description: "Retrieval mode. Hybrid is recommended and is the default.",
            },
            metadata: {
                type: "object",
                additionalProperties: true,
                description: "Optional exact-match document metadata filter.",
            },
        },
        execute: async (args, ctx) => runTool(async () => {
            const query = String(args.query ?? "").trim();
            if (!query)
                return toolError("invalid_arguments", "query is required");
            const plan = await asKnowledgeReadPlan(backend, ctx, config);
            // Parse document IDs if provided
            let documentIds;
            if (Array.isArray(args.documentIds)) {
                documentIds = args.documentIds.map((id) => String(id));
            }
            // Call backend
            const limit = coerceLimit(args.limit, 5, 20), timeoutMs = config.knowledgeSearchTimeoutMs ?? 30000;
            plan.timeoutMs = timeoutMs;
            const activeScopes = await scopesWithDocuments(backend, plan, ctx, documentIds?.length ? 1000 : 1);
            const results = await Promise.all(activeScopes.map(async (scopeId) => {
                const result = await backend.searchKnowledge?.({
                    query, documentIds, limit, threshold: typeof args.threshold === "number" ? args.threshold : 0.6,
                    searchMode: typeof args.searchMode === "string" ? args.searchMode : "hybrid",
                    metadata: validation.metadata(asRecord(args.metadata)), scopeId, userId: scopeId,
                }, { signal: ctx.signal, timeoutMs });
                return (result?.chunks ?? []).map((chunk) => ({ ...chunk, scopeId }));
            }));
            if (typeof backend.searchKnowledge !== "function") {
                return toolOk({
                    chunks: [],
                    note: "Knowledge search is not available because the backend does not expose a knowledge store.",
                });
            }
            return toolOk({
                chunks: mergeKnowledgeChunks(results, limit).map((chunk) => ({
                    id: chunk.id,
                    scopeId: chunk.scopeId,
                    content: chunk.content,
                    documentId: chunk.documentId,
                    documentName: chunk.documentName,
                    score: chunk.score ?? 0,
                    metadata: chunk.metadata ?? {},
                })),
            });
        }),
    });
}
function createDocumentChunksTool(backend, config) {
    return defineTool({
        name: "knowledge_document_chunks",
        kind: "read",
        description: "Inspect the indexed chunks and metadata for one knowledge document.",
        parameters: { id: { type: "string", required: true, description: "Document id." } },
        execute: async (args, ctx) => runTool(async () => {
            const id = validation.text(String(args.id ?? "").trim(), "id", 512);
            const plan = await asKnowledgeReadPlan(backend, ctx, config);plan.timeoutMs = config.timeoutMs;
            const scopeId = await locateDocumentScope(backend, plan, id, ctx), userId = scopeId;
            const result = await backend.listDocumentChunks?.({ id, limit: 5000, scopeId, userId }, { signal: ctx.signal, timeoutMs: config.timeoutMs });
            if (!result) return toolError("backend_unavailable", "Document chunk inspection is not available.");
            return toolOk(result);
        }),
    });
}
function createDocumentReindexTool(backend, config) {
    return defineTool({
        name: "knowledge_document_reindex",
        kind: "read",
        description: "Rebuild keyword and semantic indexes for one knowledge document.",
        parameters: { id: { type: "string", required: true, description: "Document id." } },
        execute: async (args, ctx) => runTool(async () => {
            const id = validation.text(String(args.id ?? "").trim(), "id", 512);
            const plan = await asKnowledgeReadPlan(backend, ctx, config);plan.timeoutMs = config.timeoutMs;
            const scopeId = await locateDocumentScope(backend, plan, id, ctx), userId = scopeId;
            const result = await backend.reindexDocument?.({ id, scopeId, userId }, { signal: ctx.signal, timeoutMs: config.knowledgeUploadTimeoutMs ?? 600000 });
            if (!result) return toolError("backend_unavailable", "Document reindex is not available.");
            return toolOk(result);
        }),
    });
}
function createDocumentDeleteTool(backend, config) {
    return defineTool({
        name: "knowledge_document_delete",
        kind: "read",
        description: "Delete one or more knowledge documents from the current scope, including chunks and indexes.",
        parameters: { ids: { type: "array", items: { type: "string" }, required: true, description: "One to one hundred document ids." } },
        execute: async (args, ctx) => runTool(async () => {
            const ids = Array.isArray(args.ids) ? [...new Set(args.ids.map((value) => String(value).trim()).filter(Boolean))] : [];
            if (!ids.length || ids.length > 100) return toolError("invalid_arguments", "ids must contain one to one hundred document ids");
            const plan = await asKnowledgeReadPlan(backend, ctx, config);plan.timeoutMs = config.timeoutMs;
            const documents = await documentsByScope(backend, plan, ctx), byScope = new Map();
            for (const id of ids) { const scopeId = documents.find((document) => document.id === id)?.scopeId ?? plan.scopeId;const group = byScope.get(scopeId) ?? [];group.push(id);byScope.set(scopeId, group); }
            const results = await Promise.all([...byScope].map(([scopeId, scopedIds]) => backend.deleteDocuments?.({ ids: scopedIds, scopeId, userId: scopeId }, { signal: ctx.signal, timeoutMs: config.timeoutMs })));
            if (results.some((result) => !result)) return toolError("backend_unavailable", "Document deletion is not available.");
            return toolOk({ deleted: results.reduce((sum, result) => sum + Number(result?.deleted ?? 0), 0), requested: ids.length });
        }),
    });
}
/**
 * Create the document upload tool
 */
function createDocumentUploadTool(backend, config) {
    return defineTool({
        name: "oc_document_upload",
        kind: "read",
        description: "Upload a document to the knowledge base for later RAG search. The document will be chunked and indexed.",
        parameters: {
            content: {
                type: "string",
                required: true,
                description: "Document content (text)",
            },
            filename: {
                type: "string",
                required: true,
                description: "Document filename (e.g. 'spec.pdf' or 'notes.md')",
            },
            mimeType: {
                type: "string",
                description: "MIME type (e.g. 'application/pdf', 'text/plain')",
            },
            metadata: {
                type: "object",
                additionalProperties: true,
                description: "Optional metadata (e.g. { category: 'spec', version: '1.0' })",
            },
        },
        execute: async (args, ctx) => runTool(async () => {
            const content = String(args.content ?? "");
            if (!content)
                return toolError("invalid_arguments", "content is required");
            const filename = validation.text(String(args.filename ?? "").trim(), "filename", 1024);
            const metadata = validation.metadata(asRecord(args.metadata));
            const { scopeId, userId } = asKnowledgeWriteScope(ctx, config);
            const result = await backend.uploadDocument?.({
                content,
                filename,
                mimeType: typeof args.mimeType === "string" ? args.mimeType : "text/plain",
                metadata,
                scopeId,
                userId,
            }, { signal: ctx.signal, timeoutMs: config.knowledgeUploadTimeoutMs ?? 600000 });
            if (!result) {
                return toolError("backend_unavailable", "Document upload is not available because the backend does not expose a knowledge store.");
            }
            return toolOk({
                documentId: result.documentId ?? "",
                chunks: result.chunks ?? 0,
                semanticIndexed: result.semanticIndexed === true,
                semanticPending: result.semanticPending === true,
                ...(typeof result.semanticErrorCode === "string" ? { semanticErrorCode: result.semanticErrorCode } : {}),
            });
        }),
    });
}
/**
 * Create the document list tool
 */
function createDocumentListTool(backend, config) {
    return defineTool({
        name: "oc_document_list",
        kind: "read",
        description: "List all documents in the knowledge base for the current scope",
        parameters: {
            limit: {
                type: "number",
                description: "Maximum documents to return (default 50, max 200).",
            },
        },
        execute: async (args, ctx) => runTool(async () => {
            const plan = await asKnowledgeReadPlan(backend, ctx, config);plan.timeoutMs = config.timeoutMs;
            const limit = coerceLimit(args.limit, 50, 200);
            const documents = await documentsByScope(backend, plan, ctx, 200);
            if (typeof backend.listDocuments !== "function") {
                return toolOk({
                    documents: [],
                    note: "Document listing is not available because the backend does not expose a knowledge store.",
                });
            }
            return toolOk({
                documents: documents.sort((a, b) => Number(b.uploadedAt ?? 0) - Number(a.uploadedAt ?? 0)).slice(0, limit).map((doc) => ({
                    id: doc.id,
                    scopeId: doc.scopeId,
                    filename: doc.filename,
                    mimeType: doc.mimeType,
                    uploadedAt: doc.uploadedAt ?? Date.now(),
                    chunks: doc.chunks ?? 0,
                    metadata: doc.metadata ?? {},
                    semanticIndexed: doc.semanticIndexed === true,
                    semanticPending: doc.semanticPending === true,
                })),
            });
        }),
    });
}
export function makeKnowledgeTools(backend, config) {
    return [
        ...publicAndCompatibility(createKnowledgeSearchTool(backend, config), "knowledge_search"),
        ...publicAndCompatibility(createDocumentUploadTool(backend, config), "knowledge_document_upload"),
        ...publicAndCompatibility(createDocumentListTool(backend, config), "knowledge_document_list"),
        createDocumentChunksTool(backend, config),
        createDocumentReindexTool(backend, config),
        createDocumentDeleteTool(backend, config),
    ];
}
export function registerKnowledgeTools(ctx, runtime, defineTool) {
    const tools = makeKnowledgeTools(runtime.backend, runtime.config);
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
//# sourceMappingURL=tools-knowledge.js.map
