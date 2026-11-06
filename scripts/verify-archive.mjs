/**
 * Release archive gate: inspects the `npm pack` tarball itself.
 *
 * Verifies the archive name/identity, that only published files ride along,
 * that the optional-peer manifest model survives packing, and that the two
 * built halves carry the public gateway allowlist without any
 * deployment-specific markers.
 */
import { gunzipSync } from 'node:zlib';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const artifacts = path.join(root, 'artifacts');
const stem = pkg.name.replace(/^@/u, '').replaceAll('/', '-');
const expected = stem + '-' + pkg.version + '.tgz';
const archives = (await readdir(artifacts).catch(() => [])).filter(name => name.startsWith(stem + '-') && name.endsWith('.tgz'));
const errors = [];
const fail = (reason) => errors.push(reason);

if (!archives.includes(expected)) fail('archive-missing:' + expected);
let bytes = Buffer.alloc(0);
if (archives.includes(expected)) {
  try { bytes = gunzipSync(await readFile(path.join(artifacts, expected))); }
  catch { fail('archive-unreadable'); }
}
const entries = new Map();
for (let offset = 0; offset + 512 <= bytes.length;) {
  const header = bytes.subarray(offset, offset + 512);
  if (header.every(value => value === 0)) break;
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
  const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim() || '0', 8);
  const start = offset + 512;
  entries.set(name, bytes.subarray(start, start + size));
  offset = start + Math.ceil(size / 512) * 512;
}
const textOf = (name) => entries.get(name)?.toString('utf8') ?? '';

// --- entries / manifest ---------------------------------------------------
const publishedFiles = (pkg.files ?? []).filter(entry => !entry.includes('*'));
const required = ['package/package.json', ...publishedFiles.map(entry => 'package/' + entry)];
for (const name of required) if (!entries.has(name)) fail('missing:' + name);
for (const name of entries.keys()) {
  if (/^package\/(?:src|src-client|tests|scripts|artifacts|node_modules)\//u.test(name)) fail('ships-source:' + name);
  if (name.endsWith('.map')) fail('ships-sourcemap:' + name);
  if (name.includes('prototype/') && !publishedFiles.some(entry => 'package/' + entry === name)) fail('ships-unlisted:' + name);
}

let archived = {};
try { archived = JSON.parse(textOf('package/package.json')); } catch { fail('package-json-invalid'); }
if (archived.name !== pkg.name || archived.version !== pkg.version) fail('identity-mismatch');
if (archived.license !== 'MIT') fail('package-license');
if (archived.dsh?.bundle?.patch !== './cordis.patch.yml') fail('bundle-patch');
if (archived.dsh?.client?.platform !== 'web') fail('client-platform');
for (const [name, range] of Object.entries(archived.peerDependencies ?? {})) {
  if (String(range).startsWith('workspace:')) fail('workspace-peer:' + name);
}
if (archived.peerDependencies?.['@deepseek-ai/cordis'] !== '^4.0.5') fail('cordis-peer-range');
if (archived.peerDependencies?.['@deepseek-ai/dsh-tools'] !== '^0.2.1-rc.5') fail('dsh-tools-peer-range');
for (const name of ['officeparser', '@melandlabs/opencontext']) {
  if (archived.peerDependencies?.[name] === undefined) fail('missing-optional-peer:' + name);
  if (archived.peerDependenciesMeta?.[name]?.optional !== true) fail('optional-peer-not-marked:' + name);
  if (archived.dependencies?.[name] !== undefined) fail('optional-peer-in-dependencies:' + name);
}
for (const name of ['@melandlabs/env-config', 'better-sqlite3', 'sqlite-vec']) {
  if (archived.dependencies?.[name] === undefined) fail('missing-runtime-dependency:' + name);
}
if (archived.dependencies?.three !== undefined || archived.devDependencies?.three === undefined) fail('three-must-be-build-only');
const exportsMap = archived.exports ?? {};
for (const [subpath, value] of Object.entries(exportsMap)) {
  const target = typeof value === 'string' ? value : value?.default;
  if (typeof target !== 'string' || !entries.has('package/' + target.replace(/^\.\//u, ''))) fail('missing-export:' + subpath);
}
if (typeof archived.types === 'string' && !entries.has('package/' + archived.types.replace(/^\.\//u, ''))) fail('advertised-types-missing');

// --- built halves ---------------------------------------------------------
const host = textOf('package/lib/index.js');
const client = textOf('package/lib/client.js');
if (!host.includes('dsh-agentos-context')) fail('host-name');
if (!client.includes('id: "' + pkg.name + '"')) fail('client-module-id');
if (!client.includes('dsh-opencontext') || !client.includes('agentos-context/v1/')) fail('compat-identifiers');
if (!host.includes('memory_search') || !host.includes('oc_search')) fail('memory-tools');
if (!host.includes('import("officeparser/slim")')) fail('document-parser-runtime-dependency');
if (!host.includes('OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES') || !host.includes('UNTRUSTED_GATEWAY')) fail('gateway-policy-missing');
if (!client.includes('data-context-point-cloud') || !client.includes('WebGLRenderer')) fail('graph-3d-bundle');
if (!client.includes('pluginUsers')) fail('css-lifecycle');

// --- deployment leak scan -------------------------------------------------
const LEAKS = [
  [/\b168\.63\.\d+\.\d+\b/u, 'deployment-ip'],
  [/htsc/iu, 'deployment-vendor'],
  [/022296/u, 'employee-id'],
  [/research[\\/]installed/u, 'internal-checkout-path'],
  [/C:\\\\Users\\\\/u, 'internal-windows-path'],
  [/\/Users\/[A-Za-z]/u, 'build-machine-path'],
  [/HTSCAI?_API_KEY/u, 'deployment-credential-ref'],
];
const scanned = ['package/lib/index.js', 'package/lib/client.js', 'package/cordis.patch.yml', 'package/package.json'];
for (const name of ['package/README.md', 'package/README.zh.md', 'package/docs/CONTRACT.md', 'package/docs/IMPLEMENTATION-STATUS.md', 'package/prototype/index.html']) {
  if (entries.has(name)) scanned.push(name);
}
for (const name of scanned) {
  const text = textOf(name);
  for (const [pattern, label] of LEAKS) if (pattern.test(text)) fail('leak:' + label + ':' + name);
}
for (const name of ['package/lib/index.js', 'package/lib/client.js']) {
  if (/https?:\/\/[^"']*llm-service/u.test(textOf(name))) fail('hardcoded-gateway:' + name);
}

const report = {
  ok: errors.length === 0,
  archive: path.join(artifacts, expected),
  version: pkg.version,
  entries: entries.size,
  megabytes: Number((bytes.length / 1024 / 1024).toFixed(2)),
  errors,
};
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
