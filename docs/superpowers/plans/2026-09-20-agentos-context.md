# agentOS context Implementation Plan

> For agentic workers: use executing-plans task by task. Keep code isolated, test new behavior before implementation, and do not alter the active Profile or production memories.

**Goal:** Implement the approved v1.1 design as a runnable agentOS context package, preserving existing data and oc_* compatibility.

**Architecture:** Use the exact installed dsh-opencontext source as baseline. Preserve its configuration namespace and old IDs. Add a SQLite sidecar for typed entities, source-backed claims, revisions, review and usage policies. Both UI entries and agent tools use one service; existing memory is read compatibly rather than migrated at startup.

**Tech Stack:** Node22 ESM, SQLite driver seam, React18/TypeScript, DSH primitives and tokens, tsdown/CSS Modules, node:test and local UI tests. Dependencies are reused read-only from verified local installations.

## Permissions and compatibility
- User approved implementing v1.1 and changing the visible name to agentOS context.
- The extra confirmation for temporary networking/Electron diagnostics timed out. Until approved, do not start a listener, launch a new DSH instance or install this package. Local implementation/build/test/pack may continue.
- Target desktop. Upgrade bundle targets the existing dsh-opencontext row. No duplicate tools or settings namespace.
- System Node22 ABI127 differs from the available old-fork better-sqlite3 ABI148. Never rebuild shared native binaries. Use a driver adapter and isolated test databases, and report target-runtime verification separately.
- Existing source: research/installed/dsh-opencontext. Keep this baseline immutable. Old workspace forks are not modified.

## Task 1 — Isolated package and offline baseline
Files: package.json, cordis.patch.yml, scripts/setup-offline.mjs, scripts/run-tests.mjs, tests/baseline.test.js, tsconfig.client.json.
- [ ] Copy installed src/src-client/LICENSE/tsdown.config.ts into this isolated root; copy the approved prototype and update its visible brand/approval record.
- [ ] Add development-only node_modules junctions without changing their targets.
- [ ] Run these baseline tests before changing the corresponding behavior:
~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPreparedContext } from '../src/prepared-context.js';
test('baseline evidence remains untrusted',()=>{
  assert.match(formatPreparedContext([{id:'fixture',content:'sample'}],8000).content,/untrusted/);
});
~~~
- [ ] Run node scripts/run-tests.mjs, expected baseline PASS. Run isolated tsdown build and investigate any failure.

## Task 2 — Typed persistence and evidence
Files: src/context/errors.js, validation.js, schema.js, sqlite.js, store.js, projections.js; tests/context-store.test.js.
- [ ] RED: test reopen persistence, idempotent save, cross-scope rejection, empty/secret rejection, independent source and claim records, version conflict, immutable history, relation domain/range and unknown relation rejection.
~~~js
test('a stale revision cannot overwrite current content',()=>{
  const m=store.saveMemory({scopeId:'test:a',content:'A',idempotencyKey:'a'});
  store.reviseMemory({scopeId:'test:a',id:m.id,expectedRevision:1,content:'B',reason:'correction'});
  assert.throws(()=>store.reviseMemory({scopeId:'test:a',id:m.id,expectedRevision:1,content:'C',reason:'stale'}),{code:'VERSION_CONFLICT'});
  assert.equal(store.getMemory('test:a',m.id).content,'B');
});
~~~
- [ ] GREEN: transaction-bound memories/revisions, sources, entities/aliases, relationship claims/revisions, reviews, changes, session usage and policies.
- [ ] Preserve source actor/lineage. Saving a model or agent statement does not turn it into direct human evidence.
- [ ] Record valid-time and transaction-time for claim revisions; do not invent validity for legacy records.
- [ ] Run node scripts/run-tests.mjs; isolated temporary file reopen must pass in addition to in-memory tests.

## Task 3 — One service and legacy compatibility
Files: src/context/service.js, backend-bridge.js; tests/context-service.test.js. Modify src/index.js/config.js and additive backend-lib scope fields.
- [ ] RED: merged old/new reads retain original IDs, do not migrate at startup, enforce scope, preserve source attribution and exclude retirement tombstones.
~~~js
test('legacy identity survives upgrade reads',async()=>{
  const rows=await service.listMemories({scopeId:'test:a'});
  assert.equal(rows.find(x=>x.legacy).id,'legacy-original-id');
});
~~~
- [ ] GREEN: decorate the existing backend so oc_* tools and the UI share the same authority and filters. New records use sidecar transactions; existing sources remain intact.
- [ ] User correction must not masquerade as original document text. Retired data must not reappear through fallback when sidecar validation fails.
- [ ] Document rollback limitations and preserve tombstones. A legacy reader unaware of tombstones must have recall disabled before fallback.

