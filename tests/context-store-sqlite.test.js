import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createContextStore } from '../src/context/store.js';
import { openSqlite } from '../src/context/sqlite.js';
import { ContextError } from '../src/context/errors.js';

function fixture(t) {
  const root = path.resolve('.test-data');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'context-store-sqlite-'));
  const handles = [];
  // Only this test's new synthetic directory is ever removed.
  t.after(() => { for (const handle of handles.reverse()) handle.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dbPath: path.join(dir, 'synthetic.sqlite'), track(handle) { handles.push(handle); return handle; } };
}

test('adapter uses built-in SQLite and nested savepoints roll back only failed work', t => {
  const db = openSqlite(':memory:');
  t.after(() => db.close());
  assert.equal(db.driver, 'node:sqlite');
  assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1);
  db.exec('CREATE TABLE test_batch(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT');
  db.transaction(() => {
    db.run('INSERT INTO test_batch VALUES (?,?)', 1, 'outer');
    assert.throws(() => db.transaction(() => {
      db.run('INSERT INTO test_batch VALUES (?,?)', 2, 'rolled back');
      throw new ContextError('INVALID_REFERENCE');
    }), { code: 'INVALID_REFERENCE' });
    db.run('INSERT INTO test_batch VALUES (?,?)', 3, 'outer continues');
  });
  assert.deepEqual(db.all('SELECT id FROM test_batch ORDER BY id').map(x => x.id), [1, 3]);
  assert.throws(() => db.transaction(() => {
    db.run('INSERT INTO test_batch VALUES (?,?)', 4, 'also rolled back');
    db.run('INSERT INTO test_batch VALUES (?,?)', 3, 'constraint fails late');
  }), error => error.code === 'STORE_FAILURE' && !/test_batch|INSERT|constraint|sqlite/i.test(error.message));
  assert.deepEqual(db.all('SELECT id FROM test_batch ORDER BY id').map(x => x.id), [1, 3]);
});
test('SQLite itself rejects updates to source, memory, relation and immutable trace snapshots', t => {
  const f = fixture(t);
  const store = f.track(createContextStore({ dbPath: f.dbPath }));
  const scopeId = 'sqlite:immutability';
  const a = store.createEntity({ scopeId, name: 'A', type: 'Service' });
  const b = store.createEntity({ scopeId, name: 'B', type: 'Service' });
  const m = store.saveMemory({ scopeId, content: 'A depends on B.' });
  const r = store.createRelation({ scopeId, subjectId: a.id, objectId: b.id, predicate: 'depends_on', sourceId: m.sourceId, quote: m.content });
  store.recordUsage({ id: 'usage:immutable', sessionId: 'session:fixture', scopeId, phase: 'planned', items: [{ id: m.id, revision: 1, content: m.content }] });
  const raw = f.track(new DatabaseSync(f.dbPath));
  for (const table of ['ctx_sources', 'ctx_memory_revisions', 'ctx_entity_revisions', 'ctx_relation_revisions', 'ctx_usage_records', 'ctx_changes']) {
    assert.throws(() => raw.prepare('UPDATE ' + table + ' SET record_json=?').run('{}'), /immutable/);
    assert.throws(() => raw.exec('DELETE FROM ' + table), /immutable/);
    const row = raw.prepare('SELECT * FROM ' + table + ' LIMIT 1').get();
    const keys = Object.keys(row);
    const values = keys.map(key => key === 'record_json' ? '{}' : row[key]);
    assert.throws(() => raw.prepare('INSERT OR REPLACE INTO ' + table + ' (' + keys.join(',') + ') VALUES (' + keys.map(() => '?').join(',') + ')').run(...values), /immutable/);
  }
  assert.throws(() => raw.exec("UPDATE ctx_usage_events SET phase='failed'"), /immutable/);
  assert.deepEqual(store.getMemory(scopeId, m.id), m);
  assert.deepEqual(store.listRelations({ scopeId }), [r]);
  assert.equal(store.listUsage({ sessionId: 'session:fixture' })[0].items[0].content, m.content);
  const tables = raw.prepare('PRAGMA foreign_key_check').all();
  assert.deepEqual(tables, []);
});

