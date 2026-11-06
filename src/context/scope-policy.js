/**
 * RPC scope authorization (HOST-REVIEW H2).
 *
 * The Connection-RPC surface accepts a caller-supplied `scopeId`. Workspace,
 * run, session and global scopes stay fully available so the local "all scopes"
 * workspace view keeps working. Identity partitions (user:/agent:/app:) are
 * only reachable when they are explicitly configured or vouched for by the
 * host: either the session named in the request, or a session this process has
 * already bootstrapped. `allowForeignScopeIds` restores the pre-0.7.1
 * permissive behavior for operators who need it.
 */
import { GLOBAL_SCOPE_ID, createEntityScope, resolveContextIdentity } from './scope.js';

export const IDENTITY_SCOPE_KINDS = Object.freeze(['user', 'agent', 'app']);
const WORKSPACE_PREFIXES = Object.freeze(['local:', 'session:', 'run:']);

function kindOf(scopeId) {
    const separator = scopeId.indexOf(':');
    return separator > 0 ? scopeId.slice(0, separator) : '';
}

function identityScopesOfSession(session, config) {
    try {
        return resolveContextIdentity({ session }, config).scopes
            .filter(row => IDENTITY_SCOPE_KINDS.includes(row.kind))
            .map(row => row.id);
    }
    catch {
        return [];
    }
}

export function configuredIdentityScope(config, kind) {
    const value = kind === 'user' ? config?.scopeUserId : kind === 'agent' ? config?.scopeAgentId : config?.scopeAppId;
    return typeof value === 'string' && value.trim() ? createEntityScope(kind, value) : null;
}

export function createRpcScopePolicy({ config = {}, sessions } = {}) {
    const vouched = new Set();
    const trust = sessionId => {
        const session = typeof sessionId === 'string' && sessionId && typeof sessions?.get === 'function'
            ? sessions.get(sessionId)
            : undefined;
        if (session) for (const id of identityScopesOfSession(session, config)) vouched.add(id);
    };
    const allows = (scopeId, input = {}) => {
        if (typeof scopeId !== 'string' || scopeId.length === 0) return false;
        if (scopeId === GLOBAL_SCOPE_ID) return true;
        if (WORKSPACE_PREFIXES.some(prefix => scopeId.startsWith(prefix))) return true;
        const kind = kindOf(scopeId);
        if (!IDENTITY_SCOPE_KINDS.includes(kind)) return true;
        if (config?.allowForeignScopeIds === true) return true;
        if (configuredIdentityScope(config, kind) === scopeId) return true;
        if (typeof input.sessionId === 'string' && input.sessionId) trust(input.sessionId);
        return vouched.has(scopeId);
    };
    return { allows, trust };
}

/** Hide scope rows a caller may not use from bootstrap/scopes responses. */
export function filterBootstrapScopes(value, policy) {
    if (!value || typeof value !== 'object') return value;
    const keep = row => row && typeof row.id === 'string' ? policy.allows(row.id) : false;
    const allowedIds = new Set();
    const scopes = Array.isArray(value.scopes) ? value.scopes.filter(keep) : [];
    for (const row of scopes) allowedIds.add(row.id);
    const currentScopes = Array.isArray(value.currentScopes) ? value.currentScopes.filter(keep) : value.currentScopes;
    if (Array.isArray(currentScopes)) for (const row of currentScopes) allowedIds.add(row.id);
    const recallOrder = Array.isArray(value.recallOrder) ? value.recallOrder.filter(id => allowedIds.has(id)) : value.recallOrder;
    const compatibilityScopes = Array.isArray(value.compatibilityScopes) ? value.compatibilityScopes.filter(id => policy.allows(id)) : value.compatibilityScopes;
    return { ...value, scopes, currentScopes, recallOrder, compatibilityScopes };
}
