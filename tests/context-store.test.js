import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The import is guarded only so the initial RED is an assertion, not a loader error.
let createContextStore;
try { ({ createContextStore } = await import('../src/context/store.js')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const SCOPE = 'test:alpha';
const OTHER = 'test:beta';
const own = (t, options = {}) => {
  assert.equal(typeof createContextStore, 'function', 'store.js must export createContextStore');
  const store = createContextStore({ dbPath: ':memory:', ...options });
  t.after(() => store.close());
  return store;
};
const fails = (fn, code = 'INVALID_INPUT') => assert.throws(fn, error => {
  assert.equal(error.code, code);
  assert.equal(typeof error.message, 'string');
  assert.doesNotMatch(error.message, /INSERT INTO|SELECT .*FROM|\.sqlite|C:\\|sk-[A-Za-z0-9_-]{20,}/i);
  return true;
});
const memory = (store, extra = {}) => store.saveMemory({ scopeId: SCOPE, content: 'A source statement.', ...extra });
const entity = (store, name, type = 'Service', scopeId = SCOPE) => store.createEntity({ scopeId, name, type });
function pair(store) {
  return [entity(store, 'Gateway'), entity(store, 'Ledger')];
}
function claim(store, a, b, extra = {}) {
  const m = memory(store, { content: 'Gateway depends on Ledger.', ...extra.memory });
  return store.createRelation({ scopeId: SCOPE, subjectId: a.id, predicate: 'depends_on', objectId: b.id,
    sourceId: m.sourceId, quote: 'Gateway depends on Ledger.', ...extra.relation });
}
function confirm(store, r) {
  return store.reviewRelation({ scopeId: SCOPE, id: r.id, expectedRevision: r.revision, decision: 'confirm', reason: 'Reviewed the exact source.' });
}
function noDangling(graph) {
  const ids = new Set(graph.nodes.map(x => x.id));
  assert.equal(ids.size, graph.nodes.length);
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.source), 'edge source is present');
    assert.ok(ids.has(edge.target), 'edge target is present');
  }
  assert.equal(graph.stats.nodeCount, graph.nodes.length);
  assert.equal(graph.stats.edgeCount, graph.edges.length);
}

test('store requires an explicit database path and rejects malformed options', t => {
  own(t);
  for (const options of [undefined, null, [], {}, { dbPath: '' }, { dbPath: null }, { dbPath: ':memory:', now: 7 }]) {
    fails(() => createContextStore(options));
  }
});

test('saving records a separate immutable source without upgrading epistemic status', t => {
  const store = own(t, { now: () => 1000 });
  const m = memory(store, { kind: 'decision', source: { content: 'Model proposal: choose SQLite.', actorRole: 'assistant', kind: 'message', complete: false, lineageId: 'lineage:a' } });
  assert.equal(m.kind, 'decision');
  assert.equal(m.lifecycle, 'active');
  assert.equal(m.epistemic, 'unverified');
  assert.equal(m.legacy, false);
  assert.equal(m.revision, 1);
  assert.notEqual(m.sourceId, m.id);
  assert.equal(m.source.id, m.sourceId);
  assert.equal(m.source.scopeId, SCOPE);
  assert.equal(m.source.actorRole, 'assistant');
  assert.equal(m.source.content, 'Model proposal: choose SQLite.');
  assert.equal(m.source.complete, false);
  assert.equal(m.source.lineageId, 'lineage:a');
  assert.equal(m.recordedAt, 1000);
  assert.equal(m.source.recordedAt, m.recordedAt);
  assert.equal(m.validFrom, null);
  assert.equal(m.validTo, null);
  assert.deepEqual(m.metadata, {});
  const defaults = memory(store);
  assert.equal(defaults.kind, 'note');
  assert.equal(defaults.source.kind, 'manual');
  assert.equal(defaults.source.actorRole, 'unknown');
  assert.equal(defaults.source.complete, true);
  assert.equal(defaults.source.content, defaults.content);
  assert.deepEqual(store.listScopes().map(x => ({ id: x.id, count: x.count })), [{ id: SCOPE, count: 2 }]);
});

test('multi-term memory search scans once, ranks exact phrases first and stays scope-bound', t => {
  const store = own(t);
  const exact = memory(store, { content: '项目火星的发布口令是 PERF-000001。' });
  memory(store, { content: '项目火星还有一条较新的普通记录。' });
  store.saveMemory({ scopeId: OTHER, content: '另一个范围也包含 PERF-000001。' });
  const rows = store.searchMemories({ scopeId: SCOPE, queries: ['PERF-000001', '项目', '火星'], lifecycle: 'active', limit: 20 });
  assert.equal(rows[0].id, exact.id);
  assert.ok(rows.length >= 2);
  assert.ok(rows.every(row => row.scopeId === SCOPE));
  fails(() => store.searchMemories({ scopeId: SCOPE, queries: [] }));
});

