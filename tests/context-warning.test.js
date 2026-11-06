import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextService } from '../src/context/service.js';

/** Minimal store: the service only needs these for bootstrap/listScopes. */
function store() {
  return {
    listScopes: () => [],
    getMemory: () => undefined,
    listUsage: () => [],
  };
}

function service(legacy, extra = {}) {
  return createContextService({
    store: store(),
    legacy,
    config: {},
    defaultScope: () => 'local:C:\\project',
    ...extra,
  });
}

test('legacy read failure keeps the plain warning and adds a stable code', async () => {
  const boot = await service({
    list: async () => { throw new Error('legacy unavailable'); },
  }).bootstrap();
  assert.equal(boot.warnings.length, 1);
  assert.equal(boot.warnings[0], '旧记忆暂不可读，当前只显示可用的新记忆；未更改旧数据库。');
  assert.deepEqual(boot.warningDetails, [{
    code: 'LEGACY_READ_FAILED',
    message: boot.warnings[0],
  }]);
});

test('legacy backend without paging support is reported as a stable code', async () => {
  // A backend that ignores offset: every page returns the same ids, so the
  // second page adds nothing and the service must stop with a warning.
  const page = Array.from({ length: 500 }, (_, index) => ({
    id: 'legacy-' + index,
    content: 'text ' + index,
    userId: 'local:C:\\project',
    timestamp: index,
  }));
  const boot = await service({ list: async () => page }).bootstrap();
  const details = boot.warningDetails ?? [];
  const paging = details.find(item => item.code === 'LEGACY_PAGING_UNSUPPORTED');
  assert.ok(paging, 'expected LEGACY_PAGING_UNSUPPORTED in ' + JSON.stringify(details));
  assert.equal(paging.message, '旧记忆后端不支持分页，范围列表可能不完整。');
  assert.ok(boot.warnings.includes(paging.message));
});

test('a healthy host exposes no structured warnings', async () => {
  const boot = await service({ list: async () => [] }).bootstrap();
  assert.deepEqual(boot.warnings, []);
  assert.deepEqual(boot.warningDetails, []);
});
