/**
 * HttpBackend — `fetch()`-based implementation of OpenContextBackend.
 *
 * Activated when `OPENCONTEXT_DSH_HTTP_URL` is set. Paths are prefixed
 * `/v1/memory/*` and `/v1/context/*`, aligned with the OpenContext
 * HTTP daemon shape so future server releases can be wired in without
 * breaking the tool surface. This mode is forward-looking: the v0.1.x
 * OpenContext daemon does not yet expose these endpoints, so requests
 * will fail with structured `backend_unavailable` / `version_mismatch`
 * errors until a compatible server ships. Lib mode is the supported
 * path on day one; HTTP mode is opt-in for users who can stand up a
 * compatible server.
 */
import { constants, classifyBackendError } from "./errors.js";
import { redactSecrets } from "./secrets.js";
function requestSignal(timeoutMs, caller) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs ?? 30_000);
    const abort = () => controller.abort(caller?.reason ?? new DOMException("Aborted", "AbortError"));
    if (caller?.aborted) abort();
    else caller?.addEventListener("abort", abort, { once: true });
    return {
        signal: controller.signal,
        dispose() { clearTimeout(timer); caller?.removeEventListener("abort", abort); },
    };
}
function normalizeBaseUrl(value) {
    let url; try { url = new URL(value); } catch { throw Object.assign(new Error('invalid backend URL'), { code: 'INVALID_INPUT' }); }
    const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) throw Object.assign(new Error('untrusted backend URL'), { code: 'INVALID_INPUT' });
    return url.href.replace(/\/+$/, '');
}
function joinUrl(base, path) { return base + (path.startsWith('/') ? path : '/' + path); }
class HttpClientError extends Error {
    statusCode;
    code;
    payload;
    constructor(statusCode, code, message, payload) {
        super(message);
        this.name = "HttpClientError";
        this.statusCode = statusCode;
        this.code = code;
        this.payload = payload;
    }
}
export function createHttpBackend(config, options = {}) {
    const baseUrl = normalizeBaseUrl(process.env.OPENCONTEXT_DSH_HTTP_URL?.trim() || config.baseUrl);
    const fetcher = options.fetcher ?? fetch;
    async function authorization() {
        const env = process.env.OPENCONTEXT_DSH_AUTHORIZATION?.trim();
        if (env) return env;
        try { return (await options.credentials?.resolve?.(config.authorizationRef))?.value?.trim() ?? ""; }
        catch { return ""; }
    }
    async function request(method, path, body, opts) {
        const headers = {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": constants.PLUGIN_NAME + "/0.1.0",
        };
        const auth = await authorization();
        if (auth) headers.Authorization = auth;
        const url = joinUrl(baseUrl, path);
        const request = requestSignal(opts?.timeoutMs ?? config.timeoutMs, opts?.signal);
        let response;
        try {
            response = await fetcher(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: request.signal, redirect: "error" });
        } catch (error) {
            const cls = classifyBackendError(error);
            throw new HttpClientError(cls.statusCode ?? 0, cls.code, cls.message, null);
        } finally { request.dispose(); }
        const text = await response.text();
        let json = null;
        if (text) { try { json = JSON.parse(text); } catch { json = text; } }
        if (!response.ok) {
            const cls = classifyBackendError({ statusCode: response.status, code: "UPSTREAM", message: "upstream request failed" });
            throw new HttpClientError(response.status, cls.code, cls.message, null);
        }
        return json;
    }
    function scopeIdOf(input) {
        return input.scopeId || config.scopeId || "local:unknown";
    }
    async function search(input, opts) {
        const scopeId = scopeIdOf(input);
        const payload = {
            scope_id: scopeId,
            query: input.query,
            limit: Math.max(1, Math.min(50, input.limit ?? config.maxRecallItems)),
            mode: "auto",
        };
        const res = await request("POST", "/v1/memory/search", payload, opts);
        return (res.results ?? []).map((hit) => ({
            id: hit.id,
            content: hit.content,
            score: hit.score,
            timestamp: hit.timestamp,
            metadata: hit.metadata,
            userId: hit.userId ?? scopeId,
            scopeId: hit.scopeId ?? scopeId,
        }));
    }
    async function remember(input, opts) {
        const scopeId = scopeIdOf(input);
        const payload = {
            scope_id: scopeId,
            kind: input.metadata?.kind ?? "agent-note",
            text: input.content,
            reason: input.metadata?.reason,
        };
        const res = await request("POST", "/v1/memory/remember", payload, opts);
        return { ids: res.ids ?? [] };
    }
    async function list(input, opts) {
        const scopeId = scopeIdOf(input);
        const payload = {
            scope_id: scopeId,
            limit: Math.max(1, Math.min(500, input.limit ?? 50)),
            since: input.since,
        };
        const res = await request("POST", "/v1/memory/list", payload, opts);
        return res.items ?? [];
    }
    async function get(input, opts) {
        const scopeId = scopeIdOf(input);
        const payload = { scope_id: scopeId, ids: input.ids };
        const res = await request("POST", "/v1/memory/get", payload, opts);
        return res.items ?? [];
    }
    async function revise(input, opts) {
        const scopeId = scopeIdOf(input);
        const payload = {
            scope_id: scopeId,
            citation: input.id,
            kind: input.metadata?.kind ?? "agent-note",
            text: input.content,
            reason: input.reason,
        };
        const res = await request("POST", "/v1/memory/revise", payload, opts);
        return {
            deprecatedId: res.deprecatedId ?? input.id,
            newId: res.newId ?? input.id,
        };
    }
    async function retire(input, opts) {
        const scopeId = scopeIdOf(input);
        const payload = {
            scope_id: scopeId,
            citation: input.id,
            reason: input.reason,
        };
        await request("POST", "/v1/memory/retire", payload, opts);
        return { ok: true };
    }
    async function captureSource(input, opts) {
        const scopeId = scopeIdOf(input);
        const payload = {
            scope_id: scopeId,
            source_id: input.metadata?.sourceId,
            content: input.content,
            metadata: {
                origin: "dsh",
                sourceType: input.sourceType,
                ...(input.metadata ?? {}),
            },
        };
        const res = await request("POST", "/v1/memory/capture_source", payload, opts);
        return { id: res.id };
    }
    async function health() {
        try {
            await request("GET", "/health/live", undefined, { timeoutMs: Math.min(config.timeoutMs, 2000) });
            return { ok: true, mode: "http", details: "configured memory backend is reachable" };
        }
        catch (error) {
            const classified = classifyBackendError(error);
            return { ok: false, mode: "http", details: classified.message };
        }
    }
    return {
        mode: "http",
        search,
        remember,
        list,
        get,
        revise,
        retire,
        captureSource,
        health,
    };
}
//# sourceMappingURL=backend-http.js.map