test('idempotent saves replay original revisions and reject different payloads', t => {
  const store = own(t);
  const input = { scopeId: SCOPE, content: 'Keep the original.', idempotencyKey: 'request:a', metadata: { b: 2, a: 1 } };
  const a = store.saveMemory(input);
  assert.deepEqual(store.saveMemory({ ...input, metadata: { a: 1, b: 2 } }), a);
  store.reviseMemory({ scopeId: SCOPE, id: a.id, expectedRevision: 1, content: 'A correction.', reason: 'Correction.' });
  assert.deepEqual(store.saveMemory(input), a);
  fails(() => store.saveMemory({ ...input, content: 'Different content.' }), 'IDEMPOTENCY_CONFLICT');
  const b = store.saveMemory({ ...input, scopeId: OTHER });
  assert.notEqual(b.id, a.id);
  assert.equal(store.listMemories({ scopeId: SCOPE }).length, 1);
  assert.equal(store.changes({ scopeId: SCOPE }).length, 2);
});

test('revisions preserve source and content history and reject stale writes', t => {
  const store = own(t);
  const a = memory(store);
  const b = store.reviseMemory({ scopeId: SCOPE, id: a.id, expectedRevision: 1, content: 'Corrected statement.', reason: 'A late correction.', actorRole: 'human' });
  assert.equal(b.revision, 2);
  assert.notEqual(b.sourceId, a.sourceId);
  assert.equal(b.source.kind, 'correction');
  assert.equal(b.source.actorRole, 'human');
  assert.equal(b.source.content, b.content);
  assert.equal(b.epistemic, 'unverified');
  fails(() => store.reviseMemory({ scopeId: SCOPE, id: a.id, expectedRevision: 1, content: 'Stale.', reason: 'Stale write.' }), 'VERSION_CONFLICT');
  const versions = store.versions(SCOPE, a.id);
  assert.deepEqual(versions, [a, b]);
  versions[0].source.content = 'tampered';
  versions[0].metadata.injected = true;
  assert.deepEqual(store.versions(SCOPE, a.id), [a, b]);
  const retired = store.retireMemory({ scopeId: SCOPE, id: a.id, expectedRevision: 2, reason: 'No longer used.' });
  assert.equal(retired.lifecycle, 'retired');
  assert.equal(retired.revision, 3);
  assert.equal(retired.sourceId, b.sourceId);
  assert.equal(store.listMemories({ scopeId: SCOPE }).length, 0);
  assert.equal(store.listMemories({ scopeId: SCOPE, lifecycle: 'retired' }).length, 1);
  assert.equal(store.getMemory(SCOPE, a.id).lifecycle, 'retired');
  fails(() => store.retireMemory({ scopeId: SCOPE, id: a.id, expectedRevision: 2, reason: 'Stale.' }), 'VERSION_CONFLICT');
});

test('transaction time and valid time handle late corrections without resurrecting superseded intervals', t => {
  let now = 1000;
  const store = own(t, { now: () => now });
  const a = memory(store, { validFrom: 100, validTo: 800 });
  now = 2000;
  const b = store.reviseMemory({ scopeId: SCOPE, id: a.id, expectedRevision: 1, content: 'Corrected range.', reason: 'Learned later.', validFrom: 200, validTo: 400 });
  assert.equal(store.getMemory(SCOPE, a.id, { knownAt: 1500, validAt: 100 }).revision, 1);
  assert.equal(store.getMemory(SCOPE, a.id, { knownAt: 1500, validAt: 800 }), undefined);
  assert.equal(store.getMemory(SCOPE, a.id, { knownAt: 999 }), undefined);
  assert.equal(store.getMemory(SCOPE, a.id, { knownAt: 2000, validAt: 200 }).revision, 2);
  assert.equal(store.getMemory(SCOPE, a.id, { validAt: 400 }), undefined);
  assert.equal(store.getMemory(SCOPE, a.id, { validAt: 700 }), undefined);
  assert.equal(store.listMemories({ scopeId: SCOPE, knownAt: 1500 })[0].content, a.content);
  assert.equal(store.listMemories({ scopeId: SCOPE })[0].content, b.content);
  const unknown = memory(store);
  assert.equal(store.getMemory(SCOPE, unknown.id, { validAt: 200 }), undefined);
});

