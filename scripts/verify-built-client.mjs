/**
 * Built client gate: loads `lib/client.js` through the DSH ModuleLoader factory
 * contract and runs the exported apply() against a stub shell context.
 *
 * The client half is a browser ModuleLoader bundle: the shell supplies
 * react/react-dom and the DSH client modules through its module table, so the
 * gate proves the artifact's registration shape, ids and locale wiring.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import * as jsx from 'react/jsx-runtime';

const EXPECTED_ID = '@wilshi/dsh-agentos-context';
const built = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
assert.match(built, /data-context-surface/);
assert.match(built, /communityEdges/);
assert.match(built, /recallOrder/);
// The graph stays lazy: cytoscape must never be inlined into the main client
// bundle, and the lazy loader source keeps its separate graph.js chunk target.
// Chinese UI copy is legal here because the plugin now ships a complete zh/en
// dictionary registered through the locale service.
assert.doesNotMatch(built, /cytoscape/);
const lazyGraphLoader = await readFile(
  new URL('../src-client/graph-chunk-loader.ts', import.meta.url),
  'utf8',
);
assert.match(lazyGraphLoader, /bundle\/graph\.js/);

let definition;
globalThis.window = { __ModuleLoader__: { load(value) { definition = value } } };
await import('../lib/client.js?verify=' + Date.now());
assert.equal(definition.id, EXPECTED_ID);
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild() {} } };

const passthrough = () => null;
const primitives = new Proxy(
  { Button: passthrough, Modal: passthrough, Switch: passthrough, Tag: passthrough, MarkdownText: passthrough },
  { get(target, key) { return target[key] ?? passthrough } },
);
const form = {
  subscribe: () => () => {},
  getSnapshot: () => ({ status: 'ready', value: {}, base: {}, user: {}, revision: 1, writable: true }),
  set: async () => true,
  unset: async () => true,
  mutate: async () => true,
};
const moduleDefinition = definition.factory(id => {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime') return jsx;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error('unexpected client external ' + id);
});
assert.equal(moduleDefinition.name, 'dsh-agentos-context');
assert.deepEqual(moduleDefinition.inject.slice(0, 3), ['slots', 'locale', 'remote']);
for (const service of ['slots', 'locale', 'remote', 'remote.credentials', 'configForms', 'connection']) {
  assert.ok(moduleDefinition.inject.includes(service), 'client injects ' + service);
}

const slots = [];
const localeDictionaries = [];
const locale = {
  register(namespace, dictionaries) { localeDictionaries.push({ namespace, dictionaries }); return () => {} },
  bind(namespace) {
    return key => {
      const entry = localeDictionaries.find(item => item.namespace === namespace);
      return entry?.dictionaries.zh?.[key] ?? entry?.dictionaries.en?.[key] ?? key;
    };
  },
};
const connection = { isLoopback: true, rpc: { call: async () => ({ ok: true, value: {} }) } };
const ctx = {
  get(key) { return key === 'connection' ? connection : undefined },
  locale,
  remote: {
    credentials: { describe: async () => ({ ok: true, value: {} }), set: async () => ({ ok: true }) },
    $on: () => () => {},
  },
  configForms: { get: () => form },
  slots: {
    inject(_key, fn) { fn() },
    register(options, component) { slots.push({ options, component }); return () => {} },
  },
  effect(fn) { return fn() },
};
moduleDefinition.apply(ctx);
assert.equal(localeDictionaries.length, 1);
assert.equal(localeDictionaries[0].namespace, 'agentos-context');
assert.equal(localeDictionaries[0].dictionaries.en.nav, 'Memory');
assert.equal(localeDictionaries[0].dictionaries.zh.nav, '记忆');
assert.deepEqual(slots.map(x => x.options.name).sort(), ['conversation.view', 'settings.section']);

const conversation = slots.find(x => x.options.name === 'conversation.view');
assert.equal(conversation.options.id, 'opencontext-memory');
assert.equal(conversation.options.label(), '记忆');
const section = slots.find(x => x.options.name === 'settings.section');
assert.equal(section.options.id, 'agentos-context');
assert.equal(section.options.label(), '记忆');
assert.equal(section.options.order, 35);
const sectionFace = section.options.inject();
assert.equal(sectionFace.contextApi !== undefined, true);
assert.equal(sectionFace.api !== undefined, true);
assert.equal(sectionFace.scope !== undefined, true);
assert.equal(typeof sectionFace.subscribeCredentialsUpdated, 'function');
console.log(JSON.stringify({
  ok: true,
  moduleId: definition.id,
  pluginName: moduleDefinition.name,
  localeNamespace: localeDictionaries[0].namespace,
  slots: slots.map(x => ({ name: x.options.name, id: x.options.id, key: x.options.key, label: x.options.label?.() })),
}));
