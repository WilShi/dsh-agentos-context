import { fail } from './errors.js';
import { LIMITS, MAX_TIME, validAt } from './validation.js';

const TABLES = Object.freeze({ memory: 'ctx_memory_revisions', entity: 'ctx_entity_revisions', relation: 'ctx_relation_revisions' });
export const decode = row => {
  if (!row) return undefined;
  const record = JSON.parse(row.record_json);
  // Schema-v1 records are immutable audit snapshots.  Hydrate the new
  // hierarchy fields at the read boundary instead of rewriting history.
  if (record && typeof record === 'object' && typeof record.content === 'string' && typeof record.lifecycle === 'string' && typeof record.epistemic === 'string') {
    if (record.layer === undefined) record.layer = 'semantic';
    if (record.importance === undefined) record.importance = 0.5;
    if (record.expiresAt === undefined) record.expiresAt = null;
    if (record.promotedFrom === undefined) record.promotedFrom = null;
  }
  return record;
};
function tableFor(kind) { if (!Object.hasOwn(TABLES, kind)) fail('STORE_FAILURE'); return TABLES[kind]; }

export function revisionAt(db, kind, scopeId, id, knownAt = MAX_TIME) {
  const table = tableFor(kind);
  return decode(db.get('SELECT record_json FROM ' + table + ' WHERE scope_id=? AND id=? AND recorded_at<=? ORDER BY revision DESC LIMIT 1', scopeId, id, knownAt));
}

/** Conditions and table names are internal constants, never caller-provided SQL. */
export function latestRecords(db, kind, scopeId, { knownAt = MAX_TIME, validAt: at, conditions = '1', params = [], limit = 100, order = 'r.recorded_at DESC, r.id', orderParams = [] } = {}) {
  const table = tableFor(kind);
  let sql = 'SELECT r.record_json FROM ' + table + ' r WHERE r.scope_id=? AND r.revision=(SELECT max(v.revision) FROM ' + table + ' v WHERE v.scope_id=r.scope_id AND v.id=r.id AND v.recorded_at<=?) AND (' + conditions + ')';
  const binds = [scopeId, knownAt, ...params];
  if (at !== undefined && kind !== 'entity') {
    sql += ' AND r.valid_from IS NOT NULL AND r.valid_from<=? AND (r.valid_to IS NULL OR ?<r.valid_to)';
    binds.push(at, at);
  }
  sql += ' ORDER BY ' + order + ' LIMIT ?';
  return db.all(sql, ...binds, ...orderParams, limit).map(decode);
}

export function resolveEntity(db, scopeId, id, knownAt = MAX_TIME) {
  const visited = new Set();
  let current = id;
  for (let steps = 0; steps < 1024; steps++) {
    if (visited.has(current)) fail('MERGE_CONFLICT');
    visited.add(current);
    const next = db.get('SELECT to_id FROM ctx_entity_redirects WHERE scope_id=? AND from_id=? AND recorded_at<=?', scopeId, current, knownAt);
    if (!next) return revisionAt(db, 'entity', scopeId, current, knownAt);
    current = next.to_id;
  }
  fail('LIMIT_EXCEEDED');
}

export function sourceAt(db, scopeId, id, knownAt = MAX_TIME) {
  return decode(db.get('SELECT record_json FROM ctx_sources WHERE scope_id=? AND id=? AND recorded_at<=?', scopeId, id, knownAt));
}

function shorten(value) {
  if (value.length <= 140) return value;
  let prefix = value.slice(0, 137);
  if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix + ' …';
}
function nodeOf(kind, record) {
  return { id: record.id, type: kind, subtype: kind === 'entity' ? record.type : record.kind,
    label: kind === 'entity' ? record.name : shorten(record.content), timestamp: record.recordedAt,
    ...(kind === 'memory' ? { status: record.lifecycle, layer: record.layer ?? 'semantic', importance: record.importance ?? 0.5 } : {}), scopeId: record.scopeId };
}
const memorySourceEdge = m => ({ id: 'source:' + m.id + ':' + m.sourceId, source: m.id, target: m.sourceId, type: 'source', sourceId: m.sourceId });
const mentionEdge = (m, e) => ({ id: 'mentions:' + m.id + ':' + e.id, source: m.id, target: e.id, type: 'mentions' });
function relationEdges(r) {
  const evidence = { status: r.status, relationId: r.id, ...(r.sourceId ? { sourceId: r.sourceId, quote: r.quote } : {}) };
  const result = [{ id: r.id, source: r.subjectId, target: r.objectId, type: r.predicate, ...evidence }];
  if (r.sourceId && r.quote) for (const endpoint of [r.subjectId, r.objectId]) {
    result.push({ id: 'source:' + r.id + ':' + endpoint, source: endpoint, target: r.sourceId, type: 'source', ...evidence });
  }
  return result;
}