test('invalid timestamps, empty intervals and invalid clocks never write records', t => {
  const store = own(t);
  for (const extra of [ { validFrom: NaN }, { validFrom: Infinity }, { validFrom: -1 }, { validFrom: 1.5 }, { validFrom: '2026-01-01' }, { validFrom: 8640000000000001 }, { validTo: 200 }, { validFrom: 100, validTo: 100 }, { validFrom: 101, validTo: 100 } ]) {
    fails(() => memory(store, extra));
  }
  for (const value of [NaN, Infinity, -1, '100', 1.5]) fails(() => store.listMemories({ scopeId: SCOPE, knownAt: value }));
  assert.deepEqual(store.listScopes(), []);
  const invalidClock = own(t, { now: () => NaN });
  fails(() => memory(invalidClock));
});

test('legacy import preserves identity without claiming human origin or historical knowledge', t => {
  const store = own(t, { now: () => 5000 });
  const input = { id: 'legacy:original', scopeId: SCOPE, content: 'An inherited claim.', timestamp: 500, metadata: { sourceType: 'user_request' } };
  const m = store.importLegacy(input);
  assert.equal(m.id, input.id);
  assert.equal(m.legacy, true);
  assert.equal(m.source.actorRole, 'unknown');
  assert.equal(m.source.kind, 'legacy');
  assert.equal(m.source.complete, false);
  assert.equal(m.recordedAt, 5000);
  assert.equal(m.metadata.legacyTimestamp, 500);
  assert.equal(m.validFrom, null);
  assert.equal(m.epistemic, 'unverified');
  assert.deepEqual(store.importLegacy(input), m);
  assert.equal(store.getMemory(SCOPE, m.id, { knownAt: 4999 }), undefined);
  fails(() => store.importLegacy({ ...input, content: 'Overwrite.' }), 'IDEMPOTENCY_CONFLICT');
});

test('scope separation applies to reads, mutations, references and auditing', t => {
  const store = own(t);
  const m = memory(store);
  const a = entity(store, 'One');
  const b = entity(store, 'Other', 'Service', OTHER);
  assert.equal(store.getMemory(OTHER, m.id), undefined);
  assert.equal(store.getEntity(OTHER, a.id), undefined);
  assert.deepEqual(store.versions(OTHER, m.id), []);
  fails(() => store.reviseMemory({ scopeId: OTHER, id: m.id, expectedRevision: 1, content: 'Wrong scope.', reason: 'Denied.' }), 'NOT_FOUND');
  fails(() => store.createRelation({ scopeId: SCOPE, subjectId: a.id, objectId: b.id, predicate: 'related_to' }), 'NOT_FOUND');
  fails(() => memory(store, { entityIds: [b.id] }), 'NOT_FOUND');
  assert.deepEqual(store.changes({ scopeId: OTHER }).map(x => x.targetId), [b.id]);
  assert.deepEqual(store.graph({ scopeId: OTHER, rootId: a.id }).nodes, []);
});

test('invalid shape, prototype pollution, accessors and huge input are rejected without side effects', t => {
  const store = own(t);
  let getterCalls = 0;
  const getter = { scopeId: SCOPE, get content() { getterCalls++; return 'Unexpected.'; } };
  const polluted = JSON.parse('{"scopeId":"test:alpha","content":"Unsafe.","metadata":{"__proto__":{"polluted":true}}}');
  const cyclic = {}; cyclic.self = cyclic;
  for (const input of [null, [], 1, 'x', getter, polluted, Object.assign(Object.create({ inherited: true }), { scopeId: SCOPE, content: 'X' }), { scopeId: SCOPE, content: '   ' }, { scopeId: SCOPE, content: 'x'.repeat(1_000_000) }, { scopeId: SCOPE, content: 'X', metadata: cyclic }, { scopeId: SCOPE, content: 'X', metadata: [] }, { scopeId: SCOPE, content: 'X', metadata: { constructor: 'bad' } }, { scopeId: SCOPE, content: 'X', metadata: { x: NaN } }, { scopeId: SCOPE, content: 'X', epistemic: 'supported' }]) {
    fails(() => store.saveMemory(input));
  }
  assert.equal(getterCalls, 0);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(store.listScopes(), []);
});

test('explicit local records preserve credential-like content, metadata, aliases and reasons', t => {
  const store = own(t);
  const secret = 'sk-' + 'fixtureonly'.repeat(3);
  const rows = [{ content: secret }, { source: { content: secret } }, { metadata: { note: secret } }, { metadata: { password: 'notarealcredential' } }].map(extra => memory(store, extra));
  assert.equal(rows[0].content, secret);
  assert.equal(rows[1].source.content, secret);
  assert.equal(rows[2].metadata.note, secret);
  assert.equal(rows[3].metadata.password, 'notarealcredential');
  const named = store.createEntity({ scopeId: SCOPE, type: 'Service', name: 'Safe', aliases: [secret] });
  assert.deepEqual(named.aliases, [secret]);
  const m = memory(store);
  const retired = store.retireMemory({ scopeId: SCOPE, id: m.id, expectedRevision: 1, reason: secret });
  assert.equal(retired.lifecycle, 'retired');
  assert.equal(store.versions(SCOPE, m.id).length, 2);
});