## Task 4 — Session-aware recall and trace
Files: src/context/usage.js; tests/context-recall.test.js, context-capture.test.js. Modify src/recall.js/prepared-context.js/capture.js.
- [ ] RED: use actual payload.agent.session; distinguish human/plugin/agent source; respect byte budget; trace only included records; next() exactly once; preserve startsRequestSeries; do not label rejected/uncommitted content injected.
~~~js
test('rejected admission does not create an injected trace',async()=>{
  await recall(payload,async()=>({kind:'reject'}));
  assert.equal(store.listUsage(sessionId).filter(x=>x.phase==='injected').length,0);
});
~~~
- [ ] GREEN: attach usage ID and exact memory revisions to framed evidence metadata.
- [ ] Observe verified session/event(session,event), transitioning planned records only on matching accepted user/message; record request/assistant boundaries separately. No fake usage list from search results.
- [ ] Recheck scope, valid status, retirement and budget for each request. Preferred references never bypass policy.
- [ ] Auto-capture skips plugin context, retrieval echoes and subagent notices; preserve full/partial-source distinctions.

## Task 5 — API and review
Files: src/context/routes.js, request-validation.js; tests/context-routes.test.js. Mount versioned subroutes from src/api-routes.ts.
- [ ] RED: methods, content types, body limits, malformed IDs, scope, version, idempotency, origin and sanitized errors.
- [ ] GREEN: GET scopes/memories/detail/entities/graph/reviews/schema/usage/changes; POST save/revise/retire/entity/relation/review/usage-policy/schema-check through a shared service contract.
- [ ] Require evidence and reason for review. Unlike entity types cannot merge; preserve canonical/source IDs, audit and disputed claims.
- [ ] Never trust client-supplied actor/ACL/confirmed status. Desktop local identity is the boundary; organization-wide multi-tenant ACL is not claimed.

## Task 6 — Native UI and visible rename
Files: src-client/context-api.ts, context-types.ts, ContextWorkbench.tsx, ContextMemoryPane.tsx, ContextGraph.tsx, ContextReview.tsx, ContextSettings.tsx, ContextOverlay.tsx, context-store.ts, Context.module.css; client tests. Modify ConfigCard.tsx/index.tsx and ModuleLoader build ID.
- [ ] RED: four tabs, request loading/error/empty, shared refresh, cancellation, required reason, source origin, type-safe merge and historical label synchronization.
- [ ] GREEN: original settings row retains credential controls and adds workbench access. Display agentOS context, preserving internal namespace and tool IDs.
- [ ] Session memory receives actual sessionId. Use verified openView and session-scoped resident overlay; preserve composer and show trace-unavailable explicitly. Native chat scroll preservation remains a target-runtime acceptance item until run.
- [ ] Use host primitives and --dsw-alias-* only. No independent sidebar/theme/hero, no hard-coded demo records in production components.
- [ ] Graph and source panels read actual typed records; empty states explain how to save/confirm relations. Include the approved prototype in the package.

## Task 7 — Verification and handoff
Files: scripts/package.mjs, scripts/verify-package.mjs, docs/IMPLEMENTATION-STATUS.md, artifacts reports.
- [ ] Run domain/API/recall/UI tests and client typecheck. Re-run every reproduced failure after its fix.
- [ ] Build Host/Client/graph; preserve LICENSE. Scan published files for credentials, workstation paths and missing runtime dependencies.
- [ ] Run official validate-package.mjs with --target desktop --ui. Pack a versioned tgz and inspect the actual tarball and SHA-256.
- [ ] Verify exports with an isolated loader. Do not mutate active Profile.
- [ ] Only after explicit runtime approval, start a managed loopback-only isolated instance with isolated data, record job/URL, and verify UI→API→SQLite→reopen. Do not pass this check using screenshots or mocked state.
- [ ] Deliver implemented/deferred/unverified matrix plus precise install and rollback commands. Request separate installation and real-data migration approval.

## Checkpoint boundary
The target remains the approved design. Arbitrary OWL execution, organization-wide ACL, cross-project sharing, irreversible deletion and unbounded governance are not implied by the brand or graph. Undelivered capabilities and unverified runtime behavior must be listed explicitly rather than hidden behind functional-looking mock controls.
