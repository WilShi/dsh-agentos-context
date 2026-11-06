import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const backendUrl = new URL('../src/backend-lib.js', import.meta.url).href;
const completion = 'unused legacy backend remained unopened\n';

async function assertUnopened(script) {
    const result = await execute(process.execPath, ['--trace-deprecation', '--input-type=module', '--eval', script], {
        timeout: 30_000,
        windowsHide: true,
    });
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, completion);
}

test('importing the library backend does not load unused legacy storage', async () => {
    await assertUnopened(`await import(${JSON.stringify(backendUrl)}); process.stdout.write(${JSON.stringify(completion)});`);
});

test('disposing an unused library backend does not initialize legacy storage', async () => {
    await assertUnopened(`const { createLibBackend } = await import(${JSON.stringify(backendUrl)}); await createLibBackend({}).dispose(); process.stdout.write(${JSON.stringify(completion)});`);
});