test('compound saves roll back scopes, sources, mentions, audit and idempotency on failed references', t => {
  const store = own(t);
  const a = entity(store, 'Known');
  const before = store.changes({ scopeId: SCOPE });
  const input = { scopeId: SCOPE, content: 'All or nothing.', entityIds: [a.id, 'missing:entity'], idempotencyKey: 'batch:retry' };
  fails(() => store.saveMemory(input), 'NOT_FOUND');
  assert.deepEqual(store.listMemories({ scopeId: SCOPE }), []);
  assert.deepEqual(store.changes({ scopeId: SCOPE }), before);
  assert.equal(store.graph({ scopeId: SCOPE, includePending: true }).nodes.length, 1);
  const saved = store.saveMemory({ ...input, entityIds: [a.id] });
  assert.equal(saved.revision, 1);
  assert.equal(store.listMemories({ scopeId: SCOPE }).length, 1);
});

test('typed entities normalize aliases and reject arbitrary type or alias ownership collisions', t => {
  const store = own(t);
  const a = store.createEntity({ scopeId: SCOPE, name: 'Gateway', type: 'Service', aliases: [' Edge ', 'edge', 'Gateway'] });
  assert.deepEqual(a.aliases, ['Edge']);
  assert.equal(store.listEntities({ scopeId: SCOPE, query: 'EDGE' })[0].id, a.id);
  fails(() => store.createEntity({ scopeId: SCOPE, name: 'edge', type: 'Service' }), 'ENTITY_CONFLICT');
  assert.equal(entity(store, 'edge', 'Project').type, 'Project');
  fails(() => entity(store, 'Dynamic', 'eval("code")'));
  a.aliases.push('mutated');
  assert.deepEqual(store.getEntity(SCOPE, a.id).aliases, ['Edge']);
});

test('schema exposes only the fixed typed relationship subset', t => {
  const store = own(t);
  const schema = store.getSchema();
  assert.deepEqual(schema.types.map(x => x.id).sort(), ['Project', 'Person', 'Requirement', 'API', 'Service', 'Constraint', 'Decision', 'Document'].sort());
  assert.deepEqual(schema.relations.map(x => x.id).sort(), ['belongs_to', 'has_constraint', 'implements', 'assigned_to', 'depends_on', 'decided_by', 'related_to'].sort());
  for (const r of schema.relations) for (const type of [...r.domain, ...r.range]) assert.ok(schema.types.some(t => t.id === type));
  schema.relations[0].domain.length = 0;
  assert.notEqual(store.getSchema().relations[0].domain.length, 0);
});

test('pure relationship validation enforces domain/range, scope and exact source quotes', t => {
  const store = own(t);
  const [a, b] = pair(store);
  const project = entity(store, 'Project', 'Project');
  const m = memory(store, { content: 'Gateway depends on Ledger.' });
  const valid = { scopeId: SCOPE, subjectId: a.id, predicate: 'depends_on', objectId: b.id, sourceId: m.sourceId, quote: 'depends on' };
  const before = store.changes({ scopeId: SCOPE });
  assert.deepEqual(store.validateRelation(valid), { ok: true, errors: [] });
  for (const value of [null, [], { ...valid, predicate: 'execute_code' }, { ...valid, objectId: project.id }, { ...valid, quote: 'gateway DEPENDS on ledger' }, { ...valid, sourceId: 'missing:source' }]) {
    const result = store.validateRelation(value);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
    assert.equal(typeof result.errors[0].code, 'string');
    assert.equal(typeof result.errors[0].field, 'string');
  }
  assert.deepEqual(store.changes({ scopeId: SCOPE }), before);
  fails(() => store.createRelation({ ...valid, quote: 'not in source' }), 'INVALID_EVIDENCE');
  const foreign = memory(store, { scopeId: OTHER });
  fails(() => store.createRelation({ ...valid, sourceId: foreign.sourceId, quote: foreign.content }), 'NOT_FOUND');
});

