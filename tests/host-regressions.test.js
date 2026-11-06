// Post-fix regression assertions for HOST-REVIEW H1-H3 / M1-M11 / L1-L8.
// Ported from agentos-eval/host-fix/regressions.mjs into the shipped test gate.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createContextStore } from '../src/context/store.js';
import { createContextService, safeScope } from '../src/context/service.js';
import { createContextRpcHandler } from '../src/context/rpc-service.js';
import { createRpcScopePolicy, filterBootstrapScopes } from '../src/context/scope-policy.js';
import { registerCapture } from '../src/capture.js';
import { containsSecret, redactSecrets } from '../src/secrets.js';
import { detectGraphCommunities } from '../src/context/communities.js';
import { resolveConfig } from '../src/config.js';
import { resolveContextDbPath } from '../src/context/runtime.js';
import { profileNodeModulesDir } from '../src/peers.js';
import { restoreOfficeParserEnvironment } from '../src/document-parser.js';
import { createUnavailableStore } from '../src/plugin.js';
import { buildGraph } from '../src/graph-builder.ts';

// H1 -----------------------------------------------------------------------
test('H1 patterns flag common credential shapes', () => {
  for (const value of ['sk-abcdefghijklmnopqrstuvwxyz0123', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'AKIAIOSFODNN7EXAMPLE', '-----BEGIN RSA PRIVATE KEY-----', 'password: hunter2hunter2']) {
    assert.equal(containsSecret(value), true, value);
  }
  assert.equal(containsSecret('remember to buy milk'), false);
});
test('H1 redaction covers more than sk-/Bearer', () => {
  const redacted = redactSecrets('AKIAIOSFODNN7EXAMPLE ghp_abcdefghijklmnopqrstuvwxyz012345 sk-abcdefghijklmnopqrstuv');
  assert.ok(!redacted.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!redacted.includes('sk-abcdefghijklmnopqrstuv'));
});
test('H1 automatic capture skips credential-shaped prompts', async () => {
  const rows = []; let handler; const warnings = [];
  const ctx = { on: (_n, fn) => { handler = fn; return () => {}; }, logger: { warn: (m) => warnings.push(m) } };
  registerCapture(ctx, { captureSource: async (input) => { rows.push(input); return { id: 'm' }; } },
    { capturePrompts: true, distillOnCapture: false, ontologyEnabled: false, requestTimeoutMs: 2000, flushOnCapture: true, scopeId: '' });
  const token = 'Authorization: Bearer demo-token-0123456789-keep-verbatim';
  const messages = [{ id: 'm1', role: 'user', source: { kind: 'user' }, content: token }];
  await handler({ session: { id: 's1', header: { cwd: '/tmp/ws' } } }, async () => ({ kind: 'enter', messages }));
  assert.equal(rows.length, 0);
  assert.ok(warnings.some(w => w.includes('SECRET_REJECTED')));
});
test('H1 explicit save rejects credential-shaped content', async () => {
  const store = createContextStore({ dbPath: ':memory:' });
  const service = createContextService({ store, legacy: undefined, config: {}, sessions: undefined });
  assert.throws(() => service.saveMemory({ scopeId: 'local:x', content: 'token: abcdefghijklmnop' }), { code: 'SECRET_REJECTED' });
  service.close(); store.close();
});

