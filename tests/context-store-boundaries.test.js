import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextStore } from '../src/context/store.js';

const scopeId = 'boundary:scope';
function storeFor(t, extra = {}) {
  const store = createContextStore({ dbPath: ':memory:', ...extra });
  t.after(() => store.close());
  return store;
}
const reject = (fn, code = 'INVALID_INPUT') => assert.throws(fn, { code });

test('explicit null clock is not silently replaced by the system clock', () => {
  let unexpected;
  try { reject(() => { unexpected = createContextStore({ dbPath: ':memory:', now: null }); }); }
  finally { unexpected?.close(); }
});

test('local non-memory IDs cannot masquerade as external legacy trace or policy IDs', t => {
  const store = storeFor(t);
  const entity = store.createEntity({ scopeId, name: 'Typed object', type: 'Service' });
  const usage = { id: 'usage:non-memory', sessionId: 'session:a', scopeId, phase: 'planned', items: [{ id: entity.id, revision: 1, content: 'Not a memory.' }] };
  reject(() => store.recordUsage(usage), 'INVALID_REFERENCE');
  reject(() => store.setUsagePolicy({ sessionId: 'session:a', scopeId, memoryId: entity.id, mode: 'prefer' }), 'INVALID_REFERENCE');
  reject(() => store.recordUsage({ ...usage, scopeId: 'scope:elsewhere' }), 'INVALID_REFERENCE');
  assert.deepEqual(store.listUsage({ sessionId: 'session:a' }), []);
});

test('clock regressions remain transaction-monotonic and known-at views stay deterministic', t => {
  let now = 1000;
  const store = storeFor(t, { now: () => now });
  const first = store.saveMemory({ scopeId, content: 'First.' });
  now = 500;
  const second = store.reviseMemory({ scopeId, id: first.id, expectedRevision: 1, content: 'Second.', reason: 'Correction.' });
  const third = store.retireMemory({ scopeId, id: first.id, expectedRevision: 2, reason: 'Retired.' });
  assert.ok(first.recordedAt < second.recordedAt && second.recordedAt < third.recordedAt);
  assert.equal(store.getMemory(scopeId, first.id, { knownAt: first.recordedAt }).content, first.content);
  assert.equal(store.getMemory(scopeId, first.id, { knownAt: second.recordedAt }).content, second.content);
});

test('nulls, objects, unsupported types and oversized nested payloads cannot cross method boundaries', t => {
  const store = storeFor(t);
  for (const name of ['saveMemory', 'importLegacy', 'reviseMemory', 'retireMemory', 'createEntity', 'mergeEntities', 'createRelation', 'reviewRelation', 'listMemories', 'listEntities', 'listRelations', 'listReviews', 'graph', 'changes', 'recordUsage', 'updateUsage', 'listUsage', 'setUsagePolicy']) {
    for (const input of [null, [], false]) reject(() => store[name](input));
  }
  const content = 'Safe statement.';
  const nested = {}; let node = nested;
  for (let i = 0; i < 20; i++) { node.child = {}; node = node.child; }
  for (const metadata of [new Date(), new Map(), { value: BigInt(1) }, { value: Symbol('x') }, { value: () => 1 }, { value: undefined }, { values: Array(257).fill(1) }, nested, { huge: 'word '.repeat(10000) }]) {
    reject(() => store.saveMemory({ scopeId, content, metadata }));
  }
  for (const source of [null, [], { actorRole: 'admin' }, { complete: 'yes' }, { content: null }, { originalDbPath: 'not supported' }]) reject(() => store.saveMemory({ scopeId, content, source }));
  assert.deepEqual(store.listScopes(), []);
});

test('source quote matching is exact, not normalized, case-folded or substring guessed', t => {
  const store = storeFor(t);
  const a = store.createEntity({ scopeId, name: 'A', type: 'Service' });
  const b = store.createEntity({ scopeId, name: 'B', type: 'Service' });
  const m = store.saveMemory({ scopeId, content: 'A depends on B.\nEvidence: café.', source: { actorRole: 'tool', complete: false } });
  const base = { scopeId, subjectId: a.id, objectId: b.id, predicate: 'depends_on', sourceId: m.sourceId };
  for (const quote of ['a depends on b.', 'A depends on B. Evidence:', 'cafe\u0301']) reject(() => store.createRelation({ ...base, quote }), 'INVALID_EVIDENCE');
  const r = store.createRelation({ ...base, quote: 'café' });
  const confirmed = store.reviewRelation({ scopeId, id: r.id, expectedRevision: 1, decision: 'confirm', reason: 'Exact recorded statement only.' });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(store.getMemory(scopeId, m.id).source.complete, false);
  assert.equal(store.getMemory(scopeId, m.id).epistemic, 'unverified');
});