test('manual review is optimistic and cannot confirm evidence-free pending claims', t => {
  const store = own(t);
  const [a, b] = pair(store);
  const pending = store.createRelation({ scopeId: SCOPE, subjectId: a.id, predicate: 'depends_on', objectId: b.id });
  assert.equal(pending.status, 'pending');
  fails(() => confirm(store, pending), 'EVIDENCE_REQUIRED');
  assert.equal(store.listReviews({ scopeId: SCOPE }).length, 1);
  const rejected = store.reviewRelation({ scopeId: SCOPE, id: pending.id, expectedRevision: 1, decision: 'reject', reason: 'No evidence.' });
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(store.listReviews({ scopeId: SCOPE }), []);
  const r = claim(store, a, b);
  const confirmed = confirm(store, r);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.revision, 2);
  fails(() => confirm(store, r), 'VERSION_CONFLICT');
  fails(() => store.reviewRelation({ scopeId: SCOPE, id: confirmed.id, expectedRevision: 2, decision: 'confirm', reason: '' }));
  assert.equal(store.listRelations({ scopeId: SCOPE, status: 'confirmed' }).length, 1);
  assert.equal(store.getMemory(SCOPE, store.listMemories({ scopeId: SCOPE })[0].id).epistemic, 'unverified');
});

test('relation temporal views distinguish pending knowledge from later confirmation', t => {
  let now = 1000;
  const store = own(t, { now: () => now });
  const [a, b] = pair(store);
  const r = claim(store, a, b, { relation: { validFrom: 10, validTo: 20 } });
  now = 2000;
  const reviewed = confirm(store, r);
  assert.equal(store.listRelations({ scopeId: SCOPE, knownAt: r.recordedAt, validAt: 10 })[0].status, 'pending');
  assert.equal(store.listRelations({ scopeId: SCOPE, knownAt: reviewed.recordedAt, validAt: 19 })[0].status, 'confirmed');
  assert.deepEqual(store.listRelations({ scopeId: SCOPE, validAt: 20 }), []);
});

test('same-type merge preserves aliases and evidence while historical endpoints stay immutable', t => {
  let now = 1000;
  const store = own(t, { now: () => now });
  const keep = entity(store, 'Gateway');
  const merge = store.createEntity({ scopeId: SCOPE, name: 'Old gateway', type: 'Service', aliases: ['Edge'] });
  const target = entity(store, 'Ledger');
  const m = memory(store, { content: 'Old gateway depends on Ledger.', entityIds: [merge.id] });
  const r = confirm(store, store.createRelation({ scopeId: SCOPE, subjectId: merge.id, predicate: 'depends_on', objectId: target.id, sourceId: m.sourceId, quote: m.content }));
  now = 2000;
  const merged = store.mergeEntities({ scopeId: SCOPE, keepId: keep.id, mergeId: merge.id, keepRevision: 1, mergeRevision: 1, reason: 'Same service identity.' });
  assert.equal(merged.id, keep.id);
  assert.equal(merged.revision, 2);
  assert.deepEqual(new Set(merged.aliases), new Set(['Old gateway', 'Edge']));
  assert.equal(store.getEntity(SCOPE, merge.id).id, keep.id);
  assert.equal(store.listEntities({ scopeId: SCOPE }).length, 2);
  const latest = store.listRelations({ scopeId: SCOPE })[0];
  assert.equal(latest.subjectId, keep.id);
  assert.equal(latest.sourceId, r.sourceId);
  assert.equal(latest.quote, r.quote);
  assert.equal(latest.revision, r.revision + 1);
  assert.equal(store.listRelations({ scopeId: SCOPE, knownAt: r.recordedAt })[0].subjectId, merge.id);
  assert.deepEqual(store.versions(SCOPE, m.id), [m]);
  const graph = store.graph({ scopeId: SCOPE, rootId: keep.id, depth: 3 });
  noDangling(graph);
  assert.ok(graph.edges.some(e => e.type === 'mentions' && e.source === m.id && e.target === keep.id));
});

test('unlike-type, stale, self-loop and redirected cyclic merges reject atomically', t => {
  const store = own(t);
  const [a, b] = pair(store);
  const p = entity(store, 'Project', 'Project');
  fails(() => store.mergeEntities({ scopeId: SCOPE, keepId: a.id, mergeId: p.id, keepRevision: 1, mergeRevision: 1, reason: 'Wrong types.' }), 'TYPE_MISMATCH');
  confirm(store, claim(store, a, b));
  const before = store.changes({ scopeId: SCOPE });
  fails(() => store.mergeEntities({ scopeId: SCOPE, keepId: a.id, mergeId: b.id, keepRevision: 1, mergeRevision: 1, reason: 'Would destroy an edge.' }), 'MERGE_CONFLICT');
  assert.deepEqual(store.changes({ scopeId: SCOPE }), before);
  assert.equal(store.getEntity(SCOPE, b.id).id, b.id);
  const c = entity(store, 'Alias gateway');
  const merged = store.mergeEntities({ scopeId: SCOPE, keepId: a.id, mergeId: c.id, keepRevision: 1, mergeRevision: 1, reason: 'An alias.' });
  fails(() => store.mergeEntities({ scopeId: SCOPE, keepId: c.id, mergeId: a.id, keepRevision: 1, mergeRevision: merged.revision, reason: 'Redirect cycle.' }), 'MERGE_CONFLICT');
  fails(() => store.mergeEntities({ scopeId: SCOPE, keepId: a.id, mergeId: b.id, keepRevision: 1, mergeRevision: 1, reason: 'Stale merge.' }), 'VERSION_CONFLICT');
});