/** Bounded SQL neighborhoods plus a visited breadth-first projection. No inferred facts. */
export function projectGraph(db, { scopeId, rootId, depth = 2, includePending = false, limit = 100, knownAt = MAX_TIME, validAt: at, observedAt = Date.now() }) {
  const nodeCache = new Map();
  const recordCache = new Map();
  let truncated = false;
  const cap = LIMITS.graphEdges;
  const recordOptions = { knownAt, validAt: at, limit: cap + 1 };
  const relationStatus = includePending ? "r.status IN ('confirmed','pending')" : "r.status='confirmed'";
  const visible = m => m && m.lifecycle !== 'retired' && (m.expiresAt === null || m.expiresAt === undefined || m.expiresAt > observedAt) && validAt(m, at);
  const bounded = rows => { if (rows.length > cap) { truncated = true; return rows.slice(0, cap); } return rows; };
  function loadNode(id) {
    if (nodeCache.has(id)) return nodeCache.get(id);
    const object = db.get('SELECT kind FROM ctx_objects WHERE scope_id=? AND id=?', scopeId, id);
    let record;
    if (object?.kind === 'entity') record = resolveEntity(db, scopeId, id, knownAt);
    else if (object?.kind === 'memory') {
      const m = revisionAt(db, 'memory', scopeId, id, knownAt);
      if (visible(m)) record = m;
    } else if (object?.kind === 'source') record = sourceAt(db, scopeId, id, knownAt);
    const node = record ? nodeOf(object.kind, record) : undefined;
    nodeCache.set(id, node);
    if (record) { nodeCache.set(record.id, node); recordCache.set(record.id, record); }
    return node;
  }
  function neighborhoods(node) {
    const record = recordCache.get(node.id);
    let edges = [];
    if (node.type === 'memory') {
      edges.push(memorySourceEdge(record));
      const links = db.all('SELECT entity_id FROM ctx_memory_mentions WHERE scope_id=? AND memory_id=? AND revision=? ORDER BY entity_id LIMIT ?', scopeId, record.id, record.revision, LIMITS.mentions + 1);
      if (links.length > LIMITS.mentions) truncated = true;
      for (const link of links.slice(0, LIMITS.mentions)) {
        const target = resolveEntity(db, scopeId, link.entity_id, knownAt);
        if (target) edges.push(mentionEdge(record, target));
      }
    } else if (node.type === 'entity') {
      const relations = bounded(latestRecords(db, 'relation', scopeId, { ...recordOptions, conditions: relationStatus + ' AND (r.subject_id=? OR r.object_id=?)', params: [node.id, node.id] }));
      for (const r of relations) edges.push(...relationEdges(r));
      const family = db.all(`WITH RECURSIVE family(id) AS (
        SELECT ? UNION SELECT d.from_id FROM ctx_entity_redirects d JOIN family f ON d.to_id=f.id
        WHERE d.scope_id=? AND d.recorded_at<=? LIMIT 257
      ) SELECT id FROM family`, node.id, scopeId, knownAt);
      if (family.length > 256) truncated = true;
      const ids = family.slice(0, 256).map(x => x.id);
      const conditions = "r.lifecycle<>'retired' AND EXISTS(SELECT 1 FROM ctx_memory_mentions m WHERE m.scope_id=r.scope_id AND m.memory_id=r.id AND m.revision=r.revision AND m.entity_id IN (" + ids.map(() => '?').join(',') + '))';
      const memories = bounded(latestRecords(db, 'memory', scopeId, { ...recordOptions, conditions, params: ids }));
      for (const m of memories) edges.push(mentionEdge(m, record));
    } else if (node.type === 'source') {
      const memories = bounded(latestRecords(db, 'memory', scopeId, { ...recordOptions, conditions: "r.lifecycle<>'retired' AND r.source_id=?", params: [node.id] }));
      edges.push(...memories.map(memorySourceEdge));
      const relations = bounded(latestRecords(db, 'relation', scopeId, { ...recordOptions, conditions: relationStatus + ' AND r.source_id=?', params: [node.id] }));
      for (const r of relations) edges.push(...relationEdges(r));
    }
    // Only incident edges belong to this neighborhood; other evidence endpoints
    // are discovered from their own nodes, never emitted as dangling shortcuts.
    return edges.filter(e => e.source === node.id || e.target === node.id);
  }
  const selected = new Map();
  const queue = [];
  const candidates = new Map();
  function select(node, distance) {
    if (!node || selected.has(node.id)) return;
    if (selected.size === limit) { truncated = true; return; }
    selected.set(node.id, node);
    queue.push({ node, distance });
  }
  if (rootId !== undefined) select(loadNode(rootId), 0);
  else {
    const entities = latestRecords(db, 'entity', scopeId, { knownAt, limit: limit + 1, conditions: 'NOT EXISTS(SELECT 1 FROM ctx_entity_redirects d WHERE d.scope_id=r.scope_id AND d.from_id=r.id AND d.recorded_at<=?)', params: [knownAt], order: 'r.id' });
    const memories = latestRecords(db, 'memory', scopeId, { ...recordOptions, limit: limit + 1, conditions: "r.lifecycle<>'retired'", order: 'r.id' });
    const seeds = [...entities, ...memories];
    if (seeds.length > limit) truncated = true;
    for (const r of seeds.slice(0, limit)) select(loadNode(r.id), 0);
  }
  for (let index = 0; index < queue.length; index++) {
    const { node, distance } = queue[index];
    for (const edge of neighborhoods(node)) {
      if (!candidates.has(edge.id)) {
        if (candidates.size >= cap) { truncated = true; continue; }
        candidates.set(edge.id, edge);
      }
      const otherId = edge.source === node.id ? edge.target : edge.source;
      const other = loadNode(otherId);
      if (!other) continue;
      if (distance < depth) select(other, distance + 1);
      else if (!selected.has(other.id)) truncated = true;
    }
  }
  const nodes = [...selected.values()];
  const edges = [...candidates.values()].filter(e => selected.has(e.source) && selected.has(e.target));
  return { nodes, edges, stats: { nodeCount: nodes.length, edgeCount: edges.length, truncated } };
}