// H2 -----------------------------------------------------------------------
test('H2 scope policy keeps every local workspace scope', () => {
  const policy = createRpcScopePolicy({ config: {}, sessions: new Map() });
  for (const id of ['local:/a', 'local:/b', 'session:s1', 'run:s1', 'dsh-default', 'legacy:unknown']) assert.equal(policy.allows(id), true, id);
});
test('H2 foreign identity scopes are rejected, own ones are vouched', () => {
  const sessions = new Map([['s1', { id: 's1', header: { cwd: '/w', userId: 'alice', appId: 'desk' } }]]);
  const policy = createRpcScopePolicy({ config: {}, sessions });
  assert.equal(policy.allows('user:bob'), false);
  assert.equal(policy.allows('user:alice'), false);
  policy.trust('s1');
  assert.equal(policy.allows('user:alice'), true);
  assert.equal(policy.allows('app:desk'), true);
  assert.equal(policy.allows('user:bob'), false);
});
test('H2 configured identity and explicit escape hatch', () => {
  assert.equal(createRpcScopePolicy({ config: { scopeUserId: 'u1' }, sessions: new Map() }).allows('user:u1'), true);
  assert.equal(createRpcScopePolicy({ config: { allowForeignScopeIds: true }, sessions: new Map() }).allows('user:bob'), true);
});
test('H2 RPC rejects foreign scope and filters scopes output', async () => {
  const handler = createContextRpcHandler({
    service: { listScopes: async () => [{ id: 'local:/a' }, { id: 'user:bob' }], listMemories: async () => [] },
    credentials: {}, config: {}, distiller: {}, sessions: new Map(),
  });
  const scopes = await handler('scopes', {}, new AbortController().signal);
  assert.deepEqual(scopes.items.map(x => x.id), ['local:/a']);
  await assert.rejects(handler('memories', { scopeId: 'user:bob' }, new AbortController().signal), { code: 'NOT_FOUND' });
});
test('H2 bootstrap filtering keeps own identity rows', () => {
  const sessions = new Map([['s1', { id: 's1', header: { cwd: '/w', userId: 'alice' } }]]);
  const policy = createRpcScopePolicy({ config: {}, sessions });
  policy.trust('s1');
  const filtered = filterBootstrapScopes({
    scopes: [{ id: 'local:/w' }, { id: 'user:alice' }, { id: 'user:bob' }],
    currentScopes: [{ id: 'run:s1' }, { id: 'user:alice' }],
    recallOrder: ['run:s1', 'user:bob', 'user:alice'],
    compatibilityScopes: [],
  }, policy);
  assert.deepEqual(filtered.scopes.map(x => x.id), ['local:/w', 'user:alice']);
  assert.deepEqual(filtered.recallOrder, ['run:s1', 'user:alice']);
});

// H3 -----------------------------------------------------------------------
test('H3 degraded store answers STORE_UNAVAILABLE but keeps the UI bootable', async () => {
  const degraded = createUnavailableStore('EACCES');
  assert.deepEqual(degraded.listScopes(), []);
  assert.deepEqual(degraded.expireMemories({ scopeId: 'x' }), []);
  assert.throws(() => degraded.saveMemory({}), { code: 'STORE_UNAVAILABLE' });
  const service = createContextService({ store: degraded, legacy: undefined, config: {}, sessions: undefined });
  const boot = await service.bootstrap(undefined);
  assert.ok(Array.isArray(boot.scopes));
  await assert.rejects(service.listMemories({ scopeId: 'local:x' }), { code: 'STORE_UNAVAILABLE' });
});

// M1/M2 --------------------------------------------------------------------
test('M1 depth boundary is reported as depthLimited, not truncated', async () => {
  const store = createContextStore({ dbPath: ':memory:' });
  const scopeId = 'local:demo';
  const type = store.getSchema().types[0].id;
  const e1 = store.createEntity({ scopeId, name: 'Alpha', type });
  const e2 = store.createEntity({ scopeId, name: 'Beta', type });
  store.saveMemory({ scopeId, content: 'alpha beta', entityIds: [e1.id, e2.id] });
  const graph = store.graph({ scopeId, rootId: e1.id, depth: 1, limit: 100 });
  assert.equal(graph.stats.truncated, false);
  assert.equal(graph.stats.depthLimited, true);
  store.close();
});
test('M2 default seeds are newest-first and limit respects recency', async () => {
  const store = createContextStore({ dbPath: ':memory:' });
  const scopeId = 'local:demo';
  const first = store.saveMemory({ scopeId, content: 'oldest fact' });
  const second = store.saveMemory({ scopeId, content: 'middle fact' });
  const third = store.saveMemory({ scopeId, content: 'newest fact' });
  const graph = store.graph({ scopeId, limit: 2 });
  const ids = graph.nodes.map(n => n.id);
  assert.ok(ids.includes(third.id));
  assert.ok(ids.includes(second.id));
  assert.ok(!ids.includes(first.id));
  assert.equal(graph.stats.truncated, true);
  store.close();
});