test('graphs are bounded, scope-safe, visited and never emit dangling edges', t => {
  const store = own(t);
  const [a, b] = pair(store);
  const c = entity(store, 'Queue');
  confirm(store, claim(store, a, b));
  confirm(store, claim(store, b, c));
  confirm(store, claim(store, c, a));
  entity(store, 'Secret scope', 'Service', OTHER);
  const d = entity(store, 'Pending endpoint');
  const pending = claim(store, a, d);
  const rootOnly = store.graph({ scopeId: SCOPE, rootId: a.id, depth: 0 });
  assert.deepEqual(rootOnly.nodes.map(n => n.id), [a.id]);
  assert.equal(rootOnly.edges.length, 0);
  for (const limit of [1, 2, 3, 5, 20]) {
    const g = store.graph({ scopeId: SCOPE, rootId: a.id, depth: 4, limit });
    noDangling(g);
    assert.ok(g.nodes.length <= limit);
    assert.ok(g.nodes.every(n => n.scopeId === SCOPE));
    assert.ok(g.edges.every(e => e.relationId !== pending.id));
    if (limit === 1) assert.equal(g.stats.truncated, true);
  }
  assert.ok(store.graph({ scopeId: SCOPE, rootId: a.id, depth: 2, includePending: true }).edges.some(e => e.relationId === pending.id));
  fails(() => store.graph({ scopeId: SCOPE, depth: 10000 }));
  fails(() => store.graph({ scopeId: SCOPE, limit: 1000000 }));
});

test('query and paging validation keeps filtering literal and bounded', t => {
  const store = own(t);
  memory(store, { content: 'Literal 100% complete _ marker.' });
  memory(store, { content: 'Other text.' });
  assert.equal(store.listMemories({ scopeId: SCOPE, query: '%' }).length, 1);
  assert.equal(store.listMemories({ scopeId: SCOPE, query: "' OR 1=1 --" }).length, 0);
  assert.equal(store.listMemories({ scopeId: SCOPE, limit: 1 }).length, 1);
  for (const limit of [0, -1, 1.5, NaN, 100000, '2']) fails(() => store.listMemories({ scopeId: SCOPE, limit }));
  fails(() => store.listMemories({ scopeId: SCOPE, lifecycle: 'any code' }));
});

test('usage records snapshot exact revisions and idempotency cannot rewrite trace items', t => {
  const store = own(t);
  const m = memory(store);
  const item = { id: m.id, revision: 1, content: m.content, sourceId: m.sourceId, kind: m.kind };
  const input = { id: 'usage:a', sessionId: 'session:a', scopeId: SCOPE, phase: 'planned', items: [item], turn: 1, step: 2 };
  const usage = store.recordUsage(input);
  assert.equal(usage.phase, 'planned');
  assert.deepEqual(store.recordUsage(input), usage);
  item.content = 'Input mutation';
  usage.items[0].content = 'Output mutation';
  assert.equal(store.listUsage({ sessionId: 'session:a', scopeId: SCOPE })[0].items[0].content, m.content);
  fails(() => store.recordUsage({ ...input, items: [{ ...item, content: 'Different' }] }), 'IDEMPOTENCY_CONFLICT');
  store.reviseMemory({ scopeId: SCOPE, id: m.id, expectedRevision: 1, content: 'New current content.', reason: 'Update.' });
  const committed = store.updateUsage({ id: 'usage:a', phase: 'committed', eventSeq: 1 });
  assert.equal(committed.items[0].revision, 1);
  assert.equal(committed.items[0].content, m.content);
  assert.equal(store.updateUsage({ id: 'usage:a', phase: 'requested', eventSeq: 2 }).phase, 'requested');
  fails(() => store.updateUsage({ id: 'usage:a', phase: 'committed', eventSeq: 1 }), 'INVALID_TRANSITION');
  fails(() => store.updateUsage({ id: 'usage:a', phase: 'failed', items: [] }));
  assert.deepEqual(store.listUsage({ sessionId: 'session:b' }), []);
  assert.deepEqual(store.listUsage({ sessionId: 'session:a', scopeId: OTHER }), []);
});

