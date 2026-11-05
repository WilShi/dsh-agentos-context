/**
 * OpenContextBackend — the abstract surface that tools, recall, and
 * capture call into. Two concrete implementations exist: `LibBackend`
 * (in-process, calls `@melandlabs/opencontext` directly) and
 * `HttpBackend` (POST against an external OpenContext daemon).
 *
 * The two modes are deliberately shape-compatible so tools and listeners
 * never need to know which one is active.
 */
import { createHttpBackend } from "./backend-http.js";
import { createLibBackend } from "./backend-lib.js";
import { isHttpMode } from "./config.js";
export function createBackend(config, options = {}) {
    if (isHttpMode()) {
        return createHttpBackend(config, options);
    }
    return createLibBackend(config, options);
}
//# sourceMappingURL=backend.js.map