test('a late SQLite failure rolls back source, memory revision, clock, audit and idempotency together', t => {
  const f = fixture(t);
  let now = 100;
  const store = f.track(createContextStore({ dbPath: f.dbPath, now: () => now }));
  const scopeId = 'sqlite:rollback';
  const raw = f.track(new DatabaseSync(f.dbPath));
  raw.exec("CREATE TRIGGER fixture_fail_audit BEFORE INSERT ON ctx_changes BEGIN SELECT RAISE(ABORT, 'synthetic late failure'); END");
  const input = { scopeId, content: 'Atomic claim.', idempotencyKey: 'request:atomic' };
  assert.throws(() => store.saveMemory(input), { code: 'STORE_FAILURE' });
  for (const table of ['ctx_scopes', 'ctx_objects', 'ctx_sources', 'ctx_memories', 'ctx_memory_revisions', 'ctx_changes', 'ctx_idempotency']) assert.equal(raw.prepare('SELECT count(*) AS n FROM ' + table).get().n, 0);
  assert.equal(raw.prepare("SELECT value FROM ctx_meta WHERE key='clock'").get().value, '-1');
  raw.exec('DROP TRIGGER fixture_fail_audit');
  const m = store.saveMemory(input);
  assert.equal(m.recordedAt, 100);
  now = 200;
  raw.exec("CREATE TRIGGER fixture_fail_revision BEFORE INSERT ON ctx_changes BEGIN SELECT RAISE(ABORT, 'synthetic late failure'); END");
  assert.throws(() => store.reviseMemory({ scopeId, id: m.id, expectedRevision: 1, content: 'Should not persist.', reason: 'Fixture.' }), { code: 'STORE_FAILURE' });
  assert.deepEqual(store.getMemory(scopeId, m.id), m);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM ctx_sources').get().n, 1);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM ctx_memory_revisions').get().n, 1);
  raw.exec('DROP TRIGGER fixture_fail_revision');
  assert.deepEqual(store.saveMemory(input), m);
});

test('two file handles enforce stale-write and idempotency checks under actual SQLite transactions', t => {
  const f = fixture(t);
  const a = f.track(createContextStore({ dbPath: f.dbPath, now: () => 100 }));
  const b = f.track(createContextStore({ dbPath: f.dbPath, now: () => 100 }));
  const input = { scopeId: 'sqlite:concurrent', content: 'One claim.', idempotencyKey: 'same:key' };
  const m = a.saveMemory(input);
  assert.deepEqual(b.saveMemory(input), m);
  const newer = b.reviseMemory({ scopeId: m.scopeId, id: m.id, expectedRevision: 1, content: 'New revision.', reason: 'Current knowledge.' });
  assert.ok(newer.recordedAt > m.recordedAt);
  assert.throws(() => a.reviseMemory({ scopeId: m.scopeId, id: m.id, expectedRevision: 1, content: 'Stale write.', reason: 'Must not overwrite.' }), { code: 'VERSION_CONFLICT' });
  assert.deepEqual(a.getMemory(m.scopeId, m.id), newer);
  assert.deepEqual(a.saveMemory(input), m);
});

test('unrelated SQLite databases are refused without migrations or content changes', t => {
  const f = fixture(t);
  const raw = new DatabaseSync(f.dbPath);
  raw.exec("CREATE TABLE unrelated_fixture(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO unrelated_fixture VALUES (1,'preserve');");
  raw.close();
  const before = readFileSync(f.dbPath);
  assert.throws(() => createContextStore({ dbPath: f.dbPath }), { code: 'STORE_UNAVAILABLE' });
  assert.deepEqual(readFileSync(f.dbPath), before);
});
