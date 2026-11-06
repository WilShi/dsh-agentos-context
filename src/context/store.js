import { randomUUID, createHash } from 'node:crypto';
import { openSqlite } from './sqlite.js';
import { ContextError, fail, safeError } from './errors.js';
import { ENTITY_TYPES, MEMORY_KINDS, MEMORY_LAYERS, DEFAULT_MEMORY_LAYER, ACTOR_ROLES, LIFECYCLES, EPISTEMIC_STATES, RELATION_STATUSES, relationDefinition, getSchema } from './schema.js';
import * as v from './validation.js';
import { decode, revisionAt, latestRecords, resolveEntity, sourceAt, projectGraph } from './projections.js';
import { GLOBAL_SCOPE_ID } from './scope.js';

const uid = kind => kind + ':' + randomUUID();
const hash = value => createHash('sha256').update(v.canonical(value)).digest('hex');
const changed = (expected, actual) => { if (expected !== actual) fail('VERSION_CONFLICT', 'expectedRevision'); };
const required = record => { if (!record) fail('NOT_FOUND'); return record; };
const boundedResult = (rows, max = 1000) => { if (rows.length > max) fail('LIMIT_EXCEEDED'); return rows; };
const relationFields = ['scopeId', 'subjectId', 'predicate', 'objectId', 'sourceId', 'quote', 'validFrom', 'validTo'];
const DEFAULT_IMPORTANCE = Object.freeze({ working: 0.35, episodic: 0.55, semantic: 0.7, procedural: 0.8 });

function optionsOf(options) {
  if (!options || Array.isArray(options) || typeof options !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) fail('INVALID_INPUT');
  const keys = Reflect.ownKeys(options);
  if (keys.some(key => !['dbPath', 'now'].includes(key))) fail('INVALID_INPUT');
  const d = Object.getOwnPropertyDescriptors(options);
  if (keys.some(key => !Object.hasOwn(d[key], 'value') || !d[key].enumerable)) fail('INVALID_INPUT');
  const dbPath = d.dbPath?.value;
  const now = d.now?.value === undefined ? Date.now : d.now.value;
  if (typeof dbPath !== 'string' || !dbPath.trim() || typeof now !== 'function') fail('INVALID_INPUT');
  return { dbPath, now };
}
function sourceInput(input, content) {
  const s = input === undefined ? {} : v.objectInput(input, ['content', 'kind', 'actorRole', 'complete', 'lineageId'], 'source');
  return {
    content: s.content === undefined ? content : v.text(s.content, 'source.content'),
    kind: s.kind === undefined ? 'manual' : v.text(s.kind, 'source.kind', 100),
    actorRole: s.actorRole === undefined ? 'unknown' : v.enumeration(s.actorRole, ACTOR_ROLES, 'source.actorRole'),
    complete: s.complete === undefined ? true : v.boolean(s.complete, 'source.complete'),
    lineageId: s.lineageId == null ? null : v.identifier(s.lineageId, 'source.lineageId'),
  };
}

function placementInput(input, previous = {}) {
  const layer = input.layer === undefined ? (previous.layer ?? DEFAULT_MEMORY_LAYER) : v.enumeration(input.layer, MEMORY_LAYERS, 'layer');
  const importance = input.importance === undefined ? (previous.importance ?? DEFAULT_IMPORTANCE[layer]) : v.finiteNumber(input.importance, 'importance', 0, 1);
  const expiresAt = input.expiresAt === undefined ? (previous.expiresAt ?? null) : input.expiresAt;
  if (expiresAt !== null) v.timestamp(expiresAt, 'expiresAt');
  return { layer, importance, expiresAt };
}

