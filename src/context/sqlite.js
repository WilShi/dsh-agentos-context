import { createRequire } from 'node:module';
import { ContextError, fail, safeError } from './errors.js';

const require = createRequire(import.meta.url);
const APPLICATION_ID = 1095713624;
const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE ctx_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
INSERT INTO ctx_meta VALUES ('clock', '-1');
CREATE TABLE ctx_scopes (id TEXT PRIMARY KEY, label TEXT NOT NULL) STRICT;
CREATE TABLE ctx_objects (
  scope_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('memory','entity','relation','source')),
  PRIMARY KEY(scope_id,id), FOREIGN KEY(scope_id) REFERENCES ctx_scopes(id)
) STRICT;
CREATE TABLE ctx_sources (
  scope_id TEXT NOT NULL, id TEXT NOT NULL, content TEXT NOT NULL, recorded_at INTEGER NOT NULL, record_json TEXT NOT NULL,
  PRIMARY KEY(scope_id,id), FOREIGN KEY(scope_id,id) REFERENCES ctx_objects(scope_id,id)
) STRICT;
CREATE TABLE ctx_entities (
  scope_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL,
  PRIMARY KEY(scope_id,id), FOREIGN KEY(scope_id,id) REFERENCES ctx_objects(scope_id,id)
) STRICT;
CREATE TABLE ctx_entity_revisions (
  scope_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), recorded_at INTEGER NOT NULL, record_json TEXT NOT NULL,
  PRIMARY KEY(scope_id,id,revision), FOREIGN KEY(scope_id,id) REFERENCES ctx_entities(scope_id,id)
) STRICT;
CREATE TABLE ctx_entity_aliases (
  scope_id TEXT NOT NULL, type TEXT NOT NULL, alias_key TEXT NOT NULL, entity_id TEXT NOT NULL, label TEXT NOT NULL,
  PRIMARY KEY(scope_id,type,alias_key), FOREIGN KEY(scope_id,entity_id) REFERENCES ctx_entities(scope_id,id)
) STRICT;
CREATE TABLE ctx_entity_redirects (
  scope_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  PRIMARY KEY(scope_id,from_id), CHECK(from_id <> to_id),
  FOREIGN KEY(scope_id,from_id) REFERENCES ctx_entities(scope_id,id), FOREIGN KEY(scope_id,to_id) REFERENCES ctx_entities(scope_id,id)
) STRICT;
CREATE TABLE ctx_memories (
  scope_id TEXT NOT NULL, id TEXT NOT NULL,
  PRIMARY KEY(scope_id,id), FOREIGN KEY(scope_id,id) REFERENCES ctx_objects(scope_id,id)
) STRICT;
CREATE TABLE ctx_memory_revisions (
  scope_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), source_id TEXT NOT NULL, content TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','candidate','retired')),
  epistemic TEXT NOT NULL CHECK(epistemic IN ('unverified','supported','contested','refuted')),
  recorded_at INTEGER NOT NULL, valid_from INTEGER, valid_to INTEGER,
  layer TEXT NOT NULL DEFAULT 'semantic' CHECK(layer IN ('working','episodic','semantic','procedural')),
  importance REAL NOT NULL DEFAULT 0.5 CHECK(importance >= 0 AND importance <= 1), expires_at INTEGER,
  record_json TEXT NOT NULL,
  CHECK(valid_to IS NULL OR (valid_from IS NOT NULL AND valid_from < valid_to)),
  PRIMARY KEY(scope_id,id,revision), FOREIGN KEY(scope_id,id) REFERENCES ctx_memories(scope_id,id),
  FOREIGN KEY(scope_id,source_id) REFERENCES ctx_sources(scope_id,id)
) STRICT;
CREATE TABLE ctx_memory_mentions (
  scope_id TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL, entity_id TEXT NOT NULL,
  PRIMARY KEY(scope_id,memory_id,revision,entity_id),
  FOREIGN KEY(scope_id,memory_id,revision) REFERENCES ctx_memory_revisions(scope_id,id,revision),
  FOREIGN KEY(scope_id,entity_id) REFERENCES ctx_entities(scope_id,id)
) STRICT;
CREATE TABLE ctx_relations (
  scope_id TEXT NOT NULL, id TEXT NOT NULL,
  PRIMARY KEY(scope_id,id), FOREIGN KEY(scope_id,id) REFERENCES ctx_objects(scope_id,id)
) STRICT;
CREATE TABLE ctx_relation_revisions (
  scope_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
  subject_id TEXT NOT NULL, object_id TEXT NOT NULL, predicate TEXT NOT NULL, source_id TEXT, quote TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','confirmed','rejected')), recorded_at INTEGER NOT NULL, valid_from INTEGER, valid_to INTEGER, record_json TEXT NOT NULL,
  CHECK(subject_id <> object_id), CHECK(valid_to IS NULL OR (valid_from IS NOT NULL AND valid_from < valid_to)),
  CHECK(status <> 'confirmed' OR (source_id IS NOT NULL AND quote IS NOT NULL AND length(quote) > 0)),
  PRIMARY KEY(scope_id,id,revision), FOREIGN KEY(scope_id,id) REFERENCES ctx_relations(scope_id,id),
  FOREIGN KEY(scope_id,subject_id) REFERENCES ctx_entities(scope_id,id), FOREIGN KEY(scope_id,object_id) REFERENCES ctx_entities(scope_id,id),
  FOREIGN KEY(scope_id,source_id) REFERENCES ctx_sources(scope_id,id)
) STRICT;
CREATE TABLE ctx_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, scope_id TEXT NOT NULL, recorded_at INTEGER NOT NULL, record_json TEXT NOT NULL,
  FOREIGN KEY(scope_id) REFERENCES ctx_scopes(id)
) STRICT;
CREATE TABLE ctx_idempotency (
  scope_id TEXT NOT NULL, key TEXT NOT NULL, payload_hash TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(scope_id,key), FOREIGN KEY(scope_id,memory_id,revision) REFERENCES ctx_memory_revisions(scope_id,id,revision)
) STRICT;
CREATE TABLE ctx_legacy_imports (
  scope_id TEXT NOT NULL, id TEXT NOT NULL, payload_hash TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(scope_id,id), FOREIGN KEY(scope_id,id,revision) REFERENCES ctx_memory_revisions(scope_id,id,revision)
) STRICT;
CREATE TABLE ctx_usage_records (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, scope_id TEXT NOT NULL, payload_hash TEXT NOT NULL, recorded_at INTEGER NOT NULL, record_json TEXT NOT NULL,
  FOREIGN KEY(scope_id) REFERENCES ctx_scopes(id)
) STRICT;
CREATE TABLE ctx_usage_events (
  usage_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), phase TEXT NOT NULL, event_seq INTEGER, at INTEGER NOT NULL,
  CHECK(phase IN ('planned','committed','requested','failed')),
  PRIMARY KEY(usage_id,revision), FOREIGN KEY(usage_id) REFERENCES ctx_usage_records(id)
) STRICT;
CREATE TABLE ctx_policy_revisions (
  session_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), scope_id TEXT NOT NULL, recorded_at INTEGER NOT NULL, record_json TEXT NOT NULL,
  PRIMARY KEY(session_id,revision), FOREIGN KEY(scope_id) REFERENCES ctx_scopes(id)
) STRICT;
CREATE INDEX ctx_memory_known ON ctx_memory_revisions(scope_id,recorded_at,id,revision);
CREATE INDEX ctx_memory_layer ON ctx_memory_revisions(scope_id,layer,lifecycle,expires_at,recorded_at);
CREATE INDEX ctx_entity_known ON ctx_entity_revisions(scope_id,recorded_at,id,revision);
CREATE INDEX ctx_relation_subject ON ctx_relation_revisions(scope_id,subject_id,id,revision);
CREATE INDEX ctx_relation_object ON ctx_relation_revisions(scope_id,object_id,id,revision);
CREATE INDEX ctx_relation_source ON ctx_relation_revisions(scope_id,source_id,id,revision);
CREATE INDEX ctx_mentions_entity ON ctx_memory_mentions(scope_id,entity_id,memory_id,revision);
CREATE INDEX ctx_memory_source ON ctx_memory_revisions(scope_id,source_id,id,revision);
CREATE INDEX ctx_redirect_target ON ctx_entity_redirects(scope_id,to_id,recorded_at);
CREATE INDEX ctx_changes_scope ON ctx_changes(scope_id,seq);
CREATE INDEX ctx_usage_session ON ctx_usage_records(session_id,scope_id,recorded_at);
`;
const IMMUTABLE_TABLES = ['ctx_scopes', 'ctx_objects', 'ctx_sources', 'ctx_entities', 'ctx_entity_revisions', 'ctx_entity_redirects', 'ctx_memories', 'ctx_memory_revisions', 'ctx_memory_mentions', 'ctx_relations', 'ctx_relation_revisions', 'ctx_changes', 'ctx_idempotency', 'ctx_legacy_imports', 'ctx_usage_records', 'ctx_usage_events', 'ctx_policy_revisions'];

const IMMUTABLE_KEYS = Object.freeze({
  ctx_scopes: ['id'], ctx_objects: ['scope_id', 'id'], ctx_sources: ['scope_id', 'id'],
  ctx_entities: ['scope_id', 'id'], ctx_entity_revisions: ['scope_id', 'id', 'revision'],
  ctx_entity_redirects: ['scope_id', 'from_id'], ctx_memories: ['scope_id', 'id'],
  ctx_memory_revisions: ['scope_id', 'id', 'revision'], ctx_memory_mentions: ['scope_id', 'memory_id', 'revision', 'entity_id'],
  ctx_relations: ['scope_id', 'id'], ctx_relation_revisions: ['scope_id', 'id', 'revision'],
  ctx_changes: ['id'], ctx_idempotency: ['scope_id', 'key'], ctx_legacy_imports: ['scope_id', 'id'],
  ctx_usage_records: ['id'], ctx_usage_events: ['usage_id', 'revision'], ctx_policy_revisions: ['session_id', 'revision'],
});

/**
 * Sidecar migrations are strictly additive.  We never touch record_json in
 * an existing revision because that JSON is the immutable audit snapshot; the
 * projection layer supplies semantic defaults for v1 rows instead.
 */
function migrate(db, version) {
  if (version === 1) {
    db.exec(`
      ALTER TABLE ctx_memory_revisions ADD COLUMN layer TEXT NOT NULL DEFAULT 'semantic'
        CHECK(layer IN ('working','episodic','semantic','procedural'));
      ALTER TABLE ctx_memory_revisions ADD COLUMN importance REAL NOT NULL DEFAULT 0.5
        CHECK(importance >= 0 AND importance <= 1);
      ALTER TABLE ctx_memory_revisions ADD COLUMN expires_at INTEGER;
      CREATE INDEX IF NOT EXISTS ctx_memory_layer ON ctx_memory_revisions(scope_id,layer,lifecycle,expires_at,recorded_at);
      PRAGMA user_version=2;
    `);
    return;
  }
  fail('STORE_UNAVAILABLE');
}
function protectImmutableRows(db) {
  for (const table of IMMUTABLE_TABLES) {
    for (const action of ['UPDATE', 'DELETE']) {
      db.exec('CREATE TRIGGER IF NOT EXISTS ' + table + '_immutable_' + action.toLowerCase() + ' BEFORE ' + action + ' ON ' + table + " BEGIN SELECT RAISE(ABORT, 'immutable record'); END");
    }
    // REPLACE can bypass DELETE triggers on other SQLite connections. Refuse
    // conflicting identities BEFORE INSERT, independent of recursive_triggers.
    let duplicate = IMMUTABLE_KEYS[table].map(key => key + '=NEW.' + key).join(' AND ');
    if (table === 'ctx_changes') duplicate = '(' + duplicate + ') OR seq=NEW.seq';
    db.exec('CREATE TRIGGER IF NOT EXISTS ' + table + '_immutable_insert BEFORE INSERT ON ' + table
      + ' WHEN EXISTS(SELECT 1 FROM ' + table + ' WHERE ' + duplicate + ") BEGIN SELECT RAISE(ABORT, 'immutable record'); END");
  }
}

/** Internal adapter. Never selects a profile, default DB, or network location. */
export function openSqlite(dbPath) {
  if (typeof dbPath !== 'string' || !dbPath.trim() || dbPath.length > 4096 || /[\u0000-\u001f]/u.test(dbPath) || /^(?:file:|https?:|\\\\|\/\/)/iu.test(dbPath) || (dbPath.startsWith(':') && dbPath !== ':memory:')) fail('INVALID_INPUT', 'dbPath');
  let db;
  let driver;
  try {
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch (error) { if (!['ERR_UNKNOWN_BUILTIN_MODULE', 'MODULE_NOT_FOUND'].includes(error.code)) throw error; }
    if (DatabaseSync) {
      db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
      driver = 'node:sqlite';
    } else {
      // A compatible preinstalled fallback only; no installers or native rebuilds.
      const BetterSqlite = require('better-sqlite3');
      db = new BetterSqlite(dbPath);
      driver = 'better-sqlite3';
    }
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF; PRAGMA recursive_triggers=ON;');
    db.exec('BEGIN IMMEDIATE');
    try {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      const applicationId = db.prepare('PRAGMA application_id').get().application_id;
      if (applicationId === 0 && version === 0) {
        const count = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().n;
        if (count !== 0) fail('STORE_UNAVAILABLE');
        db.exec(DDL);
        db.exec('PRAGMA application_id=' + APPLICATION_ID + '; PRAGMA user_version=' + SCHEMA_VERSION + ';');
      } else if (applicationId !== APPLICATION_ID || version > SCHEMA_VERSION) {
        fail('STORE_UNAVAILABLE');
      } else if (version !== SCHEMA_VERSION) {
        migrate(db, version);
      }
      protectImmutableRows(db);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve a sanitized failure */ }
      throw error;
    }
    if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  } catch (error) {
    try { db?.close(); } catch { /* no exposed native error */ }
    throw safeError(error, 'STORE_UNAVAILABLE');
  }
  let closed = false;
  let transactionDepth = 0;
  let savepointId = 0;
  const check = () => { if (closed) fail('STORE_CLOSED'); };
  const boundary = fn => { check(); try { return fn(); } catch (error) { throw safeError(error); } };
  const transaction = (fn, readOnly = false) => boundary(() => {
    const nested = transactionDepth > 0;
    const name = 'ctx_savepoint_' + (++savepointId);
    db.exec(nested ? 'SAVEPOINT ' + name : readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
    transactionDepth++;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') fail('INVALID_INPUT');
      db.exec(nested ? 'RELEASE SAVEPOINT ' + name : 'COMMIT');
      return result;
    } catch (error) {
      try { db.exec(nested ? 'ROLLBACK TO SAVEPOINT ' + name + '; RELEASE SAVEPOINT ' + name : 'ROLLBACK'); } catch { /* no paths or SQL */ }
      throw error;
    } finally { transactionDepth--; }
  });
  return Object.freeze({
    driver, check,
    get: (sql, ...params) => boundary(() => db.prepare(sql).get(...params)),
    all: (sql, ...params) => boundary(() => db.prepare(sql).all(...params)),
    run: (sql, ...params) => boundary(() => db.prepare(sql).run(...params)),
    exec: sql => boundary(() => db.exec(sql)),
    transaction: fn => transaction(fn),
    readTransaction: fn => transaction(fn, true),
    close() {
      if (closed) return;
      if (transactionDepth !== 0) throw new ContextError('STORE_FAILURE');
      try { db.close(); } catch (error) { throw safeError(error); } finally { closed = true; }
    },
  });
}