// M3 -----------------------------------------------------------------------
test('M3 singleton communities are merged away', () => {
  const nodes = Array.from({ length: 200 }, (_, i) => ({ id: 'n' + i, type: 'memory', label: 'n' + i, scopeId: 's' }));
  const communities = detectGraphCommunities({ nodes, edges: [] });
  assert.equal(communities.length, 1);
  assert.equal(communities[0].size, 200);
  const sparse = detectGraphCommunities({ nodes, edges: Array.from({ length: 50 }, (_, i) => ({ id: 'e' + i, source: 'n' + (i * 2), target: 'n' + (i * 2 + 1), type: 'mentions' })) });
  assert.ok(sparse.length <= 51);
  assert.equal(sparse.reduce((sum, c) => sum + c.size, 0), 200);
});

// M4 -----------------------------------------------------------------------
test('M4 patch config wins over env for plugin fields', () => {
  const previous = process.env.OPENCONTEXT_DSH_SCOPE_ID;
  process.env.OPENCONTEXT_DSH_SCOPE_ID = 'from-env';
  try {
    assert.equal(resolveConfig({ scopeId: 'from-patch' }).scopeId, 'from-patch');
  } finally {
    if (previous === undefined) delete process.env.OPENCONTEXT_DSH_SCOPE_ID; else process.env.OPENCONTEXT_DSH_SCOPE_ID = previous;
  }
});
test('M4 sidecar path: config wins, env supplies the fallback', () => {
  const base = '/tmp/host-fix';
  assert.equal(resolveContextDbPath({ contextDbPath: base + '/a.db' }, { AGENTOS_CONTEXT_DB_PATH: base + '/b.db' }, base), base + '/a.db');
  assert.equal(resolveContextDbPath({}, { AGENTOS_CONTEXT_DB_PATH: base + '/b.db' }, base), base + '/b.db');
});