test('domain and range match the entire approved predicate matrix without code or permission inference', t => {
  const store = storeFor(t);
  const types = ['Project', 'Person', 'Requirement', 'API', 'Service', 'Constraint', 'Decision', 'Document'];
  const defs = {
    belongs_to: [['Requirement', 'API', 'Service', 'Constraint', 'Decision', 'Document'], ['Project']],
    has_constraint: [['Requirement', 'API', 'Service'], ['Constraint']],
    implements: [['API', 'Service'], ['Requirement']],
    assigned_to: [['Requirement', 'Project'], ['Person']],
    depends_on: [['Requirement', 'API', 'Service'], ['Requirement', 'API', 'Service']],
    decided_by: [['Requirement', 'API', 'Service'], ['Decision']],
    related_to: [types, types],
  };
  const left = Object.fromEntries(types.map(type => [type, store.createEntity({ scopeId, type, name: 'Left ' + type })]));
  const right = Object.fromEntries(types.map(type => [type, store.createEntity({ scopeId, type, name: 'Right ' + type })]));
  for (const [predicate, [domain, range]] of Object.entries(defs)) for (const from of types) for (const to of types) {
    const result = store.validateRelation({ scopeId, subjectId: left[from].id, predicate, objectId: right[to].id });
    assert.equal(result.ok, domain.includes(from) && range.includes(to), predicate + ' ' + from + ' -> ' + to);
  }
  for (const predicate of ['supported_by', 'source', 'execute', 'has_permission', '__proto__', 'owl:sameAs']) assert.equal(store.validateRelation({ scopeId, subjectId: left.Service.id, objectId: right.Service.id, predicate }).ok, false);
  assert.deepEqual(store.listRelations({ scopeId }), []);
});

test('historical graphs retain previous entities and sources without leaking later facts', t => {
  let now = 1000;
  const store = storeFor(t, { now: () => now });
  const a = store.createEntity({ scopeId, name: 'A', type: 'Service' });
  const b = store.createEntity({ scopeId, name: 'B', type: 'Service' });
  const m = store.saveMemory({ scopeId, content: 'A depends on B.', entityIds: [a.id], validFrom: 0, validTo: 100 });
  const pending = store.createRelation({ scopeId, subjectId: a.id, predicate: 'depends_on', objectId: b.id, sourceId: m.sourceId, quote: m.content, validFrom: 0, validTo: 100 });
  const old = store.graph({ scopeId, rootId: a.id, includePending: true, knownAt: pending.recordedAt, validAt: 0, depth: 4 });
  now = 2000;
  const confirmed = store.reviewRelation({ scopeId, id: pending.id, expectedRevision: 1, decision: 'confirm', reason: 'Reviewed.' });
  store.reviseMemory({ scopeId, id: m.id, expectedRevision: 1, content: 'Corrected claim.', reason: 'New evidence.', validFrom: 10, validTo: 50 });
  assert.deepEqual(store.graph({ scopeId, rootId: a.id, includePending: true, knownAt: pending.recordedAt, validAt: 0, depth: 4 }), old);
  assert.ok(!store.graph({ scopeId, knownAt: pending.recordedAt }).edges.some(e => e.relationId === pending.id));
  assert.ok(store.graph({ scopeId, knownAt: confirmed.recordedAt }).edges.some(e => e.relationId === pending.id));
  assert.ok(!store.graph({ scopeId, validAt: 100 }).edges.some(e => e.relationId === pending.id));
});

test('scope-bound id collisions preserve original IDs without cross-scope graph leakage', t => {
  const store = storeFor(t);
  for (const scopeId of ['legacy:a', 'legacy:b']) store.importLegacy({ id: 'shared:legacy-id', scopeId, content: 'Only in ' + scopeId });
  for (const scopeId of ['legacy:a', 'legacy:b']) {
    const m = store.getMemory(scopeId, 'shared:legacy-id');
    assert.equal(m.content, 'Only in ' + scopeId);
    const graph = store.graph({ scopeId, rootId: m.id, depth: 1 });
    assert.equal(graph.nodes.length, 2);
    assert.ok(graph.nodes.every(n => n.scopeId === scopeId));
  }
});

