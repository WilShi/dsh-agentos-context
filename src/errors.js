/**
 * Error taxonomy for dsh-opencontext.
 *
 * Every tool and the recall/capture waterfall report failures as
 * `{ ok: false, code: ..., message: ... }` — never throw to the model.
 * These error codes are stable strings the host can switch on.
 */
export function toolOk(data) {
    return { ok: true, data };
}
export function toolError(code, message) {
    return { ok: false, code, message };
}
const MAX_CONTEXT_BYTES_DEFAULT = 8_000;
const MAX_SOURCE_LENGTH = 200_000;
export function classifyBackendError(error) {
    const err = error ?? {};
    if (err.name === "AbortError" || err.name === "TimeoutError" || err.code === "ABORTED") return { code: "timeout", message: "operation timed out or was cancelled" };
    if (err.name === "KnowledgeUnavailableError" || err.name === "TypeError" || err instanceof TypeError) return { code: "backend_unavailable", message: "memory backend is not available" };
    if (typeof err.statusCode === "number") {
        if (err.statusCode === 401 || err.statusCode === 403) return { code: "authentication_failed", message: "memory backend authentication failed", statusCode: err.statusCode };
        if (err.statusCode === 404) return { code: "version_mismatch", message: "memory backend endpoint is not available", statusCode: err.statusCode };
        if (err.statusCode === 408) return { code: "timeout", message: "memory backend request timed out", statusCode: err.statusCode };
        if (err.statusCode >= 500) return { code: "server_unavailable", message: "memory backend is temporarily unavailable", statusCode: err.statusCode };
        if (err.statusCode >= 400) return { code: "invalid_response", message: "memory backend rejected the request", statusCode: err.statusCode };
    }
    const known = new Map([
        ["INVALID_INPUT", "the request is invalid"], ["NOT_FOUND", "the record is unavailable"], ["VERSION_CONFLICT", "the record changed; refresh and retry"],
        ["IDEMPOTENCY_CONFLICT", "the operation identifier conflicts with an earlier request"], ["SECRET_REJECTED", "credential-shaped content was rejected"],
        ["LIMIT_EXCEEDED", "the request exceeds the supported limit"], ["STORE_FULL", "local disk space is exhausted"], ["STORE_UNAVAILABLE", "memory storage is unavailable"], ["STORE_CLOSED", "memory storage is closed"],
    ]);
    if (typeof err.code === "string" && known.has(err.code)) return { code: err.code.toLowerCase(), message: known.get(err.code) };
    return { code: "internal_error", message: "memory operation failed" };
}
export const constants = {
    MAX_CONTEXT_BYTES_DEFAULT,
    MAX_SOURCE_LENGTH,
    PLUGIN_NAME: "dsh-agentos-context",
    REQUEST_ID_HEADER: "X-OpenContext-Request-ID",
};
//# sourceMappingURL=errors.js.map