// M6 -----------------------------------------------------------------------
test('M6 one upload parses at a time', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const legacy = {
    uploadDocument: async () => { await gate; return { documentId: 'doc:1', chunks: 1 }; },
  };
  const store = createContextStore({ dbPath: ':memory:' });
  const service = createContextService({ store, legacy, config: {}, sessions: undefined });
  const first = service.uploadDocument({ scopeId: 'local:x', filename: 'a.txt', content: 'hello world' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(service.uploadDocument({ scopeId: 'local:x', filename: 'b.txt', content: 'second' }), { code: 'LIMIT_EXCEEDED' });
  release();
  await first;
  store.close();
});

// M9/L2/M11 ----------------------------------------------------------------
test('M9 relation reviews are monotone', async () => {
  const store = createContextStore({ dbPath: ':memory:' });
  const scopeId = 'local:demo';
  const schema = store.getSchema();
  const definition = schema.relations.find(row => row.domain.length > 0 && row.range.length > 0);
  const subject = store.createEntity({ scopeId, name: 'S', type: definition.domain[0] });
  const object = store.createEntity({ scopeId, name: 'O', type: definition.range[0] });
  const memory = store.saveMemory({ scopeId, content: 'S uses O' });
  const predicate = definition.id;
  const relation = store.createRelation({ scopeId, subjectId: subject.id, predicate, objectId: object.id, sourceId: memory.sourceId, quote: 'S uses O' });
  const confirmed = store.reviewRelation({ scopeId, id: relation.id, expectedRevision: 1, decision: 'confirm', reason: 'exact excerpt' });
  assert.equal(confirmed.status, 'confirmed');
  assert.throws(() => store.reviewRelation({ scopeId, id: relation.id, expectedRevision: 2, decision: 'confirm', reason: 'again' }), { code: 'INVALID_TRANSITION' });
  store.close();
});
test('L2 retire is not repeatable', async () => {
  const store = createContextStore({ dbPath: ':memory:' });
  const memory = store.saveMemory({ scopeId: 'local:x', content: 'retire me' });
  store.retireMemory({ scopeId: 'local:x', id: memory.id, expectedRevision: 1, reason: 'done' });
  assert.throws(() => store.retireMemory({ scopeId: 'local:x', id: memory.id, expectedRevision: 2, reason: 'again' }), { code: 'INVALID_TRANSITION' });
  store.close();
});
test('M11 foreign ids and unknown ids are indistinguishable', async () => {
  const store = createContextStore({ dbPath: ':memory:' });
  const foreign = store.saveMemory({ scopeId: 'local:other', content: 'foreign fact' });
  assert.throws(() => store.recordUsage({ id: 'usage:foreign', sessionId: 's', scopeId: 'local:mine', phase: 'planned', items: [{ id: foreign.id, revision: foreign.revision, content: foreign.content }] }), { code: 'INVALID_REFERENCE' });
  assert.throws(() => store.recordUsage({ id: 'usage:missing', sessionId: 's', scopeId: 'local:mine', phase: 'planned', items: [{ id: 'memory:missing', revision: 1, content: 'x' }] }), { code: 'INVALID_REFERENCE' });
  store.close();
});

// L1/L5/L6/L7/L8 -----------------------------------------------------------
test('L1 scope ids align with the store identifier bound', () => {
  assert.throws(() => safeScope('a'.repeat(300)), { code: 'INVALID_INPUT' });
  assert.equal(safeScope('local:' + 'a'.repeat(80)).length, 86);
});
test('L5 parser DOM shims are removed again', async () => {
  const before = typeof globalThis.DOMMatrix;
  restoreOfficeParserEnvironment();
  const { prepareKnowledgeDocument } = await import('../src/document-parser.js');
  await assert.rejects(prepareKnowledgeDocument({ filename: 'x.pdf', dataBase64: 'JVBERi0=' }), (error) => ['DOCUMENT_PARSER_UNAVAILABLE', 'DOCUMENT_PARSE_FAILED'].includes(error.code));
  assert.equal(typeof globalThis.DOMMatrix, before);
});
test('L6 redaction covers GitHub/AWS/PEM shapes', () => {
  const redacted = redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz012345 AKIAIOSFODNN7EXAMPLE');
  assert.ok(!redacted.includes('ghp_abcdefghijklmnopqrstuvwxyz012345'));
  assert.ok(!redacted.includes('AKIAIOSFODNN7EXAMPLE'));
});
test('L7 profile names cannot escape <DSH_HOME>/profiles', () => {
  assert.throws(() => profileNodeModulesDir({ DSH_HOME: '/tmp/h', DSH_PROFILE: '../../x' }), { code: 'INVALID_INPUT' });
  assert.equal(profileNodeModulesDir({ DSH_HOME: '/tmp/h', DSH_PROFILE: 'web' }), '/tmp/h/profiles/web/node_modules');
});
test('L8 summary/document overflow sets truncated', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const memoryDb = new DatabaseSync(':memory:');
  memoryDb.exec('CREATE TABLE raw_messages (id INTEGER PRIMARY KEY, message_id TEXT, timestamp INTEGER, content TEXT, metadata TEXT, deprecated_at INTEGER)');
  memoryDb.exec('CREATE TABLE memory_summaries (summary_id TEXT PRIMARY KEY, end_timestamp INTEGER, summary_text TEXT, source_record_ids TEXT, created_at INTEGER)');
  const insert = memoryDb.prepare('INSERT INTO memory_summaries VALUES (?,?,?,?,?)');
  for (let i = 0; i < 1001; i += 1) insert.run('s' + i, 0, 'summary ' + i, '[]', Date.now());
  const graph = buildGraph(memoryDb, undefined, { days: 3650, limit: 5000, types: ['summary'] });
  assert.equal(graph.nodes.length, 1000);
  assert.equal(graph.stats.truncated, true);
  memoryDb.close();
});

