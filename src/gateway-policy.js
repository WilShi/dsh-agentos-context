/** Exact process-startup allowlist for gateways that may receive a credential. */
const DEFAULT_BASES = [];
const fail = () => Object.assign(new Error('网关地址不在 agentOS context 信任列表中'), { code: 'UNTRUSTED_GATEWAY' });

function normalize(value) {
  if (typeof value !== 'string' || !value.trim()) throw fail();
  let url;
  try { url = new URL(value); } catch { throw fail(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw fail();
  return url.href.replace(/\/+$/, '');
}

function mayUsePlainHttp(url) {
    const host = new URL(url).hostname;
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
}

export function trustedGatewayBases(env = process.env) {
  const extra = typeof env?.OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES === 'string'
    ? env.OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES.split(/[;,]/).map(x => x.trim()).filter(Boolean)
    : [];
  const set = new Set(DEFAULT_BASES);
  for (const value of extra) {
    const normalized = normalize(value);
    if (new URL(normalized).protocol === 'http:' && !mayUsePlainHttp(normalized)) throw fail();
    set.add(normalized);
  }
  return set;
}

export function assertTrustedGatewayBase(value, env = process.env) {
  const normalized = normalize(value);
  if (new URL(normalized).protocol === 'http:' && !mayUsePlainHttp(normalized)) throw fail();
  if (!trustedGatewayBases(env).has(normalized)) throw fail();
  return normalized;
}