/** Synchronous, explicit-path sidecar. Caller identity is enforced by the service. */
export function createContextStore(options) {
  const { dbPath, now } = optionsOf(options);
  const db = openSqlite(dbPath);
  const ensureScope = scopeId => {
    if (!db.get('SELECT 1 FROM ctx_scopes WHERE id=?', scopeId)) db.run('INSERT INTO ctx_scopes(id,label) VALUES (?,?)', scopeId, scopeId);
  };
  const register = (scopeId, id, kind) => {
    ensureScope(scopeId);
    if (db.get('SELECT 1 FROM ctx_objects WHERE scope_id=? AND id=?', scopeId, id)) fail('IDEMPOTENCY_CONFLICT');
    db.run('INSERT INTO ctx_objects(scope_id,id,kind) VALUES (?,?,?)', scopeId, id, kind);
  };
  function stamp() {
    const time = v.timestamp(now(), 'now');
    const previous = Number(db.get("SELECT value FROM ctx_meta WHERE key='clock'").value);
    const result = v.timestamp(Math.max(time, previous + 1), 'now');
    db.run("UPDATE ctx_meta SET value=? WHERE key='clock'", String(result));
    return result;
  }
  function audit(scopeId, action, targetId, revision, reason, at, detail) {
    const record = { id: uid('change'), action, targetId, reason, at, revision, ...(detail && typeof detail === 'object' ? detail : {}) };
    db.run('INSERT INTO ctx_changes(id,scope_id,recorded_at,record_json) VALUES (?,?,?,?)', record.id, scopeId, at, JSON.stringify(record));
  }
  function insertSource(scopeId, input, at) {
    const source = { id: uid('source'), scopeId, ...input, recordedAt: at };
    register(scopeId, source.id, 'source');
    db.run('INSERT INTO ctx_sources(scope_id,id,content,recorded_at,record_json) VALUES (?,?,?,?,?)', scopeId, source.id, source.content, at, JSON.stringify(source));
    return source;
  }
  function insertMemory(m, entityIds = []) {
    db.run(`INSERT INTO ctx_memory_revisions(scope_id,id,revision,source_id,content,lifecycle,epistemic,recorded_at,valid_from,valid_to,layer,importance,expires_at,record_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, m.scopeId, m.id, m.revision, m.sourceId, m.content, m.lifecycle, m.epistemic, m.recordedAt, m.validFrom, m.validTo, m.layer, m.importance, m.expiresAt, JSON.stringify(m));
    const seen = new Set();
    for (const id of entityIds) {
      const entity = required(resolveEntity(db, m.scopeId, id));
      if (seen.has(entity.id)) continue;
      seen.add(entity.id);
      db.run('INSERT INTO ctx_memory_mentions(scope_id,memory_id,revision,entity_id) VALUES (?,?,?,?)', m.scopeId, m.id, m.revision, entity.id);
    }
  }
  const mentions = m => db.all('SELECT entity_id FROM ctx_memory_mentions WHERE scope_id=? AND memory_id=? AND revision=? ORDER BY entity_id', m.scopeId, m.id, m.revision).map(x => x.entity_id);
  function newMemory(scopeId, id, content, kind, metadata, source, at, validity, placement, lifecycle, legacy, entityIds = []) {
    register(scopeId, id, 'memory');
    db.run('INSERT INTO ctx_memories(scope_id,id) VALUES (?,?)', scopeId, id);
    const m = { id, revision: 1, scopeId, content, kind, layer: placement.layer, importance: placement.importance, expiresAt: placement.expiresAt, promotedFrom: null, lifecycle, epistemic: 'unverified', sourceId: source.id, source, recordedAt: at, ...validity, metadata, legacy };
    insertMemory(m, entityIds);
    return m;
  }
  function insertEntity(e) {
    db.run('INSERT INTO ctx_entity_revisions(scope_id,id,revision,recorded_at,record_json) VALUES (?,?,?,?,?)', e.scopeId, e.id, e.revision, e.recordedAt, JSON.stringify(e));
  }
  function assignAliases(e, allowedIds = [e.id]) {
    for (const label of [e.name, ...e.aliases]) {
      const key = v.nameKey(label);
      const existing = db.get('SELECT entity_id FROM ctx_entity_aliases WHERE scope_id=? AND type=? AND alias_key=?', e.scopeId, e.type, key);
      if (existing && !allowedIds.includes(existing.entity_id)) fail('ENTITY_CONFLICT');
    }
    for (const id of allowedIds) db.run('DELETE FROM ctx_entity_aliases WHERE scope_id=? AND entity_id=?', e.scopeId, id);
    for (const label of [e.name, ...e.aliases]) db.run('INSERT INTO ctx_entity_aliases(scope_id,type,alias_key,entity_id,label) VALUES (?,?,?,?,?)', e.scopeId, e.type, v.nameKey(label), e.id, label);
  }
  function insertRelation(r) {
    db.run(`INSERT INTO ctx_relation_revisions(scope_id,id,revision,subject_id,object_id,predicate,source_id,quote,status,recorded_at,valid_from,valid_to,record_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, r.scopeId, r.id, r.revision, r.subjectId, r.objectId, r.predicate, r.sourceId, r.quote, r.status, r.recordedAt, r.validFrom, r.validTo, JSON.stringify(r));
  }
  function checkedRelation(input) {
    const data = v.objectInput(input, relationFields);
    const scopeId = v.identifier(data.scopeId, 'scopeId');
    const subject = required(resolveEntity(db, scopeId, v.identifier(data.subjectId, 'subjectId')));
    const object = required(resolveEntity(db, scopeId, v.identifier(data.objectId, 'objectId')));
    const definition = relationDefinition(data.predicate);
    if (!definition) fail('INVALID_RELATION', 'predicate');
    if (!definition.domain.includes(subject.type)) fail('INVALID_RELATION', 'subjectId');
    if (!definition.range.includes(object.type)) fail('INVALID_RELATION', 'objectId');
    if (subject.id === object.id) fail('INVALID_RELATION', 'objectId');
    const sourceId = data.sourceId == null ? null : v.identifier(data.sourceId, 'sourceId');
    const quote = data.quote == null ? null : v.text(data.quote, 'quote');
    const source = sourceId ? required(sourceAt(db, scopeId, sourceId)) : null;
    if (quote !== null && (!source || !source.content.includes(quote))) fail('INVALID_EVIDENCE', 'quote');
    return { scopeId, subjectId: subject.id, objectId: object.id, predicate: definition.id, sourceId, quote, ...v.interval(data) };
  }
  function usageView(row) {
    if (!row) return undefined;
    const usage = decode(row);
    const event = db.get('SELECT * FROM ctx_usage_events WHERE usage_id=? ORDER BY revision DESC LIMIT 1', usage.id);
    return { ...usage, phase: event.phase, at: event.at, ...(event.event_seq === null ? {} : { eventSeq: event.event_seq }) };
  }
  // Client event times live in their own domain: kept in memory for the live
  // path and mirrored into the insert-only audit log so a restart can still
  // compare "same-domain" timestamps. Never mixed with stamp().
  const usageClientAt = new Map();
  function previousUsageClientAt(usageId, record, scopeId) {
    const cached = usageClientAt.get(usageId);
    if (cached !== undefined) return cached;
    if (record && Number.isFinite(record.clientAt)) {
      usageClientAt.set(usageId, record.clientAt);
      return record.clientAt;
    }
    try {
      const change = decode(db.get("SELECT record_json FROM ctx_changes WHERE scope_id=? AND json_extract(record_json,'$.targetId')=? AND json_extract(record_json,'$.clientAt') IS NOT NULL ORDER BY seq DESC LIMIT 1", scopeId, usageId));
      if (change && Number.isFinite(change.clientAt)) {
        usageClientAt.set(usageId, change.clientAt);
        return change.clientAt;
      }
    }
    catch { /* JSON1 unavailable: the in-memory map still covers this process */ }
    return undefined;
  }
  function policy(sessionId) {
    return decode(db.get('SELECT record_json FROM ctx_policy_revisions WHERE session_id=? ORDER BY revision DESC LIMIT 1', sessionId)) ?? { revision: 0, paused: false, excludedIds: [], preferredIds: [] };
  }
  function knownMemory(scopeId, id) {
    const record = revisionAt(db, 'memory', scopeId, id);
    if (record) return record;
    // Same-scope non-memory ids and ids known only in another scope answer
    // identically, so probing cannot reveal foreign-scope membership
    // (HOST-REVIEW M11). Unknown ids stay undefined and the caller maps them
    // to the same INVALID_REFERENCE.
    if (db.get('SELECT 1 FROM ctx_objects WHERE id=? LIMIT 1', id)) fail('INVALID_REFERENCE');
    return undefined;
  }

  const methods = {
    listScopes() {
      return boundedResult(db.all(`SELECT s.id,s.label,(SELECT count(*) FROM ctx_memory_revisions r
        WHERE r.scope_id=s.id AND r.lifecycle<>'retired' AND (r.expires_at IS NULL OR r.expires_at>?) AND r.revision=(SELECT max(v.revision) FROM ctx_memory_revisions v WHERE v.scope_id=r.scope_id AND v.id=r.id)) AS count
        FROM ctx_scopes s ORDER BY s.id LIMIT 1001`, v.timestamp(now(), 'now'))).map(r => ({ ...r }));
    },
    saveMemory(input) {
      const data = v.objectInput(input, ['scopeId', 'content', 'kind', 'layer', 'importance', 'expiresAt', 'lifecycle', 'source', 'metadata', 'idempotencyKey', 'validFrom', 'validTo', 'entityIds']);
      const scopeId = v.identifier(data.scopeId, 'scopeId');
      const content = v.text(data.content);
      const kind = data.kind === undefined ? 'note' : v.enumeration(data.kind, MEMORY_KINDS, 'kind');
      const metadata = v.metadata(data.metadata);
      const sourceData = sourceInput(data.source, content);
      const validity = v.interval(data);
      const placement = placementInput(data);
      const lifecycle = data.lifecycle === undefined ? 'active' : v.enumeration(data.lifecycle, ['active', 'candidate'], 'lifecycle');
      const entityIds = v.ids(data.entityIds).sort();
      const key = data.idempotencyKey === undefined ? undefined : v.identifier(data.idempotencyKey, 'idempotencyKey');
      const fingerprint = hash({ scopeId, content, kind, lifecycle, source: sourceData, metadata, ...validity, ...placement, entityIds });
      if (key !== undefined) {
        const replay = db.get('SELECT * FROM ctx_idempotency WHERE scope_id=? AND key=?', scopeId, key);
        if (replay) {
          if (replay.payload_hash !== fingerprint) fail('IDEMPOTENCY_CONFLICT');
          return decode(db.get('SELECT record_json FROM ctx_memory_revisions WHERE scope_id=? AND id=? AND revision=?', scopeId, replay.memory_id, replay.revision));
        }
      }
      const at = stamp();
      const source = insertSource(scopeId, sourceData, at);
      const m = newMemory(scopeId, uid('memory'), content, kind, metadata, source, at, validity, placement, lifecycle, false, entityIds);
      if (key !== undefined) db.run('INSERT INTO ctx_idempotency(scope_id,key,payload_hash,memory_id,revision) VALUES (?,?,?,?,?)', scopeId, key, fingerprint, m.id, m.revision);
      audit(scopeId, 'memory.save', m.id, m.revision, 'Explicit save.', at);
      return m;
    },
    importLegacy(input) {
      const data = v.objectInput(input, ['id', 'scopeId', 'content', 'timestamp', 'metadata']);
      const id = v.identifier(data.id);
      const scopeId = v.identifier(data.scopeId, 'scopeId');
      const content = v.text(data.content);
      const metadata = v.metadata(data.metadata);
      if (data.timestamp !== undefined) metadata.legacyTimestamp = v.timestamp(data.timestamp, 'timestamp');
      const fingerprint = hash({ id, scopeId, content, metadata });
      const replay = db.get('SELECT * FROM ctx_legacy_imports WHERE scope_id=? AND id=?', scopeId, id);
      if (replay) {
        if (replay.payload_hash !== fingerprint) fail('IDEMPOTENCY_CONFLICT');
        return decode(db.get('SELECT record_json FROM ctx_memory_revisions WHERE scope_id=? AND id=? AND revision=?', scopeId, id, replay.revision));
      }
      const at = stamp();
      const source = insertSource(scopeId, { content, kind: 'legacy', actorRole: 'unknown', complete: false, lineageId: null }, at);
      const m = newMemory(scopeId, id, content, 'note', metadata, source, at, { validFrom: null, validTo: null }, { layer: 'semantic', importance: 0.5, expiresAt: null }, 'active', true);
      db.run('INSERT INTO ctx_legacy_imports(scope_id,id,payload_hash,revision) VALUES (?,?,?,?)', scopeId, id, fingerprint, 1);
      audit(scopeId, 'memory.import', id, 1, 'Explicit legacy import; original source unknown.', at);
      return m;
    },
    getMemory(scopeId, id, options = {}) {
      v.identifier(scopeId, 'scopeId'); v.identifier(id);
      const filter = v.timeFilter(v.objectInput(options, ['knownAt', 'validAt']));
      const record = revisionAt(db, 'memory', scopeId, id, filter.knownAt);
      return record && v.validAt(record, filter.validAt) ? record : undefined;
    },
    listMemories(input) {
      const data = v.objectInput(input, ['scopeId', 'query', 'lifecycle', 'epistemic', 'layer', 'limit', 'knownAt', 'validAt']);
      const scopeId = v.identifier(data.scopeId, 'scopeId');
      const conditions = [];
      const params = [];
      if (data.lifecycle !== undefined) { conditions.push('r.lifecycle=?'); params.push(v.enumeration(data.lifecycle, LIFECYCLES, 'lifecycle')); }
      else conditions.push("r.lifecycle<>'retired'");
      if (data.epistemic !== undefined) { conditions.push('r.epistemic=?'); params.push(v.enumeration(data.epistemic, EPISTEMIC_STATES, 'epistemic')); }
      if (data.layer !== undefined) { conditions.push('r.layer=?'); params.push(v.enumeration(data.layer, MEMORY_LAYERS, 'layer')); }
      if (data.lifecycle === undefined || data.lifecycle === 'active') { conditions.push('(r.expires_at IS NULL OR r.expires_at>?)'); params.push(data.knownAt === undefined ? v.timestamp(now(), 'now') : v.timestamp(data.knownAt, 'knownAt')); }
      const query = v.query(data.query);
      if (query) { conditions.push('instr(lower(r.content),lower(?))>0'); params.push(query); }
      return latestRecords(db, 'memory', scopeId, { ...v.timeFilter(data), conditions: conditions.join(' AND '), params, limit: v.limit(data.limit) });
    },
    searchMemories(input) {
      const data = v.objectInput(input, ['scopeId', 'queries', 'lifecycle', 'limit']);
      const scopeId = v.identifier(data.scopeId, 'scopeId');
      if (!Array.isArray(data.queries) || data.queries.length < 1 || data.queries.length > 25) fail('INVALID_INPUT', 'queries');
      const queries = [...new Set(data.queries.map((query, index) => v.query(query) || fail('INVALID_INPUT', `queries.${index}`)))];
      const lifecycle = data.lifecycle === undefined ? 'active' : v.enumeration(data.lifecycle, LIFECYCLES, 'lifecycle');
      const nowAt = v.timestamp(now(), 'now');
      const match = queries.map(() => 'instr(lower(r.content),lower(?))>0').join(' OR ');
      const rank = queries.map((_, index) => `(CASE WHEN instr(lower(r.content),lower(?))>0 THEN ${index === 0 ? 100 : 1} ELSE 0 END)`).join(' + ');
      const conditions = [`r.lifecycle=?`, '(r.expires_at IS NULL OR r.expires_at>?)', `(${match})`];
      return latestRecords(db, 'memory', scopeId, {
        conditions: conditions.join(' AND '),
        params: [lifecycle, nowAt, ...queries],
        limit: v.limit(data.limit),
        order: `${rank} DESC, r.recorded_at DESC, r.id`,
        orderParams: queries,
      });
    },
    reviseMemory(input) {
      const data = v.objectInput(input, ['scopeId', 'id', 'expectedRevision', 'content', 'reason', 'kind', 'layer', 'importance', 'expiresAt', 'validFrom', 'validTo', 'actorRole']);
      const scopeId = v.identifier(data.scopeId, 'scopeId');
      const id = v.identifier(data.id);
      const expected = v.integer(data.expectedRevision, 'expectedRevision', 1);
      const content = v.text(data.content);
      const reason = v.text(data.reason, 'reason', 4000);
      const previous = required(revisionAt(db, 'memory', scopeId, id));
      changed(expected, previous.revision);
      const kind = data.kind === undefined ? previous.kind : v.enumeration(data.kind, MEMORY_KINDS, 'kind');
      // Source attribution is supplied by the trusted service, never inferred from a save or caller metadata.
      const actorRole = data.actorRole === undefined ? 'unknown' : v.enumeration(data.actorRole, ACTOR_ROLES, 'actorRole');
      const validity = v.interval(data, previous);
      const placement = placementInput(data, previous);
      const at = stamp();
      const source = insertSource(scopeId, { content, kind: 'correction', actorRole, complete: true, lineageId: previous.source.lineageId ?? previous.sourceId }, at);
      const m = { ...previous, content, kind, ...validity, ...placement, source, sourceId: source.id, recordedAt: at, revision: previous.revision + 1 };
      insertMemory(m, mentions(previous));
      audit(scopeId, 'memory.revise', id, m.revision, reason, at);
      return m;
    },
    transitionMemory(input) {
      const data = v.objectInput(input, ['scopeId', 'id', 'expectedRevision', 'layer', 'importance', 'expiresAt', 'reason']);
      const scopeId = v.identifier(data.scopeId, 'scopeId');
      const id = v.identifier(data.id);
      const expected = v.integer(data.expectedRevision, 'expectedRevision', 1);
      const reason = v.text(data.reason, 'reason', 4000);
      const previous = required(revisionAt(db, 'memory', scopeId, id));
      changed(expected, previous.revision);
      if (previous.lifecycle === 'retired') fail('INVALID_TRANSITION');
      const placement = placementInput(data, previous);
      if (placement.layer === previous.layer && placement.importance === previous.importance && placement.expiresAt === previous.expiresAt) fail('INVALID_TRANSITION');
      const at = stamp();
      const m = { ...previous, ...placement, promotedFrom: placement.layer === previous.layer ? previous.promotedFrom : previous.layer, lifecycle: 'active', recordedAt: at, revision: previous.revision + 1 };
      insertMemory(m, mentions(previous));
      audit(scopeId, 'memory.transition', id, m.revision, reason, at);
      return m;
    },
    reinforceMemory(input) {
      const data = v.objectInput(input, ['scopeId', 'id', 'expectedRevision', 'layer', 'importance', 'expiresAt', 'source', 'reason']);
      const scopeId = v.identifier(data.scopeId, 'scopeId');
      const id = v.identifier(data.id);
      const expected = v.integer(data.expectedRevision, 'expectedRevision', 1);
      const previous = required(revisionAt(db, 'memory', scopeId, id));
      changed(expected, previous.revision);
      if (previous.lifecycle === 'retired') fail('INVALID_TRANSITION');
      const reason = data.reason === undefined ? 'Repeated supporting observation.' : v.text(data.reason, 'reason', 4000);
      const sourceData = sourceInput(data.source, previous.content);
      const placement = placementInput(data, previous);
      const at = stamp(), source = insertSource(scopeId, sourceData, at);
      const previousCount = Number.isSafeInteger(previous.metadata?.evidenceCount) && previous.metadata.evidenceCount > 0 ? previous.metadata.evidenceCount : 1;
      const evidenceCount = Math.min(1000000, previousCount + 1);
      const m = { ...previous, ...placement, promotedFrom: placement.layer === previous.layer ? previous.promotedFrom : previous.layer, lifecycle: 'active', epistemic: evidenceCount >= 2 ? 'supported' : previous.epistemic, source, sourceId: source.id, metadata: { ...previous.metadata, evidenceCount }, recordedAt: at, revision: previous.revision + 1 };
      insertMemory(m, mentions(previous));
      audit(scopeId, 'memory.reinforce', id, m.revision, reason, at);
      return m;
    },
    expireMemories(input) {
      const data = v.objectInput(input, ['scopeId', 'at', 'limit']);
      const scopeId = v.identifier(data.scopeId, 'scopeId');
      const cutoff = data.at === undefined ? v.timestamp(now(), 'now') : v.timestamp(data.at, 'at');
      const rows = latestRecords(db, 'memory', scopeId, { conditions: "r.lifecycle<>'retired' AND r.expires_at IS NOT NULL AND r.expires_at<=?", params: [cutoff], limit: v.limit(data.limit, 100, 200) });
      const expired = [];
      for (const previous of rows) {
        const at = stamp();
        const m = { ...previous, lifecycle: 'retired', recordedAt: at, revision: previous.revision + 1 };
        insertMemory(m, mentions(previous));
        audit(scopeId, 'memory.expire', m.id, m.revision, 'Retention period elapsed.', at);
        expired.push(m);
      }
      return expired;
    },
    retireMemory(input) {
      const data = v.objectInput(input, ['scopeId', 'id', 'expectedRevision', 'reason']);
      const scopeId = v.identifier(data.scopeId, 'scopeId');
      const id = v.identifier(data.id);
      const expected = v.integer(data.expectedRevision, 'expectedRevision', 1);
      const reason = v.text(data.reason, 'reason', 4000);
      const previous = required(revisionAt(db, 'memory', scopeId, id));
      changed(expected, previous.revision);
      if (previous.lifecycle === 'retired') fail('INVALID_TRANSITION');
      const at = stamp();
      const m = { ...previous, lifecycle: 'retired', recordedAt: at, revision: previous.revision + 1 };
      insertMemory(m, mentions(previous));
      audit(scopeId, 'memory.retire', id, m.revision, reason, at);
      return m;
    },
    versions(scopeId, id) {
      v.identifier(scopeId, 'scopeId'); v.identifier(id);
      return boundedResult(db.all('SELECT record_json FROM ctx_memory_revisions WHERE scope_id=? AND id=? ORDER BY revision LIMIT 1001', scopeId, id)).map(decode);
    },
    createEntity(input) {
      const data = v.objectInput(input, ['scopeId', 'name', 'type', 'aliases']);
      const scopeId = v.identifier(data.scopeId, 'scopeId');
      const name = v.displayName(data.name);
      const type = v.enumeration(data.type, ENTITY_TYPES, 'type');
      const aliases = v.aliases(data.aliases, name);
      const at = stamp();
      const e = { id: uid('entity'), revision: 1, scopeId, name, type, aliases, recordedAt: at };
      register(scopeId, e.id, 'entity');
      db.run('INSERT INTO ctx_entities(scope_id,id,type) VALUES (?,?,?)', scopeId, e.id, type);
      assignAliases(e);
      insertEntity(e);
      audit(scopeId, 'entity.create', e.id, 1, 'Explicit entity creation.', at);
      return e;
    },
    listEntities(input) {
      const data = v.objectInput(input, ['scopeId', 'query', 'limit']);
      const scopeId = v.identifier(data.scopeId, 'scopeId');
      const query = v.query(data.query);
      let conditions = 'NOT EXISTS(SELECT 1 FROM ctx_entity_redirects d WHERE d.scope_id=r.scope_id AND d.from_id=r.id)';
      const params = [];
      if (query) { conditions += ' AND EXISTS(SELECT 1 FROM ctx_entity_aliases a WHERE a.scope_id=r.scope_id AND a.entity_id=r.id AND instr(a.alias_key,?)>0)'; params.push(v.nameKey(query)); }
      return latestRecords(db, 'entity', scopeId, { conditions, params, limit: v.limit(data.limit) });
    },
    getEntity(scopeId, id) {
      v.identifier(scopeId, 'scopeId'); v.identifier(id);
      return resolveEntity(db, scopeId, id);
    },
    mergeEntities(input) {
      const data = v.objectInput(input, ['scopeId', 'keepId', 'mergeId', 'keepRevision', 'mergeRevision', 'reason']);
      const scopeId = v.identifier(data.scopeId, 'scopeId');
      const keepId = v.identifier(data.keepId, 'keepId');
      const mergeId = v.identifier(data.mergeId, 'mergeId');
      const keepRevision = v.integer(data.keepRevision, 'keepRevision', 1);
      const mergeRevision = v.integer(data.mergeRevision, 'mergeRevision', 1);
      const reason = v.text(data.reason, 'reason', 4000);
      const keep = required(resolveEntity(db, scopeId, keepId));
      const merge = required(resolveEntity(db, scopeId, mergeId));
      if (keep.id === merge.id || keep.id !== keepId || merge.id !== mergeId) fail('MERGE_CONFLICT');
      changed(keepRevision, keep.revision); changed(mergeRevision, merge.revision);
      if (keep.type !== merge.type) fail('TYPE_MISMATCH');
      const affected = boundedResult(latestRecords(db, 'relation', scopeId, { conditions: 'r.subject_id=? OR r.object_id=?', params: [mergeId, mergeId], limit: v.LIMITS.mergeRelations + 1 }), v.LIMITS.mergeRelations);
      const rewrites = affected.map(r => ({ ...r, subjectId: r.subjectId === mergeId ? keepId : r.subjectId, objectId: r.objectId === mergeId ? keepId : r.objectId }));
      if (rewrites.some(r => r.subjectId === r.objectId)) fail('MERGE_CONFLICT');
      const aliases = v.aliases([...keep.aliases, merge.name, ...merge.aliases], keep.name);
      const at = stamp();
      const result = { ...keep, aliases, revision: keep.revision + 1, recordedAt: at };
      assignAliases(result, [keepId, mergeId]);
      insertEntity(result);
      db.run('INSERT INTO ctx_entity_redirects(scope_id,from_id,to_id,recorded_at) VALUES (?,?,?,?)', scopeId, mergeId, keepId, at);
      for (const row of rewrites) {
        const r = { ...row, revision: row.revision + 1, recordedAt: at };
        insertRelation(r);
        audit(scopeId, 'relation.merge', r.id, r.revision, reason, at);
      }
      audit(scopeId, 'entity.merge', keepId, result.revision, reason, at);
      return result;
    },
    validateRelation(input) {
      try { checkedRelation(input); return { ok: true, errors: [] }; }
      catch (error) {
        if (!(error instanceof ContextError) || error.code.startsWith('STORE_')) throw error;
        return { ok: false, errors: [{ field: error.field ?? 'input', code: error.code, message: error.message }] };
      }
    },
    createRelation(input) {
      const data = checkedRelation(input);
      const at = stamp();
      const r = { id: uid('relation'), revision: 1, ...data, status: 'pending', recordedAt: at };
      register(r.scopeId, r.id, 'relation');
      db.run('INSERT INTO ctx_relations(scope_id,id) VALUES (?,?)', r.scopeId, r.id);
      insertRelation(r);
      audit(r.scopeId, 'relation.create', r.id, 1, 'Pending manual evidence review.', at);
      return r;
    },
    reviewRelation(input) {
      const data = v.objectInput(input, ['scopeId', 'id', 'expectedRevision', 'decision', 'reason']);
      const scopeId = v.identifier(data.scopeId, 'scopeId');
      const id = v.identifier(data.id);
      const expected = v.integer(data.expectedRevision, 'expectedRevision', 1);
      const decision = v.enumeration(data.decision, ['confirm', 'reject'], 'decision');
      const reason = v.text(data.reason, 'reason', 4000);
      const previous = required(revisionAt(db, 'relation', scopeId, id));
      changed(expected, previous.revision);
      // Reviews are not a toggle: a rejected relation is final (create a new
      // relation with new evidence), a confirmed relation may only be
      // retracted. This keeps the audit trail monotone (HOST-REVIEW M9).
      if (previous.status === 'rejected') fail('INVALID_TRANSITION');
      if (previous.status === 'confirmed' && decision === 'confirm') fail('INVALID_TRANSITION');
      if (decision === 'confirm') {
        if (!previous.sourceId || !previous.quote) fail('EVIDENCE_REQUIRED');
        const source = required(sourceAt(db, scopeId, previous.sourceId));
        if (!source.content.includes(previous.quote)) fail('INVALID_EVIDENCE', 'quote');
        const subject = required(resolveEntity(db, scopeId, previous.subjectId));
        const object = required(resolveEntity(db, scopeId, previous.objectId));
        const def = relationDefinition(previous.predicate);
        if (!def || !def.domain.includes(subject.type) || !def.range.includes(object.type) || subject.id === object.id) fail('INVALID_RELATION');
      }
      const at = stamp();
      const r = { ...previous, status: decision === 'confirm' ? 'confirmed' : 'rejected', revision: previous.revision + 1, recordedAt: at };
      insertRelation(r);
      audit(scopeId, 'relation.' + decision, id, r.revision, reason, at);
      return r;
    },
    listRelations(input) {
      const data = v.objectInput(input, ['scopeId', 'status', 'knownAt', 'validAt']);
      const scopeId = v.identifier(data.scopeId, 'scopeId');
      const conditions = data.status === undefined ? '1' : 'r.status=?';
      const params = data.status === undefined ? [] : [v.enumeration(data.status, RELATION_STATUSES, 'status')];
      return boundedResult(latestRecords(db, 'relation', scopeId, { ...v.timeFilter(data), conditions, params, limit: 1001 }));
    },
    listReviews(input) {
      const data = v.objectInput(input, ['scopeId']);
      return boundedResult(latestRecords(db, 'relation', v.identifier(data.scopeId, 'scopeId'), { conditions: "r.status='pending'", limit: 1001 }));
    },
    getSchema,
    graph(input) {
      const data = v.objectInput(input, ['scopeId', 'rootId', 'depth', 'includePending', 'limit', 'knownAt', 'validAt']);
      const scopeId = v.identifier(data.scopeId, 'scopeId');
      const rootId = data.rootId === undefined ? undefined : v.identifier(data.rootId, 'rootId');
      const depth = data.depth === undefined ? 2 : v.integer(data.depth, 'depth', 0, v.LIMITS.graphDepth);
      const includePending = data.includePending === undefined ? false : v.boolean(data.includePending, 'includePending');
      return projectGraph(db, { scopeId, rootId, depth, includePending, limit: v.limit(data.limit, 100, v.LIMITS.graph), observedAt: data.knownAt === undefined ? v.timestamp(now(), 'now') : data.knownAt, ...v.timeFilter(data) });
    },
    changes(input) {
      const data = v.objectInput(input, ['scopeId', 'limit']);
      return db.all('SELECT record_json FROM ctx_changes WHERE scope_id=? ORDER BY seq DESC LIMIT ?', v.identifier(data.scopeId, 'scopeId'), v.limit(data.limit)).map(decode);
    },
    recordUsage(input, options = {}) {
      const trustedLegacy = options !== null && typeof options === 'object' && options.trustedLegacy === true;
      const authorizedScopeIds = new Set(Array.isArray(options?.authorizedScopeIds) ? options.authorizedScopeIds : [input?.scopeId, GLOBAL_SCOPE_ID]);
      const data = v.objectInput(input, ['id', 'sessionId', 'scopeId', 'turn', 'step', 'phase', 'items', 'reason', 'at', 'messageId']);
      const id = v.identifier(data.id);
      const sessionId = v.identifier(data.sessionId, 'sessionId');
      const scopeId = v.identifier(data.scopeId, 'scopeId');
      v.enumeration(data.phase, ['planned'], 'phase');
      if (!Array.isArray(data.items) || data.items.length === 0 || data.items.length > v.LIMITS.items) fail('INVALID_INPUT', 'items');
      const seen = new Set();
      const items = data.items.map(value => {
        const item = v.objectInput(value, ['id', 'scopeId', 'revision', 'content', 'sourceId', 'kind', 'truncated', 'legacy'], 'items');
        v.identifier(item.id); v.integer(item.revision, 'revision', 1); v.text(item.content);
        const itemScopeId = item.scopeId === undefined ? scopeId : v.identifier(item.scopeId, 'scopeId');
        if (!authorizedScopeIds.has(itemScopeId)) fail('INVALID_REFERENCE');
        const itemKey = itemScopeId + '\0' + item.id;
        if (seen.has(itemKey)) fail('INVALID_INPUT', 'items');
        seen.add(itemKey);
        if (item.sourceId !== undefined) v.identifier(item.sourceId, 'sourceId');
        if (item.kind !== undefined) v.enumeration(item.kind, MEMORY_KINDS, 'kind');
        if (item.truncated !== undefined) v.boolean(item.truncated, 'truncated');
        if (item.legacy !== undefined) v.boolean(item.legacy, 'legacy');
        return itemScopeId === scopeId && item.scopeId === undefined ? item : { ...item, scopeId: itemScopeId };
      });
      const normalized = { id, sessionId, scopeId, phase: 'planned', items };
      if (data.messageId !== undefined) normalized.messageId = v.identifier(data.messageId, 'messageId');
      for (const key of ['turn', 'step']) if (data[key] !== undefined) normalized[key] = typeof data[key] === 'string' ? v.identifier(data[key], key) : v.integer(data[key], key);
      if (data.reason !== undefined) normalized.reason = v.text(data.reason, 'reason', 4000);
      // A caller-supplied time is an event time (Date.now domain). It is kept
      // apart from the sidecar's monotonic stamp so the two are never compared
      // (HOST usage-clock fix).
      if (data.at !== undefined) normalized.clientAt = v.timestamp(data.at);
      const fingerprint = hash(normalized);
      const replay = db.get('SELECT * FROM ctx_usage_records WHERE id=?', id);
      if (replay) {
        if (replay.payload_hash !== fingerprint) fail('IDEMPOTENCY_CONFLICT');
        return usageView(replay);
      }
      for (const item of items) {
        const m = knownMemory(item.scopeId ?? scopeId, item.id);
        const prefix = item.truncated === true ? item.content.endsWith(' …') ? item.content.slice(0, -2) : '' : undefined;
        if (item.truncated === true && !prefix?.trim()) fail('INVALID_REFERENCE');
        if (m && (m.lifecycle !== 'active' || m.revision !== item.revision || (item.sourceId !== undefined && item.sourceId !== m.sourceId) || (item.kind !== undefined && item.kind !== m.kind) || (prefix === undefined ? item.content !== m.content.trim() : !m.content.trim().startsWith(prefix)))) fail('INVALID_REFERENCE');
        if (!m && !(trustedLegacy && item.legacy === true)) fail('INVALID_REFERENCE');
      }
      const at = stamp();
      // record.at / event.at stay in the internal monotonic domain; the client
      // event time (when the caller supplied one) is preserved as clientAt.
      const result = { ...normalized, at };
      ensureScope(scopeId);
      db.run('INSERT INTO ctx_usage_records(id,session_id,scope_id,payload_hash,recorded_at,record_json) VALUES (?,?,?,?,?,?)', id, sessionId, scopeId, fingerprint, at, JSON.stringify(result));
      db.run('INSERT INTO ctx_usage_events(usage_id,revision,phase,event_seq,at) VALUES (?,1,?,NULL,?)', id, 'planned', at);
      audit(scopeId, 'usage.planned', id, 1, normalized.reason ?? 'Planned context, not committed or injected.', at, normalized.clientAt === undefined ? undefined : { clientAt: normalized.clientAt });
      if (normalized.clientAt !== undefined) usageClientAt.set(id, normalized.clientAt);
      return result;
    },
    findUsageByMessageId(input) {
      const data = v.objectInput(input, ['sessionId', 'messageId']);
      const sessionId = v.identifier(data.sessionId, 'sessionId');
      const messageId = v.identifier(data.messageId, 'messageId');
      const rows = boundedResult(db.all('SELECT * FROM ctx_usage_records WHERE session_id=? ORDER BY recorded_at DESC,id LIMIT 1001', sessionId));
      for (const row of rows) { const view = usageView(row); if (view.messageId === messageId) return view; }
      return undefined;
    },
    updateUsage(input) {
      const data = v.objectInput(input, ['id', 'phase', 'eventSeq', 'at']);
      const id = v.identifier(data.id);
      const phase = v.enumeration(data.phase, ['committed', 'requested', 'failed'], 'phase');
      const eventSeq = data.eventSeq === undefined ? undefined : v.integer(data.eventSeq, 'eventSeq');
      const requestedAt = data.at === undefined ? undefined : v.timestamp(data.at);
      const row = required(db.get('SELECT * FROM ctx_usage_records WHERE id=?', id));
      const previous = db.get('SELECT * FROM ctx_usage_events WHERE usage_id=? ORDER BY revision DESC LIMIT 1', id);
      // Ordering uses two same-domain signals only:
      //  - eventSeq: the host session event sequence (strictly monotonic per session);
      //  - client event time: compared exclusively with another client event time.
      // The sidecar's internal stamp() is never compared with Date.now() values.
      const previousClientAt = previousUsageClientAt(id, decode(row), row.scope_id);
      if (phase === previous.phase && (eventSeq === undefined || eventSeq === previous.event_seq) && (requestedAt === undefined || requestedAt === previousClientAt)) return usageView(row);
      const transitions = { planned: ['committed', 'failed'], committed: ['requested', 'failed'], requested: ['failed'], failed: [] };
      if (!transitions[previous.phase].includes(phase) || (eventSeq !== undefined && previous.event_seq !== null && eventSeq <= previous.event_seq) || (requestedAt !== undefined && previousClientAt !== undefined && requestedAt < previousClientAt)) fail('INVALID_TRANSITION');
      const at = stamp();
      const revision = previous.revision + 1;
      db.run('INSERT INTO ctx_usage_events(usage_id,revision,phase,event_seq,at) VALUES (?,?,?,?,?)', id, revision, phase, eventSeq ?? previous.event_seq, at);
      if (requestedAt !== undefined) usageClientAt.set(id, requestedAt);
      audit(row.scope_id, 'usage.' + phase, id, revision, 'Observed usage lifecycle event.', at, requestedAt === undefined ? undefined : { clientAt: requestedAt });
      return usageView(row);
    },
    listUsage(input) {
      const data = v.objectInput(input, ['sessionId', 'scopeId', 'limit']);
      const sessionId = v.identifier(data.sessionId, 'sessionId');
      const binds = [sessionId];
      let where = 'session_id=?';
      if (data.scopeId !== undefined) { where += ' AND scope_id=?'; binds.push(v.identifier(data.scopeId, 'scopeId')); }
      return db.all('SELECT * FROM ctx_usage_records WHERE ' + where + ' ORDER BY recorded_at DESC,id LIMIT ?', ...binds, v.limit(data.limit)).map(usageView);
    },
    setUsagePolicy(input) {
      const data = v.objectInput(input, ['sessionId', 'scopeId', 'memoryId', 'mode', 'paused', 'expectedRevision']);
      const sessionId = v.identifier(data.sessionId, 'sessionId');
      const scopeId = v.identifier(data.scopeId, 'scopeId');
      const memoryId = data.memoryId === undefined ? undefined : v.identifier(data.memoryId, 'memoryId');
      const mode = data.mode === undefined ? 'normal' : v.enumeration(data.mode, ['exclude', 'prefer', 'normal'], 'mode');
      if (data.mode !== undefined && memoryId === undefined) fail('INVALID_INPUT', 'memoryId');
      const previous = policy(sessionId);
      if (data.expectedRevision !== undefined) changed(v.integer(data.expectedRevision, 'expectedRevision'), previous.revision);
      const paused = data.paused === undefined ? previous.paused : v.boolean(data.paused, 'paused');
      const sameScope = previous.scopeId === scopeId;
      const excludedIds = new Set(sameScope ? previous.excludedIds : []);
      const preferredIds = new Set(sameScope ? previous.preferredIds : []);
      if (memoryId !== undefined) {
        const m = knownMemory(scopeId, memoryId);
        if (m && mode === 'prefer' && m.lifecycle !== 'active') fail('INVALID_REFERENCE');
        excludedIds.delete(memoryId); preferredIds.delete(memoryId);
        if (mode === 'exclude') excludedIds.add(memoryId);
        if (mode === 'prefer') preferredIds.add(memoryId);
      }
      if (excludedIds.size + preferredIds.size > v.LIMITS.items) fail('LIMIT_EXCEEDED');
      const at = stamp();
      const result = { revision: previous.revision + 1, scopeId, paused, excludedIds: [...excludedIds].sort(), preferredIds: [...preferredIds].sort() };
      ensureScope(scopeId);
      db.run('INSERT INTO ctx_policy_revisions(session_id,revision,scope_id,recorded_at,record_json) VALUES (?,?,?,?,?)', sessionId, result.revision, scopeId, at, JSON.stringify(result));
      audit(scopeId, 'policy.update', sessionId, result.revision, 'Explicit session usage policy update.', at);
      return result;
    },
    getUsagePolicy(sessionId) { return policy(v.identifier(sessionId, 'sessionId')); },
  };

  const writes = new Set(['saveMemory', 'importLegacy', 'reviseMemory', 'transitionMemory', 'reinforceMemory', 'expireMemories', 'retireMemory', 'createEntity', 'mergeEntities', 'createRelation', 'reviewRelation', 'recordUsage', 'updateUsage', 'setUsagePolicy']);
  const api = {};
  for (const [name, method] of Object.entries(methods)) api[name] = (...args) => {
    db.check();
    try { return writes.has(name) ? db.transaction(() => method(...args)) : db.readTransaction(() => method(...args)); }
    catch (error) { throw safeError(error); }
  };
  api.close = () => db.close();
  return Object.freeze(api);
}