// M5/M8/M10/L3 -------------------------------------------------------------
test('M5 vector index has a finite scan bound and newest-first order', async () => {
  const source = await readSource('src/context/vector-index.js');
  assert.match(source, /DEFAULT_MAX_ROWS=20_000/);
  assert.match(source, /ORDER BY updated_at DESC/);
});
test('M8 key verification never echoes the draft key or gateway URL', async () => {
  const { verifyDraftKey } = await import('../src/verify-key.ts');
  const base = 'http://127.0.0.1:9/v1';
  const previous = process.env.OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES;
  process.env.OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES = base;
  let failure;
  try {
    failure = await verifyDraftKey({ apiKey: 'draft-secret-value' }, { embeddingBaseUrl: base, embeddingModel: 'm', embeddingTimeoutMs: 50 }, async () => { throw new Error('offline'); });
  } finally {
    if (previous === undefined) delete process.env.OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES; else process.env.OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES = previous;
  }
  assert.equal(failure.ok, false);
  const rendered = JSON.stringify(failure);
  assert.ok(!rendered.includes('draft-secret-value'));
  assert.ok(!rendered.includes('127.0.0.1:9'));
});
test('M10 expiry maintenance is throttled on read paths', async () => {
  let expiries = 0;
  const store = {
    expireMemories: () => { expiries += 1; return []; },
    listMemories: () => [],
    listScopes: () => [],
    listUsage: () => [],
  };
  const service = createContextService({ store, legacy: undefined, config: {}, sessions: undefined });
  await service.listMemories({ scopeId: 'local:x' });
  await service.listMemories({ scopeId: 'local:x' });
  assert.equal(expiries, 1);
});
test('L3 test-only HTTP modules are marked and unshipped', async () => {
  const apiRoutes = await readSource('src/api-routes.ts');
  const bundleRoute = await readSource('src/bundle-route.ts');
  assert.match(apiRoutes, /TEST-ONLY/);
  assert.match(bundleRoute, /TEST-ONLY/);
  const entry = await readSource('src/index.ts');
  assert.ok(!entry.includes('api-routes'));
  assert.ok(!entry.includes('bundle-route'));
});
async function readSource(relative) {
  const { readFile } = await import('node:fs/promises');
  return readFile(new URL('../' + relative, import.meta.url), 'utf8');
}


// usage clock domain (task-36) ---------------------------------------------
test('usage: planned→committed tolerates an internal clock ahead of the client event time', () => {
  const real = Date.now();
  let tick = 0;
  const store = createContextStore({ dbPath: ':memory:', now: () => real + 60_000 + (tick += 1) });
  const memory = store.saveMemory({ scopeId: 'local:clock', content: 'clock domain fact' });
  for (let i = 0; i < 25; i += 1) {
    const usage = store.recordUsage({ id: 'usage:clock:' + i, sessionId: 'session:clock', scopeId: 'local:clock', phase: 'planned', items: [{ id: memory.id, revision: memory.revision, content: memory.content }] });
    const committed = store.updateUsage({ id: usage.id, phase: 'committed', eventSeq: i + 1, at: Date.now() });
    assert.equal(committed.phase, 'committed');
  }
  assert.equal(store.listUsage({ sessionId: 'session:clock' }).length, 25);
  store.close();
});
test('usage: out-of-order same-domain client event times are still rejected', () => {
  const store = createContextStore({ dbPath: ':memory:' });
  const memory = store.saveMemory({ scopeId: 'local:clock', content: 'ordered fact' });
  const item = { id: memory.id, revision: memory.revision, content: memory.content };
  const usage = store.recordUsage({ id: 'usage:ordered', sessionId: 's', scopeId: 'local:clock', phase: 'planned', at: 1_700_000_000_000, items: [item] });
  assert.throws(() => store.updateUsage({ id: usage.id, phase: 'committed', eventSeq: 1, at: 1_699_999_999_999 }), { code: 'INVALID_TRANSITION' });
  const committed = store.updateUsage({ id: usage.id, phase: 'committed', eventSeq: 2, at: 1_700_000_000_500 });
  assert.equal(committed.phase, 'committed');
  assert.throws(() => store.updateUsage({ id: usage.id, phase: 'requested', eventSeq: 3, at: 1_700_000_000_100 }), { code: 'INVALID_TRANSITION' });
  assert.equal(store.updateUsage({ id: usage.id, phase: 'requested', eventSeq: 4, at: 1_700_000_000_900 }).phase, 'requested');
  store.close();
});
test('usage: stored event time stays in the sidecar monotonic domain', () => {
  const store = createContextStore({ dbPath: ':memory:', now: () => 1_000 });
  const memory = store.saveMemory({ scopeId: 'local:clock', content: 'domain fact' });
  const usage = store.recordUsage({ id: 'usage:domain', sessionId: 's', scopeId: 'local:clock', phase: 'planned', at: 5_000_000, items: [{ id: memory.id, revision: memory.revision, content: memory.content }] });
  assert.ok(Number.isSafeInteger(usage.at) && usage.at < 5_000_000);
  const committed = store.updateUsage({ id: usage.id, phase: 'committed', eventSeq: 1, at: Date.now() });
  assert.ok(Number.isSafeInteger(committed.at) && committed.at > usage.at);
  store.close();
});
