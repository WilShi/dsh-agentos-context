/**
 * Published-package gate (public, @wilshi scope).
 *
 * Checks the manifest model (peers vs optional peers vs code-owned runtime
 * dependencies), the shipped entrypoints and the two built halves: no
 * deployment-specific gateway/host markers may leak, and the documented public
 * gateway allowlist marker must survive the build.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const errors = [];
const fail = (reason) => errors.push(reason);
const isFile = async (rel) => {
  try { return (await stat(path.join(root, rel))).isFile(); } catch { return false; }
};

const EXPECTED_NAME = '@wilshi/dsh-agentos-context';
const REQUIRED_HOST_PEERS = {
  '@deepseek-ai/cordis': '^4.0.5',
  '@deepseek-ai/dsh-tools': '^0.2.1-rc.5',
  '@deepseek-ai/schemastery': '^3.18.5',
};
const OPTIONAL_PEERS = ['officeparser', '@melandlabs/opencontext'];
const RUNTIME_DEPENDENCIES = ['@melandlabs/env-config', 'better-sqlite3', 'sqlite-vec'];
const PUBLISHED = [
  'lib/index.js',
  'lib/client.js',
  'cordis.patch.yml',
  'README.md',
  'README.zh.md',
  'LICENSE',
  'LICENSE.opencontext',
  'THIRD_PARTY_NOTICES.md',
  'prototype/index.html',
  'prototype/PROTOTYPE.md',
  'docs/CONTRACT.md',
  'docs/IMPLEMENTATION-STATUS.md',
];

// --- identity / manifest ---------------------------------------------------
if (pkg.name !== EXPECTED_NAME) fail('package-name:' + pkg.name);
if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(pkg.version)) fail('package-version');
if (pkg.license !== 'MIT') fail('package-license');
if (pkg.publishConfig?.access !== 'public') fail('publish-access');
if (pkg.type !== 'module') fail('package-type');
if (typeof pkg.engines?.node !== 'string' || pkg.engines.node.length === 0) fail('missing-engines-node');
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('bundle-patch');
if (pkg.dsh?.client?.platform !== 'web') fail('client-platform');
for (const dependency of pkg.dsh?.client?.inject ?? []) {
  if (!dependency.startsWith('@deepseek-ai/')) fail('unexpected-client-inject:' + dependency);
}
if (!(pkg.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-client-ui-settings')) fail('missing-client-inject-settings');

// --- entrypoints ----------------------------------------------------------
if (pkg.main !== 'lib/index.js') fail('main-entry:' + String(pkg.main));
const exportsMap = pkg.exports ?? {};
const exportTargets = [];
for (const [subpath, value] of Object.entries(exportsMap)) {
  const target = typeof value === 'string' ? value : value?.default;
  if (typeof target !== 'string' || !target.startsWith('./')) { fail('export-target:' + subpath); continue; }
  exportTargets.push(target.replace(/^\.\//u, ''));
  if (!(await isFile(target.replace(/^\.\//u, '')))) fail('missing-export:' + subpath + ':' + target);
}
if (!exportTargets.includes('lib/client.js')) fail('missing-client-export');
if (typeof pkg.types === 'string' && !(await isFile(pkg.types))) fail('advertised-types-missing:' + pkg.types);
for (const declared of Object.values(pkg.exports ?? {})) {
  if (typeof declared === 'object' && declared !== null && typeof declared.types === 'string' && !(await isFile(declared.types.replace(/^\.\//u, '')))) fail('advertised-types-missing:' + declared.types);
}

// --- peer / optional-peer / runtime-dependency model ----------------------
for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
  if (String(range).startsWith('workspace:')) fail('workspace-peer:' + name);
  if (String(range).startsWith('link:') || String(range).startsWith('file:')) fail('local-peer:' + name);
}
for (const [name, range] of Object.entries(REQUIRED_HOST_PEERS)) {
  if (pkg.peerDependencies?.[name] !== range) fail('host-peer-range:' + name + ':' + String(pkg.peerDependencies?.[name]));
}
for (const name of OPTIONAL_PEERS) {
  if (pkg.peerDependencies?.[name] === undefined) fail('missing-optional-peer:' + name);
  if (pkg.peerDependenciesMeta?.[name]?.optional !== true) fail('optional-peer-not-marked:' + name);
}
for (const name of RUNTIME_DEPENDENCIES) {
  if (pkg.dependencies?.[name] === undefined) fail('missing-runtime-dependency:' + name);
}
for (const name of OPTIONAL_PEERS) {
  if (pkg.dependencies?.[name] !== undefined) fail('optional-peer-in-dependencies:' + name);
}
for (const name of ['three', 'tsdown', 'lightningcss', 'typescript', 'vitest']) {
  if (pkg.dependencies?.[name] !== undefined) fail('build-tool-in-dependencies:' + name);
}
for (const name of ['tsdown', 'lightningcss', 'typescript', 'vitest', '@types/node']) {
  if (pkg.devDependencies?.[name] === undefined) fail('missing-dev-dependency:' + name);
}

// --- files whitelist ------------------------------------------------------
const files = pkg.files ?? [];
for (const entry of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
  if (!files.includes(entry)) fail('files-missing:' + entry);
}
for (const entry of files) {
  if (/^(?:src|src-client|tests|scripts|artifacts)(?:\/|$)/u.test(entry)) fail('files-ships-source:' + entry);
  if ((entry.endsWith('.js.map') || entry.endsWith('.d.ts')) && !(await isFile(entry.replace(/\*\*?/gu, '').replace(/\/$/u, '')))) {
    // glob entries are allowed only when they resolve to real files
    if (!entry.includes('*')) fail('files-missing:' + entry);
  }
}
for (const entry of PUBLISHED) {
  if (!(await isFile(entry))) fail('missing-published-file:' + entry);
}

// --- built artifacts ------------------------------------------------------
const readBuilt = async (file) => (await isFile(file)) ? await readFile(path.join(root, file), 'utf8') : '';
const host = await readBuilt('lib/index.js');
const client = await readBuilt('lib/client.js');
if (!host.includes('dsh-agentos-context')) fail('host-name');
if (!client.includes('id: "' + EXPECTED_NAME + '"')) fail('client-module-id');
if (!host.includes('agentos-context/v1/') || !client.includes('agentos-context/v1/')) fail('versioned-rpc');
if (!client.includes('agentOS context')) fail('display-name');
if (!client.includes('dsh-opencontext')) fail('compat-namespace');
if (!client.includes('settings.section') || !client.includes('conversation.view')) fail('client-slots');
if (!client.includes('WebGLRenderer') || !client.includes('data-context-point-cloud')) fail('graph-3d-bundle');
if (!host.includes('memory_search') || !host.includes('memory_save') || !host.includes('oc_search')) fail('memory-tools');
if (!host.includes('recallScopeIds') || !client.includes('recallOrder')) fail('entity-scoped-memory');
if (!host.includes('communityEdges') || !client.includes('communityEdges')) fail('graph-communities');
if (host.includes('/opencontext-api/verify-key') || host.includes('dsh-opencontext-api-routes')) fail('raw-web-routes');
if (client.includes('/opencontext-api/')) fail('client-http-transport');
if (!host.includes('import("officeparser/slim")') || host.includes('cdn.jsdelivr.net/npm/tesseract')) fail('document-parser-runtime-dependency');
if (!host.includes('OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES')) fail('gateway-allowlist-marker');
if (!host.includes('UNTRUSTED_GATEWAY') || !host.includes('assertTrustedGatewayBase')) fail('gateway-policy-missing');
if (!client.includes('pluginUsers')) fail('css-lifecycle');

const patch = await readFile(path.join(root, 'cordis.patch.yml'), 'utf8');
if (!/id:\s*dsh-opencontext\s+name:\s*['"]@wilshi\/dsh-agentos-context['"]/u.test(patch)) fail('compat-loader-row');
if (/id:\s*agentos-context\b/u.test(patch)) fail('duplicate-loader-row');

// --- leak scan ------------------------------------------------------------
const LEAKS = [
  [/\b168\.63\.\d+\.\d+\b/u, 'deployment-ip'],
  [/htsc/iu, 'deployment-vendor'],
  [/022296/u, 'employee-id'],
  [/research[\\/]installed/u, 'internal-checkout-path'],
  [/C:\\\\Users\\\\/u, 'internal-windows-path'],
  [/\/Users\/[A-Za-z]/u, 'build-machine-path'],
  [/HTSCAI?_API_KEY/u, 'deployment-credential-ref'],
];
const leakedTexts = { 'lib/index.js': host, 'lib/client.js': client, 'cordis.patch.yml': patch };
for (const published of ['README.md', 'README.zh.md', 'docs/CONTRACT.md', 'docs/IMPLEMENTATION-STATUS.md', 'prototype/index.html']) {
  if (await isFile(published)) leakedTexts[published] = await readFile(path.join(root, published), 'utf8');
}
for (const [file, text] of Object.entries(leakedTexts)) {
  for (const [pattern, label] of LEAKS) if (pattern.test(text)) fail('leak:' + label + ':' + file);
}
// Deployment gateway must never be a compiled-in default.
for (const file of ['lib/index.js', 'lib/client.js']) {
  if (/https?:\/\/[^"']*llm-service/u.test(leakedTexts[file] ?? '')) fail('hardcoded-gateway:' + file);
}

const report = {
  ok: errors.length === 0,
  errors,
  package: pkg.name,
  version: pkg.version,
  entrypoints: exportTargets,
  peers: Object.keys(pkg.peerDependencies ?? {}),
  optionalPeers: Object.keys(pkg.peerDependenciesMeta ?? {}),
  runtimeDependencies: Object.keys(pkg.dependencies ?? {}),
  published: PUBLISHED,
};
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
