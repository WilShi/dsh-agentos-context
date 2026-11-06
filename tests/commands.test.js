import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCommand } from '../src/commands.js';

test('memory diagnostics command is primary and /oc remains compatible', async () => {
  const registrations = [];
  const disposed = [];
  const ctx = {
    get(name) {
      if (name !== 'commands') return undefined;
      return {
        register(spec) {
          registrations.push(spec);
          return () => disposed.push(spec.name);
        },
      };
    },
    credentials: { describe: async () => ({ configured: true }) },
  };
  const backend = {
    mode: 'lib',
    health: async () => ({ ok: true }),
    list: async () => [],
  };
  const dispose = registerCommand(ctx, backend, {
    apiKeyEnv: 'AGENTOS_CONTEXT_API_KEY',
    timeoutMs: 1_000,
  });
  assert.deepEqual(registrations.map(row => row.name), ['memory', 'oc']);
  for (const command of registrations) {
    const result = await command.handler({ rawInput: 'doctor' });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /agentos-context/);
  }
  const unknown = await registrations[0].handler({ rawInput: 'missing' });
  assert.match(unknown.text, /\/memory doctor/);
  dispose();
  assert.deepEqual(disposed, ['oc', 'memory']);
});