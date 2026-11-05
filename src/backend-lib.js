/**
 * LibBackend — in-process implementation of OpenContextBackend.
 *
 * Calls `@melandlabs/opencontext` directly:
 *   - `createUnifiedSearch().search` for search
 *   - `getRawMessageManager().storeMessages` / `queryMessages` /
 *     `getMessageById` / `deprecateMessages` for memory CRUD
 *
 * Legacy storage is imported and initialised on first use; disposing an
 * unused backend never loads it. The unified search
 * requires an embedding provider; when none is configured the search
 * falls back to the raw-message lexical search so the plugin still
 * returns something useful out of the box.
 */
import { createHash, randomUUID } from "node:crypto";
import { classifyBackendError } from "./errors.js";
import { LibKnowledgeStore } from "./knowledge-store.js";
let _createUnifiedSearch = null;
let _createUnifiedSearchProbed = false;
async function probeUnifiedSearchFactory() {
    if (!_createUnifiedSearchProbed) {
        _createUnifiedSearchProbed = true;
        try {
            const mod = await import("@melandlabs/opencontext");
            const factory = mod.createUnifiedSearch;
            if (typeof factory === "function") {
                _createUnifiedSearch = factory;
            }
        }
        catch {
            _createUnifiedSearch = null;
        }
    }
    return _createUnifiedSearch;
}
const DEFAULT_BOT_ID = "dsh";
function makeIdempotentId(seed) {
    return `dsh-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}
/** Distinct user scopes present in the store (recent 500 rows are enough to
 * cover every active workspace scope; memory browsers query all of them). */
async function distinctUserScopes(manager) {
    const records = await manager.queryMessages({ platform: "dsh", limit: 500, reverse: true });
    const scopes = new Set();
    for (const record of records ?? []) {
        if (typeof record.userId === "string" && record.userId.length > 0) {
            scopes.add(record.userId);
        }
    }
    return [...scopes];
}
function nowMs() {
    return Date.now();
}
async function withTimeout(promise, timeoutMs, signal) {
    const effectiveSignal = signal ?? (timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined);
    if (!effectiveSignal)
        return promise;
    return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`operation timed out after ${timeoutMs}ms`));
        }, timeoutMs ?? 30_000);
        effectiveSignal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("operation aborted"));
        });
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
function asMemoryItem(raw) {
    const r = raw;
    return {
        id: r.messageId ?? r.id ?? "",
        content: r.content ?? "",
        timestamp: typeof r.timestamp === "number" ? r.timestamp : undefined,
        metadata: r.metadata,
        platform: r.platform,
        botId: r.botId,
        userId: r.userId,
        channel: r.channel,
    };
}
export function createLibBackend(config, options = {}) {
    // model-gateway edition: an embedding provider wired in by index.js (company
    // gateway, per-call credential resolve). When present it repairs the two
    // upstream gaps that kept sqlite-vec empty: unified search got no
    // embedQuery, and remember() never wrote embedding fields.
    const embeddingProvider = options.embeddingProvider ?? null;
    async function canUseEmbedding() {
        if (!embeddingProvider)
            return false;
        if (typeof embeddingProvider.isConfigured !== "function")
            return true;
        try {
            return await embeddingProvider.isConfigured();
        }
        catch {
            return false;
        }
    }
    async function getUnifiedSearch() {
        const factory = await probeUnifiedSearchFactory();
        if (typeof factory !== "function")
            return undefined;
        if (embeddingProvider) {
            // The facade invokes embedQuery({userId, query, authToken}) —
            // hand it the provider's string-taking embedQuery.
            return factory({ embedQuery: (q) => embeddingProvider.embedQuery(q?.query ?? q) });
        }
        return factory();
    }
    let initPromise;
    async function ensureInit() {
        if (initPromise)
            return initPromise;
        initPromise = (async () => {
            // @melandlabs/opencontext is an OPTIONAL peer in the slim build: the
            // own SQLite context/knowledge stores keep working without it, but the
            // legacy OpenContext raw-message facade does not. Fail with an
            // actionable error instead of a raw module-not-found.
            let mod;
            try {
                mod = await import("@melandlabs/opencontext");
            }
            catch (error) {
                initPromise = undefined;
                throw Object.assign(new Error("OpenContext 组件未安装：旧版记忆/RAG 接口不可用（自建 context/知识库存储不受影响）。安装后在 DSH 中重试：pnpm add @melandlabs/opencontext"), { code: "OPENCONTEXT_UNAVAILABLE", cause: error });
            }
            const { getRawMessageManager, isRawMessageStorageAvailable } = mod;
            const ready = isRawMessageStorageAvailable();
            const manager = (await getRawMessageManager());
            const search = await getUnifiedSearch();
            return { manager, search, ready };
        })();
        return initPromise;
    }
    const resolveUser = (override) => override || config.scopeId || "dsh-default";
    const resolveBot = (override) => override || DEFAULT_BOT_ID;
    let knowledgeStore = options.knowledgeStore ?? null;
    function getKnowledgeStore() {
        if (!knowledgeStore) {
            knowledgeStore = new LibKnowledgeStore(embeddingProvider ? { provider: embeddingProvider } : {});
        }
        return knowledgeStore;
    }
    async function search(input, opts) {
        const { manager, search, ready } = await ensureInit();
        if (!ready)
            return [];
        const limit = Math.max(1, Math.min(50, input.limit ?? config.maxRecallItems));
        const threshold = typeof input.threshold === "number" ? input.threshold : 0.5;
        const query = input.query.trim();
        if (!query)
            return [];
        // UI 浏览器路径不传 userId 且 scopeId 为空时按全部 scope 查询
        // （agent 侧记忆按 local:<cwd> 工作区 scope 存储，固定过滤 dsh-default
        // 会全漏 —— 2026-09-01 用户列表为空事故根因）。显式传入时保持单 scope。
        const explicitUserId = input.userId ?? (config.scopeId || undefined);
        const runUnified = async (userId) => {
            const result = await withTimeout(search.search({ userId, query, limit, threshold }), opts?.timeoutMs ?? config.timeoutMs, opts?.signal);
            const hits = [];
            for (const r of result.results ?? []) {
                const ts = typeof r.metadata?.timestamp === "number" ? r.metadata.timestamp : undefined;
                hits.push({
                    id: r.id,
                    content: r.content,
                    score: r.similarity,
                    timestamp: ts,
                    metadata: r.metadata,
                    userId,
                });
            }
            return hits;
        };
        if (search && await canUseEmbedding()) {
            try {
                if (explicitUserId !== undefined) {
                    const hits = await runUnified(explicitUserId);
                    if (hits.length > 0)
                        return hits;
                }
                else {
                    // 语义搜索仅支持精确单 userId：按 distinct user_id 逐个查并归并
                    const scopes = await distinctUserScopes(manager);
                    const merged = [];
                    const seen = new Set();
                    for (const scope of scopes) {
                        for (const hit of await runUnified(scope)) {
                            if (seen.has(hit.id))
                                continue;
                            seen.add(hit.id);
                            merged.push(hit);
                        }
                    }
                    merged.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
                    if (merged.length > 0)
                        return merged.slice(0, limit);
                }
            }
            catch {
                // Fall through to lexical search below.
            }
        }
        // Fallback: lexical search via the raw-message manager.
        const keywords = query
            .toLowerCase()
            .split(/[^\p{L}\p{N}]+/u)
            .filter((token) => token.length >= 2)
            .slice(0, 16);
        if (keywords.length === 0)
            return [];
        const records = await manager.queryMessages({
            ...(explicitUserId !== undefined ? { userId: explicitUserId } : {}),
            platform: "dsh",
            keywords,
            limit,
        });
        return (records ?? []).map((record) => {
            const item = asMemoryItem(record);
            return {
                id: item.id,
                content: item.content,
                score: 0.5,
                timestamp: item.timestamp,
                metadata: item.metadata ?? {},
                userId: item.userId ?? explicitUserId,
                scopeId: item.userId ?? explicitUserId,
            };
        });
    }
    async function remember(input, opts) {
        const { manager, ready } = await ensureInit();
        if (!ready)
            throw new Error("raw message storage is not available in this environment");
        const userId = resolveUser(input.userId);
        const botId = resolveBot(input.botId);
        const ts = nowMs();
        const messageId = makeIdempotentId(`${userId}|${botId}|${ts}|${input.content.slice(0, 256)}`);
        const record = {
            messageId,
            platform: "dsh",
            botId,
            userId,
            channel: input.metadata?.channel,
            timestamp: ts,
            content: input.content,
            metadata: {
                ...(input.metadata ?? {}),
                sourceType: input.sourceType ?? "user_request",
                origin: "dsh-opencontext",
            },
            createdAt: ts,
        };
        if (embeddingProvider && await canUseEmbedding()) {
            try {
                // Field names mirror the facade's storeMessages SQL columns
                // (embedding/embeddingModel/embeddingContentHash/
                // embeddingDimensions/embeddingUpdatedAt): a record carrying
                // `embedding` gets its vec row written alongside the message.
                const vector = await embeddingProvider.embedQuery(input.content.slice(0, 2000));
                record.embedding = vector;
                record.embeddingModel = embeddingProvider.getModelName();
                record.embeddingDimensions = vector.length;
                record.embeddingUpdatedAt = ts;
            }
            catch (error) {
                // embedding 失败不阻塞记忆写入（密钥未配/网关抖动时退化为纯文本记忆）
                console.warn("[dsh-opencontext] embed on remember failed:", error?.code ?? error);
            }
        }
        // M6 semantic dedup: reuse the single-scope search path (same userId
        // as the record being written) and gate on the nearest hit's score —
        //   score >= dedupSkipThreshold   → duplicate: return the existing id
        //                                   without writing (`deduped: 'skip'`);
        //   score >= dedupReviseThreshold → near-duplicate: the new row joins
        //                                   the revision chain via
        //                                   metadata.supersedes → existing id.
        // A caller-supplied supersedes (the revise() flow) takes precedence and
        // opts this record out of the dedup probe. Dedup failures (vec table
        // missing, gateway down) never block the write.
        if (embeddingProvider && config.dedupEnabled && record.embedding && record.metadata.supersedes === undefined) {
            try {
                // Probe text matches the record vector (both are the first
                // 2000 chars) so the compared embeddings cover the same span.
                const hits = await search({ query: input.content.slice(0, 2000), userId, limit: 1 }, opts);
                const top = hits?.[0];
                const score = top?.score ?? 0;
                if (top && score >= config.dedupSkipThreshold) {
                    return { ids: [top.id], deduped: "skip" };
                }
                if (top && score >= config.dedupReviseThreshold) {
                    record.metadata.supersedes = top.id;
                }
            }
            catch (error) {
                // 去重失败不阻塞写入（与上方 embed 失败同级，留可诊断痕迹）
                console.warn("[dsh-opencontext] dedup probe failed:", error?.code ?? error?.message ?? error);
            }
        }
        await withTimeout(manager.storeMessages([record]), opts?.timeoutMs ?? config.timeoutMs, opts?.signal);
        // `storeMessages` returns the autoincrement rowid; the public ID we
        // expose to the rest of the plugin is the `message_id` we constructed
        // (which is what `getMessageById` actually keys on).
        // Return contract: `{ ids: [messageId], deduped?: 'skip' }` — the
        // additive `deduped` field marks a skipped duplicate write (`ids` then
        // holds the pre-existing memory's id); existing callers only read
        // `ids[0]`, so the extra field is backward compatible.
        return { ids: [messageId] };
    }
    async function list(input, opts) {
        const { manager, ready } = await ensureInit();
        if (!ready)
            return [];
        // 不传 userId 且 scopeId 为空时查全部 scope（见 search() 的说明）；
        // facade 的 queryMessages 中 userId 为可选过滤项。
        const userId = input.userId ?? (config.scopeId || undefined);
        const records = await withTimeout(manager.queryMessages({
            ...(userId !== undefined ? { userId } : {}),
            platform: "dsh",
            limit: Math.max(1, Math.min(500, input.limit ?? 50)),
            offset: Number.isSafeInteger(input.offset) && input.offset > 0 ? input.offset : 0,
            startTime: input.since,
            reverse: true,
        }), opts?.timeoutMs ?? config.timeoutMs, opts?.signal);
        return (records ?? []).map(asMemoryItem);
    }
    async function get(input, opts) {
        const { manager, ready } = await ensureInit();
        if (!ready)
            return [];
        const results = [];
        for (const id of input.ids) {
            try {
                const raw = await withTimeout(manager.getMessageById(id), opts?.timeoutMs ?? config.timeoutMs, opts?.signal);
                if (raw)
                    results.push(asMemoryItem(raw));
            }
            catch {
                // Skip ids that fail to resolve; the tool caller will see them absent.
            }
        }
        return results;
    }
    async function revise(input, opts) {
        const { manager, ready } = await ensureInit();
        if (!ready)
            throw new Error("raw message storage is not available in this environment");
        const userId = resolveUser(input.userId);
        const botId = resolveBot(input.botId);
        if (typeof manager.deprecateMessages === "function") {
            await withTimeout(manager.deprecateMessages([input.id], {
                reason: input.reason ?? "revised",
                deprecatedAt: nowMs(),
                userId,
            }), opts?.timeoutMs ?? config.timeoutMs, opts?.signal);
        }
        const stored = await remember({
            content: input.content,
            metadata: {
                supersedes: input.id,
                reason: input.reason,
            },
            userId,
            botId,
        }, opts);
        const newId = stored.ids[0] ?? makeIdempotentId(`${userId}|${botId}|${nowMs()}|${input.content}`);
        return { deprecatedId: input.id, newId };
    }
    async function retire(input, opts) {
        const { manager, ready } = await ensureInit();
        if (!ready)
            return { ok: true };
        const userId = resolveUser(input.userId);
        if (typeof manager.deprecateMessages !== "function") {
            // No-op when the storage adapter doesn't support soft deprecation.
            return { ok: true };
        }
        await withTimeout(manager.deprecateMessages([input.id], {
            reason: input.reason ?? "retired",
            deprecatedAt: nowMs(),
            userId,
        }), opts?.timeoutMs ?? config.timeoutMs, opts?.signal);
        return { ok: true };
    }
    async function captureSource(input, opts) {
        const result = await remember({
            content: input.content,
            sourceType: input.sourceType ?? "user_input",
            metadata: input.metadata,
            userId: input.userId,
            botId: input.botId,
        }, opts);
        const id = result.ids[0] ?? makeIdempotentId(`${input.userId ?? "dsh-default"}|capture|${randomUUID()}`);
        return { id };
    }
    async function uploadDocument(input, opts) {
        const store = getKnowledgeStore();
        return await withTimeout(store.uploadDocument({
            content: input.content,
            filename: input.filename,
            mimeType: input.mimeType,
            metadata: input.metadata,
            scopeId: input.scopeId || config.scopeId || "dsh-default",
            userId: input.userId || config.scopeId || "dsh-default",
        }), opts?.timeoutMs ?? config.knowledgeUploadTimeoutMs ?? 600000, opts?.signal);
    }
    async function searchKnowledge(input, opts) {
        const store = getKnowledgeStore();
        return await withTimeout(store.searchKnowledge({
            query: input.query,
            documentIds: input.documentIds,
            limit: input.limit,
            threshold: input.threshold,
            searchMode: input.searchMode,
            metadata: input.metadata,
            scopeId: input.scopeId || config.scopeId || "dsh-default",
            userId: input.userId || config.scopeId || "dsh-default",
        }), opts?.timeoutMs ?? config.knowledgeSearchTimeoutMs ?? 30000, opts?.signal);
    }
    async function listDocuments(input, opts) {
        const store = getKnowledgeStore();
        return await withTimeout(store.listDocuments({
            limit: input.limit,
            scopeId: input.scopeId || config.scopeId || "dsh-default",
            userId: input.userId || config.scopeId || "dsh-default",
        }), opts?.timeoutMs ?? config.timeoutMs, opts?.signal);
    }
    async function listKnowledgeScopes(_input = {}, opts) {
        const store = getKnowledgeStore();
        return await withTimeout(store.listKnowledgeScopes(), opts?.timeoutMs ?? config.timeoutMs, opts?.signal);
    }
    async function deleteDocument(input, opts) {
        const store = getKnowledgeStore();
        return await withTimeout(store.deleteDocument({
            id: input.id,
            scopeId: input.scopeId || config.scopeId || "dsh-default",
            userId: input.userId || config.scopeId || "dsh-default",
        }), opts?.timeoutMs ?? config.timeoutMs, opts?.signal);
    }
    async function listDocumentChunks(input, opts) {
        const store = getKnowledgeStore();
        return await withTimeout(store.listDocumentChunks({
            id: input.id,
            limit: input.limit,
            scopeId: input.scopeId || config.scopeId || "dsh-default",
            userId: input.userId || config.scopeId || "dsh-default",
        }), opts?.timeoutMs ?? config.timeoutMs, opts?.signal);
    }
    async function reindexDocument(input, opts) {
        const store = getKnowledgeStore();
        return await withTimeout(store.reindexDocument({
            id: input.id,
            scopeId: input.scopeId || config.scopeId || "dsh-default",
            userId: input.userId || config.scopeId || "dsh-default",
        }), opts?.timeoutMs ?? config.knowledgeUploadTimeoutMs ?? 600000, opts?.signal);
    }
    async function deleteDocuments(input, opts) {
        const store = getKnowledgeStore();
        return await withTimeout(store.deleteDocuments({
            ids: input.ids,
            scopeId: input.scopeId || config.scopeId || "dsh-default",
            userId: input.userId || config.scopeId || "dsh-default",
        }), opts?.timeoutMs ?? config.timeoutMs, opts?.signal);
    }
    async function searchInsights(input, opts) {
        // userId 透传不强制默认：缺省时 search() 走全 scope 归并——M6 capture
        // 写入的 insight 按 local:<cwd> 工作区 scope 存储，固定过滤 dsh-default
        // 会让 oc_insights_search 永远看不到自动提炼产物（与 memory-list
        // scope 事故同类，2026-09-01）。显式传入时保持单 scope。
        // Search returns a stripped metadata view, so first get candidate IDs
        // by query, then fetch full records via get() to inspect sourceType/category.
        const hits = await search({
            query: input.query,
            limit: input.limit * 3,
            threshold: input.threshold,
            userId: input.userId,
        }, opts);
        if (hits.length === 0) {
            return { insights: [] };
        }
        // get() 按 id 逐条取，本身不读 scope 过滤。
        const fullItems = await get({ ids: hits.map((h) => h.id) }, opts);
        const itemById = new Map(fullItems.map((item) => [item.id, item]));
        const insights = [];
        for (const hit of hits) {
            const item = itemById.get(hit.id);
            if (!item)
                continue;
            if (item.metadata?.sourceType !== "insight")
                continue;
            if (input.categories &&
                input.categories.length > 0 &&
                !input.categories.includes(String(item.metadata?.category))) {
                continue;
            }
            insights.push({
                id: item.id,
                content: item.content,
                category: String(item.metadata?.category ?? "fact"),
                score: hit.score,
                timestamp: item.timestamp,
                metadata: item.metadata,
            });
        }
        return { insights: insights.slice(0, input.limit) };
    }
    async function captureInsight(input, opts) {
        const result = await remember({
            content: input.content,
            sourceType: "insight",
            metadata: {
                category: input.category,
                ...input.metadata,
            },
            scopeId: input.scopeId || config.scopeId || "dsh-default",
            userId: input.userId || config.scopeId || "dsh-default",
        }, opts);
        return { id: result.ids[0] ?? "" };
    }
    async function health() {
        try {
            const { ready, search } = await ensureInit();
            if (!ready) {
                return {
                    ok: false,
                    mode: "lib",
                    details: "raw message storage not initialised",
                };
            }
            const userId = resolveUser();
            if (search) {
                await withTimeout(search.search({
                    userId,
                    query: "__health__",
                    limit: 1,
                    threshold: -1,
                }), Math.min(config.timeoutMs, 2000), undefined);
            }
            return { ok: true, mode: "lib", details: "legacy compatibility storage is reachable" };
        }
        catch (error) {
            const classified = classifyBackendError(error);
            return { ok: false, mode: "lib", details: classified.message };
        }
    }
    async function dispose() {
        try {
            knowledgeStore?.close();
        }
        catch {
            // ignore
        }
        if (!initPromise)
            return;
        try {
            const mod = await import("@melandlabs/opencontext");
            const close = mod.closeRawMessageStore;
            if (typeof close === "function")
                await close();
        }
        catch {
            // ignore
        }
    }
    return {
        mode: "lib",
        search,
        remember,
        list,
        get,
        revise,
        retire,
        captureSource,
        uploadDocument,
        searchKnowledge,
        listDocuments,
        listKnowledgeScopes,
        deleteDocument,
        listDocumentChunks,
        reindexDocument,
        deleteDocuments,
        searchInsights,
        captureInsight,
        health,
        dispose,
    };
}
//# sourceMappingURL=backend-lib.js.map
