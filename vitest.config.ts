import { defineConfig } from 'vitest/config';

/**
 * Client-half unit/integration tests.
 *
 * The client bundle is built as a browser ModuleLoader artifact, so the tests
 * mount the real React components in a DOM (happy-dom) with the same
 * `@deepseek-ai/dsh-client-ui-primitives` surface the shell provides. The
 * alias installs the shared fixture stub for that shell module.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-client-ui-primitives': new URL('./tests/primitives-stub.tsx', import.meta.url).pathname,
    },
  },
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  test: {
    environment: 'happy-dom',
    include: ['tests/context-*.client.spec.{ts,tsx}'],
    pool: 'threads',
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 5000,
    restoreMocks: true,
  },
});
