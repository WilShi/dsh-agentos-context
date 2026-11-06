import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTrustedGatewayBase, trustedGatewayBases } from '../src/gateway-policy.js';
import { createGatewayEmbeddingProvider } from '../src/gateway-embedding-provider.ts';

// Public build: no deployment gateway is baked in. A deployment opts in by
// listing its exact base in OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES at process
// startup; plain HTTP is only reachable for loopback hosts.
const LOOPBACK = 'http://127.0.0.1:8090/llm-service/v1';
const ENV = 'OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES';

async function withAllowlist(value, run) {
  const previous = process.env[ENV];
  try {
    if (value === undefined) delete process.env[ENV];
    else process.env[ENV] = value;
    return await run();
  } finally {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  }
}

function providerConfig(overrides = {}) {
  return { embeddingBaseUrl: LOOPBACK, embeddingModel: 'm', apiKeyEnv: 'OWN_REF', embeddingBatchSize: 10, embeddingTimeoutMs: 1000, ...overrides };
}

test('public build ships no gateway allowlist, so every base is untrusted until configured', async () => {
  await withAllowlist(undefined, () => {
    assert.deepEqual([...trustedGatewayBases()], []);
    assert.throws(() => assertTrustedGatewayBase('https://gateway.example/v1'), { code: 'UNTRUSTED_GATEWAY' });
    assert.throws(() => assertTrustedGatewayBase(LOOPBACK), { code: 'UNTRUSTED_GATEWAY' });
  });
});

test('the startup allowlist accepts exact bases and normalizes trailing slashes', async () => {
  await withAllowlist(`https://gateway.example/v1; ${LOOPBACK}/`, () => {
    assert.equal(assertTrustedGatewayBase('https://gateway.example/v1/'), 'https://gateway.example/v1');
    assert.equal(assertTrustedGatewayBase(LOOPBACK + '/'), LOOPBACK);
    for (const value of ['https://gateway.example/v1/other', 'https://evil.example/v1', 'http://127.0.0.1:8090/llm-service/v1?next=evil', 'http://user:pass@127.0.0.1:8090/llm-service/v1']) {
      assert.throws(() => assertTrustedGatewayBase(value), { code: 'UNTRUSTED_GATEWAY' });
    }
  });
});

test('plain HTTP is rejected for non-loopback hosts even when allowlisted', async () => {
  await withAllowlist('http://gateway.example/v1', () => {
    assert.throws(() => trustedGatewayBases(), { code: 'UNTRUSTED_GATEWAY' });
  });
});

test('embedding provider captures its credential ref and rejects redirected or changed gateways', async () => {
  await withAllowlist(LOOPBACK, async () => {
    const refs = [], calls = [];
    const config = providerConfig();
    const provider = createGatewayEmbeddingProvider(
      { credentials: { resolve: async ref => (refs.push(ref), { value: 'secret' }) } },
      config,
      { fetcher: async (url, init) => (calls.push({ url, init }), { ok: true, json: async () => ({ data: [{ embedding: [1, 2] }] }) }) },
    );
    await provider.embedQuery('text');
    assert.deepEqual(refs, ['OWN_REF']);
    assert.equal(calls[0].url, LOOPBACK + '/bge/embeddings');
    assert.equal(calls[0].init.redirect, 'error');
    config.apiKeyEnv = 'OTHER_REF';
    config.embeddingBaseUrl = 'https://evil.example/v1';
    await assert.rejects(provider.embedQuery('more'), { code: 'UNTRUSTED_GATEWAY' });
    assert.deepEqual(refs, ['OWN_REF']);
  });
});

test('embedding provider retries transient gateway failures but never retries credential errors', async () => {
  await withAllowlist(LOOPBACK, async () => {
    let calls = 0;
    const provider = createGatewayEmbeddingProvider(
      { credentials: { resolve: async () => ({ value: 'secret' }) } },
      providerConfig(),
      { fetcher: async () => { calls++; return calls < 3 ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, 2] }] }) }; } },
    );
    assert.deepEqual(await provider.embedQuery('text'), [1, 2]);
    assert.equal(calls, 3);
    let authCalls = 0;
    const denied = createGatewayEmbeddingProvider(
      { credentials: { resolve: async () => ({ value: 'secret' }) } },
      providerConfig(),
      { fetcher: async () => { authCalls++; return { ok: false, status: 403, json: async () => ({ code: 804 }) }; } },
    );
    await assert.rejects(denied.embedQuery('text'), { code: 'EMBEDDING_NO_PERMISSION' });
    assert.equal(authCalls, 1);
  });
});

test('embedding availability follows credential changes without retaining the secret', async () => {
  await withAllowlist(LOOPBACK, async () => {
    let value;
    const provider = createGatewayEmbeddingProvider(
      { credentials: { resolve: async () => value === undefined ? undefined : { value } } },
      providerConfig(),
      { fetcher: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, 2] }] }) }) },
    );
    assert.equal(await provider.isConfigured(), false);
    value = 'rotated-secret';
    assert.equal(await provider.isConfigured(), true);
    value = '';
    assert.equal(await provider.isConfigured(), false);
  });
});

test('a missing embedding credential surfaces an actionable setup error', async () => {
  await withAllowlist(LOOPBACK, async () => {
    const provider = createGatewayEmbeddingProvider(
      { credentials: { resolve: async () => undefined } },
      providerConfig({ apiKeyEnv: 'AGENTOS_CONTEXT_API_KEY' }),
      { fetcher: async () => { throw new Error('must not fetch without a key'); } },
    );
    await assert.rejects(provider.embedQuery('text'), (error) => error.code === 'EMBEDDING_KEY_MISSING' && /AGENTOS_CONTEXT_API_KEY/.test(error.message));
  });
});