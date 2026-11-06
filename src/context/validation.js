import { fail } from './errors.js';

export const MAX_TIME = 8640000000000000;
export const LIMITS = Object.freeze({ content: 65536, metadata: 16384, input: 262144, items: 200, aliases: 50, mentions: 100, list: 500, graph: 2000, graphDepth: 4, graphEdges: 12000, mergeRelations: 1000 });
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const plain = value => value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Inspect descriptors before reading values: hostile accessors never execute. */
function copyJson(value, state, depth = 0, key = '') {
  if (++state.nodes > 4096 || depth > 12) fail('INVALID_INPUT', 'input');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_INPUT', 'input');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > LIMITS.content || !value.isWellFormed() || value.includes('\u0000')) fail('INVALID_INPUT', 'input');
    state.bytes += Buffer.byteLength(value, 'utf8');
    if (state.bytes > LIMITS.input || Buffer.byteLength(value, 'utf8') > LIMITS.content) fail('INVALID_INPUT', 'input');
    return value;
  }
  if (typeof value !== 'object' || state.seen.has(value)) fail('INVALID_INPUT', 'input');
  state.seen.add(value);
  const array = Array.isArray(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : !plain(value)) fail('INVALID_INPUT', 'input');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 257 || keys.some(k => typeof k !== 'string')) fail('INVALID_INPUT', 'input');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (array) {
    if (value.length > 256 || keys.length !== value.length + 1) fail('INVALID_INPUT', 'input');
    const result = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = descriptors[i];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('INVALID_INPUT', 'input');
      result.push(copyJson(descriptor.value, state, depth + 1, key));
    }
    state.seen.delete(value);
    return result;
  }
  const result = {};
  for (const name of keys) {
    const descriptor = descriptors[name];
    if (FORBIDDEN_KEYS.has(name) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INVALID_INPUT', 'input');
    copyJson(name, state, depth + 1);
    result[name] = copyJson(descriptor.value, state, depth + 1, name);
  }
  state.seen.delete(value);
  return result;
}
export function json(value) { return copyJson(value, { seen: new Set(), nodes: 0, bytes: 0 }); }

export function objectInput(value, allowed, field = 'input') {
  if (!plain(value)) fail('INVALID_INPUT', field);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 256 || keys.some(key => typeof key !== 'string' || !allowed.includes(key))) fail('INVALID_INPUT', field);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy = {};
  for (const key of keys) {
    const d = descriptors[key];
    if (FORBIDDEN_KEYS.has(key) || !d.enumerable || !Object.hasOwn(d, 'value')) fail('INVALID_INPUT', field);
    // Undefined optional arguments are equivalent to omitted arguments; nested JSON is strict.
    if (d.value !== undefined) copy[key] = d.value;
  }
  return json(copy);
}
export function identifier(value, field = 'id') {
  if (typeof value !== 'string' || !value.length || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value) || FORBIDDEN_KEYS.has(value) || !value.isWellFormed()) fail('INVALID_INPUT', field);
  return value;
}
/** Graph node reference (rootId): identifier plus the charset real node ids use. */
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
export function nodeId(value, field = 'rootId') {
  const id = identifier(value, field);
  // Prose such as "not a valid id!!" is a caller mistake, not an empty graph.
  if (!NODE_ID_PATTERN.test(id)) fail('INVALID_INPUT', field);
  return id;
}
export function text(value, field = 'content', maxBytes = LIMITS.content) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxBytes || Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\u0000') || !value.isWellFormed()) fail('INVALID_INPUT', field);
  return value;
}
export function enumeration(value, values, field) {
  if (!values.includes(value)) fail('INVALID_INPUT', field);
  return value;
}
export function integer(value, field, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INPUT', field);
  return value;
}
export function finiteNumber(value, field, min = -Number.MAX_VALUE, max = Number.MAX_VALUE) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail('INVALID_INPUT', field);
  return value;
}
export function timestamp(value, field = 'at') { return integer(value, field, 0, MAX_TIME); }
export function boolean(value, field) {
  if (typeof value !== 'boolean') fail('INVALID_INPUT', field);
  return value;
}
export function interval(input, previous = {}) {
  const validFrom = Object.hasOwn(input, 'validFrom') ? input.validFrom : previous.validFrom ?? null;
  const validTo = Object.hasOwn(input, 'validTo') ? input.validTo : previous.validTo ?? null;
  if (validFrom !== null) timestamp(validFrom, 'validFrom');
  if (validTo !== null) timestamp(validTo, 'validTo');
  if (validTo !== null && (validFrom === null || validTo <= validFrom)) fail('INVALID_INPUT', 'validTo');
  return { validFrom, validTo };
}
export function timeFilter(input) {
  const result = {};
  if (input.knownAt !== undefined) result.knownAt = timestamp(input.knownAt, 'knownAt');
  if (input.validAt !== undefined) result.validAt = timestamp(input.validAt, 'validAt');
  return result;
}
export function validAt(record, at) {
  return at === undefined || (record.validFrom !== null && record.validFrom <= at && (record.validTo === null || at < record.validTo));
}
export function limit(value, fallback = 100, max = LIMITS.list) { return value === undefined ? fallback : integer(value, 'limit', 1, max); }
export function query(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1000 || value.includes('\u0000')) fail('INVALID_INPUT', 'query');
  return value.trim();
}
export function metadata(value) {
  if (value === undefined) return {};
  if (!plain(value)) fail('INVALID_INPUT', 'metadata');
  const result = json(value);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > LIMITS.metadata) fail('INVALID_INPUT', 'metadata');
  return result;
}
export function ids(value, field = 'entityIds', max = LIMITS.mentions) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) fail('INVALID_INPUT', field);
  return [...new Set(value.map(x => identifier(x, field)))];
}
export function displayName(value) { return text(value, 'name', 300).normalize('NFKC').trim().replace(/\s+/gu, ' '); }
export function nameKey(value) { return displayName(value).toLowerCase(); }
export function aliases(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIMITS.aliases) fail('INVALID_INPUT', 'aliases');
  const seen = new Set([nameKey(name)]);
  const result = [];
  for (const alias of value) {
    const label = displayName(alias);
    const key = nameKey(label);
    if (!seen.has(key)) { seen.add(key); result.push(label); }
  }
  return result;
}
/** Stable JSON for idempotency; all callers pass already-validated plain JSON. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