test('known local usage snapshots cannot spoof scope, revision, content or source', t => {
  const store = own(t);
  const m = memory(store);
  const base = { id: 'usage:bad', sessionId: 'session:a', scopeId: SCOPE, phase: 'planned', items: [{ id: m.id, revision: 1, content: m.content, sourceId: m.sourceId }] };
  for (const extra of [{ revision: 99 }, { content: 'Not that revision.' }, { sourceId: 'unknown:source' }]) fails(() => store.recordUsage({ ...base, items: [{ ...base.items[0], ...extra }] }), 'INVALID_REFERENCE');
  fails(() => store.recordUsage({ ...base, scopeId: OTHER }), 'INVALID_REFERENCE');
  assert.deepEqual(store.listUsage({ sessionId: 'session:a' }), []);
});

test('usage accepts only verified byte-budget prefixes and explicit trusted legacy snapshots', t => {
  const store = own(t);
  const m = memory(store, { content: '  A longer original claim with exact evidence.  ' });
  const base = { id: 'usage:prefix', sessionId: 'session:a', scopeId: SCOPE, phase: 'planned', items: [{ id: m.id, revision: 1, content: 'A longer original …', truncated: true }] };
  assert.equal(store.recordUsage(base).items[0].truncated, true);
  for (const content of ['A fabricated …', ' …', 'A longer original', 'A longer original...']) fails(() => store.recordUsage({ ...base, id: 'usage:invalid', items: [{ ...base.items[0], content }] }), 'INVALID_REFERENCE');
  fails(() => store.recordUsage({ ...base, id: 'usage:untrusted-legacy', items: [{ id: 'legacy:absent', revision: 1, content: 'Untrusted snapshot.', legacy: true }] }), 'INVALID_REFERENCE');
  const legacy = store.recordUsage({ ...base, id: 'usage:legacy', items: [{ id: 'legacy:absent', revision: 1, content: 'Trusted service snapshot.', legacy: true }] }, { trustedLegacy: true });
  assert.equal(legacy.items[0].id, 'legacy:absent');
  store.retireMemory({ scopeId: SCOPE, id: m.id, expectedRevision: 1, reason: 'No longer usable.' });
  fails(() => store.recordUsage({ ...base, id: 'usage:retired' }), 'INVALID_REFERENCE');
  fails(() => store.setUsagePolicy({ sessionId: 'session:a', scopeId: SCOPE, memoryId: m.id, mode: 'prefer' }), 'INVALID_REFERENCE');
  assert.deepEqual(store.setUsagePolicy({ sessionId: 'session:a', scopeId: SCOPE, memoryId: m.id, mode: 'exclude' }).excludedIds, [m.id]);
});

test('usage may trace global memory with a workspace request but rejects another workspace', t => {
  const store = createContextStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  const global = store.saveMemory({ scopeId: 'dsh-default', content: 'global preference' });
  const foreign = store.saveMemory({ scopeId: 'local:other', content: 'other workspace fact' });
  const base = { id: 'usage-global', sessionId: 'session-global', scopeId: 'local:current', phase: 'planned' };
  const traced = store.recordUsage({ ...base, items: [{ id: global.id, scopeId: 'dsh-default', revision: global.revision, content: global.content, sourceId: global.sourceId, kind: global.kind }] });
  assert.equal(traced.items[0].scopeId, 'dsh-default');
  assert.throws(() => store.recordUsage({ ...base, id: 'usage-foreign', items: [{ id: foreign.id, scopeId: 'local:other', revision: foreign.revision, content: foreign.content, sourceId: foreign.sourceId, kind: foreign.kind }] }), { code: 'INVALID_REFERENCE' });
});
test('usage accepts only the multidimensional scopes authorized by the current runtime identity', t => {
 const store=own(t),workspace=memory(store,{content:'workspace memory'}),user=store.saveMemory({scopeId:'user:demo',content:'user memory'}),run=store.saveMemory({scopeId:'run:s1',content:'run memory'}),foreign=store.saveMemory({scopeId:'run:s2',content:'foreign run memory'});
 const item=row=>({id:row.id,scopeId:row.scopeId,revision:row.revision,content:row.content,sourceId:row.sourceId,kind:row.kind});
 const traced=store.recordUsage({id:'usage-scoped',sessionId:'s1',scopeId:SCOPE,phase:'planned',items:[item(workspace),item(user),item(run)]},{authorizedScopeIds:[SCOPE,'user:demo','run:s1','dsh-default']});
 assert.deepEqual(traced.items.map(row=>row.scopeId),[SCOPE,'user:demo','run:s1']);
 assert.throws(()=>store.recordUsage({id:'usage-foreign-run',sessionId:'s1',scopeId:SCOPE,phase:'planned',items:[item(foreign)]},{authorizedScopeIds:[SCOPE,'user:demo','run:s1','dsh-default']}),{code:'INVALID_REFERENCE'});
});

