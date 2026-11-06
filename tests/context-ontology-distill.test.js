import test from 'node:test';
import assert from 'node:assert/strict';
import { createDistiller } from '../src/gateway-distill.ts';

// Public build: a deployment gateway must be opted in through the documented
// startup allowlist; the tests point it at a loopback endpoint.
const ENV = 'OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES';
const LOOPBACK = 'http://127.0.0.1:8090/llm-service/v1';
async function withGateway(run) {
  const previous = process.env[ENV];
  process.env[ENV] = LOOPBACK;
  try { return await run(); } finally {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  }
}

test('structured distillation keeps only ontology candidates with exact source quotes', () => withGateway(async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      memories: [{ content: 'Alpha depends on Beta.', kind: 'fact', layer: 'semantic', importance: .8 }],
      entities: [
        { name: 'Alpha', type: 'Service', aliases: ['Alpha service'] },
        { name: 'Beta', type: 'API', aliases: [] },
      ],
      relations: [
        { subject: 'Alpha', predicate: 'depends_on', object: 'Beta', quote: 'Alpha depends on Beta.' },
        { subject: 'Alpha', predicate: 'depends_on', object: 'Beta', quote: 'invented source' },
      ],
    }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const distiller = createDistiller({ credentials: { resolve: async () => ({ value: 'test-key' }) } }, {
      embeddingBaseUrl: LOOPBACK, apiKeyEnv: 'TEST_KEY', distillModel: 'test-chat', distillBaseUrl: '', distillTimeoutMs: 1000, distillMaxTokens: 300,
    });
    const result = await distiller.distillEnvelope('Alpha depends on Beta.');
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].options.body).reasoning_effort, 'low');
    assert.deepEqual(result?.entities.map(entity => entity.name), ['Alpha', 'Beta']);
    assert.deepEqual(result?.relations, [{ subject: 'Alpha', predicate: 'depends_on', object: 'Beta', quote: 'Alpha depends on Beta.' }]);
    assert.equal(result?.memories[0].layer, 'semantic');
  } finally {
    globalThis.fetch = original;
  }
}));

test('structured distillation retries a transient upstream failure and then succeeds', () => withGateway(async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      memories: [{ content: '用户偏好稳定的重试机制。', kind: 'preference', layer: 'semantic', importance: .8 }],
      entities: [],
      relations: [],
    }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const distiller = createDistiller({ credentials: { resolve: async () => ({ value: 'test-key' }) } }, {
      embeddingBaseUrl: LOOPBACK, apiKeyEnv: 'TEST_KEY', distillModel: 'test-chat', distillBaseUrl: '', distillTimeoutMs: 1000, distillMaxTokens: 300,
    });
    const result = await distiller.distillEnvelope('用户偏好稳定的重试机制。');
    assert.equal(calls, 2);
    assert.equal(result?.memories[0]?.content, '用户偏好稳定的重试机制。');
  } finally {
    globalThis.fetch = original;
  }
}));

test('structured distillation does not retry permission failures', () => withGateway(async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ code: 804 }), { status: 403, headers: { 'content-type': 'application/json' } });
  };
  try {
    const distiller = createDistiller({ credentials: { resolve: async () => ({ value: 'test-key' }) } }, {
      embeddingBaseUrl: LOOPBACK, apiKeyEnv: 'TEST_KEY', distillModel: 'test-chat', distillBaseUrl: '', distillTimeoutMs: 1000, distillMaxTokens: 300,
    });
    await assert.rejects(
      () => distiller.distillEnvelope('permission check'),
      (error) => error?.code === 'DISTILL_NO_PERMISSION',
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
}));