test('explicit local memories preserve authorization-shaped content and credential metadata', t => {
  const store = storeFor(t);
  const fixture = 'fixtureonly'.repeat(4);
  for (const data of [{ content: 'Authorization: Bearer ' + fixture }, { content: 'Authorization: Basic ' + fixture }, { content: 'Safe statement.', metadata: { apiKey: fixture } }, { content: 'Safe statement.', metadata: { client_secret: fixture } }]) {
    const saved = store.saveMemory({ scopeId, ...data });
    assert.equal(saved.content, data.content);
    assert.deepEqual(saved.metadata, data.metadata ?? {});
  }
  assert.equal(store.listScopes()[0].count, 4);
});

test('bounded graph labels never split a Unicode surrogate pair', t => {
  const store = storeFor(t);
  const m = store.saveMemory({ scopeId, content: 'x'.repeat(136) + '😀' + 'y'.repeat(30) });
  const graph = store.graph({ scopeId, rootId: m.id, depth: 1 });
  assert.ok(graph.nodes.every(n => n.label.isWellFormed()));
});

test('numeric credential metadata is preserved exactly', t => {
  const store = storeFor(t);
  for (const key of ['password', 'token', 'apiKey']) {
    const saved = store.saveMemory({ scopeId, content: 'Synthetic only.', metadata: { [key]: 123456789012 } });
    assert.equal(saved.metadata[key], 123456789012);
  }
  assert.equal(store.listScopes()[0].count, 3);
});

test('corrections default to unknown origin and trusted callers may supply a validated actor role', t => {
  const store = storeFor(t);
  const original = store.saveMemory({ scopeId, content: 'Model statement.', source: { actorRole: 'assistant' } });
  const unknown = store.reviseMemory({ scopeId, id: original.id, expectedRevision: 1, content: 'Unattributed correction.', reason: 'Corrected.' });
  assert.equal(unknown.source.actorRole, 'unknown');
  const tool = store.reviseMemory({ scopeId, id: original.id, expectedRevision: 2, content: 'Tool correction.', reason: 'Tool request.', actorRole: 'tool' });
  assert.equal(tool.source.actorRole, 'tool');
  const human = store.reviseMemory({ scopeId, id: original.id, expectedRevision: 3, content: 'Human correction.', reason: 'Trusted UI request.', actorRole: 'human' });
  assert.equal(human.source.actorRole, 'human');
  assert.equal(store.versions(scopeId, original.id)[0].source.actorRole, 'assistant');
  reject(() => store.reviseMemory({ scopeId, id: original.id, expectedRevision: 4, content: 'Bad role.', reason: 'Not authorized by this field.', actorRole: 'admin' }));
  assert.equal(store.versions(scopeId, original.id).length, 4);
});

test('bounded list cap stays at five hundred while the graph workbench accepts two thousand nodes', t => {
  const store = storeFor(t);
  store.saveMemory({ scopeId, content: 'A list item.' });
  assert.equal(store.listMemories({ scopeId, limit: 500 }).length, 1);
  assert.deepEqual(store.listEntities({ scopeId, limit: 500 }), []);
  assert.deepEqual(store.listUsage({ sessionId: 'session:a', limit: 500 }), []);
  assert.equal(store.changes({ scopeId, limit: 500 }).length, 1);
  reject(() => store.listMemories({ scopeId, limit: 501 }));
  assert.ok(store.graph({ scopeId, limit: 2000 }).nodes.length >= 1);
  reject(() => store.graph({ scopeId, limit: 2001 }));
});

test('default unknown validity and explicit epoch-zero/open-ended validity remain distinct', t => {
  const store = storeFor(t);
  const unknown = store.saveMemory({ scopeId, content: 'Unknown dates.' });
  const open = store.saveMemory({ scopeId, content: 'Open validity.', validFrom: 0 });
  assert.equal(store.getMemory(scopeId, unknown.id, { validAt: 0 }), undefined);
  assert.equal(store.getMemory(scopeId, open.id, { validAt: 8640000000000000 }).id, open.id);
  assert.equal(store.listMemories({ scopeId, validAt: 0 }).length, 1);
});