test('usage policy revisions separate sessions and reset IDs on scope changes', t => {
  const store = own(t);
  const m = memory(store);
  assert.deepEqual(store.getUsagePolicy('session:a'), { revision: 0, paused: false, excludedIds: [], preferredIds: [] });
  const p = store.setUsagePolicy({ sessionId: 'session:a', scopeId: SCOPE, memoryId: m.id, mode: 'exclude', expectedRevision: 0 });
  assert.deepEqual(p.excludedIds, [m.id]);
  assert.equal(p.revision, 1);
  fails(() => store.setUsagePolicy({ sessionId: 'session:a', scopeId: SCOPE, paused: true, expectedRevision: 0 }), 'VERSION_CONFLICT');
  const preferred = store.setUsagePolicy({ sessionId: 'session:a', scopeId: SCOPE, memoryId: m.id, mode: 'prefer', paused: true, expectedRevision: 1 });
  assert.deepEqual(preferred.excludedIds, []);
  assert.deepEqual(preferred.preferredIds, [m.id]);
  assert.equal(preferred.paused, true);
  const switched = store.setUsagePolicy({ sessionId: 'session:a', scopeId: OTHER, expectedRevision: 2 });
  assert.equal(switched.scopeId, OTHER);
  assert.deepEqual(switched.preferredIds, []);
  assert.deepEqual(store.getUsagePolicy('session:b'), { revision: 0, paused: false, excludedIds: [], preferredIds: [] });
});

test('file reopen persists real SQLite revisions, relations, traces and policy', t => {
  const testRoot = path.resolve('.test-data');
  mkdirSync(testRoot, { recursive: true });
  const directory = mkdtempSync(path.join(testRoot, 'context-store-'));
  const dbPath = path.join(directory, 'context.sqlite');
  // This cleanup only removes the uniquely created synthetic test directory.
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = own(t, { dbPath });
  const [a, b] = pair(first);
  const m = memory(first);
  const r = confirm(first, claim(first, a, b));
  first.recordUsage({ id: 'usage:persistent', sessionId: 'session:a', scopeId: SCOPE, phase: 'planned', items: [{ id: m.id, revision: 1, content: m.content }] });
  first.reviseMemory({ scopeId: SCOPE, id: m.id, expectedRevision: 1, content: 'Persistent revision.', reason: 'Correction.' });
  fails(() => first.recordUsage({ id: 'usage:stale', sessionId: 'session:a', scopeId: SCOPE, phase: 'planned', items: [{ id: m.id, revision: 1, content: m.content }] }), 'INVALID_REFERENCE');
  first.setUsagePolicy({ sessionId: 'session:a', scopeId: SCOPE, memoryId: m.id, mode: 'prefer' });
  first.close();
  assert.equal(readFileSync(dbPath).subarray(0, 16).toString(), 'SQLite format 3\u0000');
  const second = own(t, { dbPath });
  assert.equal(second.getMemory(SCOPE, m.id).revision, 2);
  assert.equal(second.versions(SCOPE, m.id)[0].content, m.content);
  assert.equal(second.listRelations({ scopeId: SCOPE })[0].id, r.id);
  assert.equal(second.listUsage({ sessionId: 'session:a' })[0].items[0].content, m.content);
  assert.deepEqual(second.getUsagePolicy('session:a').preferredIds, [m.id]);
  noDangling(second.graph({ scopeId: SCOPE }));
  second.close();
});

test('closed stores refuse every read, write, validation and schema operation', t => {
  const store = own(t);
  store.close();
  for (const op of [() => store.listScopes(), () => store.getSchema(), () => store.validateRelation(null), () => store.getMemory(SCOPE, 'missing'), () => store.listMemories({ scopeId: SCOPE }), () => store.searchMemories({ scopeId: SCOPE, queries: ['missing'] }), () => store.versions(SCOPE, 'missing'), () => store.listEntities({ scopeId: SCOPE }), () => store.getEntity(SCOPE, 'missing'), () => store.listRelations({ scopeId: SCOPE }), () => store.listReviews({ scopeId: SCOPE }), () => store.graph({ scopeId: SCOPE }), () => store.changes({ scopeId: SCOPE }), () => store.getUsagePolicy('session:a'), () => store.listUsage({ sessionId: 'session:a' }), () => memory(store)]) fails(op, 'STORE_CLOSED');
});