/**
 * Tiny assertion helper. The full dsh convention is to use a separate
 * `ts-invariant` style helper; we keep an in-tree copy so the plugin has
 * zero runtime dependencies beyond `@melandlabs/opencontext`.
 */
export function invariant(condition, message) {
    if (!condition) {
        throw new Error(`[dsh-opencontext] invariant: ${message}`);
    }
}
export function invariantString(value, field) {
    invariant(typeof value === "string", `${field} must be a string`);
    return value;
}
export function invariantNumber(value, field) {
    invariant(typeof value === "number" && Number.isFinite(value), `${field} must be a finite number`);
    return value;
}
//# sourceMappingURL=invariant.js.map