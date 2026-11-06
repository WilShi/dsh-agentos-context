/**
 * Secret-pattern detection and redaction.
 *
 * The pattern set is a curated subset that flags obvious credential-shaped
 * strings in user-supplied content. Automatic capture refuses to persist or
 * forward anything matching these patterns; explicit save paths reject them
 * with SECRET_REJECTED so the caller can redact first.
 *
 * Conservative on purpose — false positives only cost a skipped capture or an
 * actionable error, which is the safe failure mode.
 */
const SECRET_PATTERNS = [
    /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{20,})/, // OpenAI / DeepSeek / Anthropic style
    /(?:^|[^A-Za-z0-9])(?:sk-ant-[A-Za-z0-9_-]{20,})/, // Anthropic
    /(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,})/, // GitHub tokens (pat, oauth, user, server, refresh)
    /(?:^|[^A-Za-z0-9])(?:xox[abposr]-[A-Za-z0-9-]{10,})/, // Slack
    /(?:^|[^A-Za-z0-9])(?:AKIA[0-9A-Z]{16})/, // AWS access key
    /(?:^|[^A-Za-z0-9])(?:ASIA[0-9A-Z]{16})/, // AWS temporary access key
    /(?:^|[^A-Za-z0-9])(?:AIza[0-9A-Za-z_-]{35})/, // Google API key
    /(?:^|[^A-Za-z0-9])(?:glpat-[A-Za-z0-9_-]{20,})/, // GitLab PAT
    /(?:^|[^A-Za-z0-9])(?:npm_[A-Za-z0-9]{36})/, // npm token
    /(?:\bBEGIN [A-Z ]*PRIVATE KEY\b)/, // PEM private key
    /(?:\bpassword\s*[:=]\s*\S{6,})/i,
    /(?:\bsecret\s*[:=]\s*\S{6,})/i,
    /(?:\btoken\s*[:=]\s*[A-Za-z0-9._-]{16,})/i,
    /\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/=-]{16,}/i,
    /\b(?:api[-_]?key|access[-_]?key|secret[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|authorization)\s*[:=]\s*["']?[^\s"']{8,}/i,
];
export function containsSecret(content) {
    if (typeof content !== 'string' || content.length === 0) return false;
    for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(content)) return true;
    }
    return false;
}
/** Mask long credential-shaped runs so they can appear in diagnostics. */
export function redactSecrets(value) {
    if (typeof value !== 'string') return value;
    return value
        .replace(/sk-(?:ant-)?[A-Za-z0-9_-]{8,}/g, 'sk-***')
        .replace(/gh[pousr]_[A-Za-z0-9]{8,}/g, 'gh*_***')
        .replace(/xox[abposr]-[A-Za-z0-9-]{6,}/g, 'xox*-***')
        .replace(/AKIA[0-9A-Z]{8,}/g, 'AKIA***')
        .replace(/ASIA[0-9A-Z]{8,}/g, 'ASIA***')
        .replace(/AIza[0-9A-Za-z_-]{8,}/g, 'AIza***')
        .replace(/glpat-[A-Za-z0-9_-]{8,}/g, 'glpat-***')
        .replace(/npm_[A-Za-z0-9]{8,}/g, 'npm_***')
        .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY-----')
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***')
        .replace(/((?:password|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|authorization)\s*[:=]\s*)[^\s,;"']{6,}/gi, '$1***');
}
/** True when any of the strings looks like a credential. */
export function containsAnySecret(...values) {
    return values.some((value) => containsSecret(value));
}
