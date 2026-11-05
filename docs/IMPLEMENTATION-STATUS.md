# agentOS context Implementation Status

## Implemented in the isolated package
- Visible rename to agentOS context while retaining OpenContext storage/tool compatibility.
- Persistent sidecar store with immutable source, memory, entity, relation, change and usage records.
- Scoped reads, explicit legacy import only on mutation, optimistic revisions and safe retirement.
- Finite ontology schema, domain/range validation, evidence quotes, pending review and historical graph projection.
- 3+1 memory hierarchy (working, episodic, semantic, procedural), configurable retention, same-session working-memory recall, automatic expiry, evidence reinforcement, safe promotion and candidate-only handling of approximate conflicts.
- Structured model extraction can propose typed ontology objects and relationships from new captured messages. Every proposed relationship must carry an exact quote from the preserved source and stays `pending` until manual confirmation; invalid or invented evidence is discarded.
- Legacy and sidecar memories through one compatibility service; descriptive memory/knowledge/context tool names are primary while existing `oc_*` names remain callable aliases. Legacy scope/list discovery pages beyond the former 500-row ceiling (bounded at 100,000) and reports backends that ignore pagination.
- Legacy memory/document nodes and revision, document-reference and session edges are merged into the bounded graph without writing to the legacy database.
- Large graphs are projected into deterministic Louvain-style communities without a new runtime dependency. The graph starts collapsed when useful, preserves node view, expands/collapses community members, aggregates cross-community edges and provides community composition and neighboring-community details.
- Entity-scoped recall follows `run → agent → workspace → user → app → global`. Identity scopes come only from trusted runtime metadata or explicit local settings; absent identities are omitted, cross-session run access is rejected, and fixed legacy scopes remain isolated. Automatic capture continues to default to workspace.
- Bounded untrusted evidence formatting, downstream-admitted human capture/recall, restart-safe message correlation, and separately labelled planned/committed/requested/failed usage stages.
- Authenticated, versioned DSH Connection RPC (`agentos-context/v1/*`) and real RPC-backed Memory/Knowledge/Graph/Review/Settings surfaces; raw loopback browser mutation/credential routes are not registered.
- The Knowledge surface uploads, lists, semantically searches and deletes scope-bound documents. Text uploads are bounded to 4 MB; DOCX/XLSX/PPTX/PDF/ODF/RTF/EPUB sources are bounded to 25 MB and extracted locally through `officeparser` with ZIP, table-cell, timeout and extracted-text limits. Original binary bytes are not persisted. Large indexing and semantic-search operations use dedicated bounded deadlines (`knowledgeUploadTimeoutMs`, default 10 minutes; `knowledgeSearchTimeoutMs`, default 30 seconds) instead of the 4-second interactive-memory deadline.
- Official 0.2.1 Loader configuration forms on the compatibility `dsh-opencontext` entry, one-time import of the previous settings document, live volatile updates without a plugin remount, staged revision-fenced saves, a standalone first-level “记忆” settings section, and the native conversation “记忆” tab without hiding the composer.
- First checkpoint deliberately uses the verified conversation.view contract. The prototype’s simultaneous right-side drawer remains a target-runtime follow-up because no supported non-replacing overlay contract has yet been verified.
- Persistent semantic cache for new sidecar revisions with lexical/graph fallback when embedding is unavailable. Model-backed distillation/embedding requires an exact process-approved gateway. Remote gateway entries must use HTTPS; plain HTTP is accepted only for loopback addresses or for explicitly trusted bases behind a TLS-terminating proxy, configured through `OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES`. Selected memory/prompt text and the configured Bearer credential may be sent to that endpoint. Automatic prompt capture is enabled by default; a transient distillation failure keeps the accepted human prompt only as a low-importance local working memory with bounded expiry, while a successful empty distillation still drops non-memory chatter.
- User-authorized memory and knowledge content is stored losslessly without credential-pattern rejection or masking. This applies to manual saves, automatic capture, local document indexing, recall and ontology candidates; structural, size, scope and source-attribution validation remains enforced.
- The graph surface includes a deterministic 2D mode and a bundled Three.js WebGL 3D exploration mode. The preference is remembered locally, reduced-motion preferences disable auto-rotation, and renderer failures return to 2D without losing graph data.

## Explicitly deferred
- Arbitrary OWL or recursive reasoning.
- Organization-wide multi-tenant authorization and cross-project sharing.
- Automatic contradiction resolution, conflict review queue, alias-candidate review queue, and review undo. Approximate memory conflicts remain candidates, and the current “待确认” tab reviews source-backed pending relations; direct same-type alias merge is available from the object view with optimistic revision checks.
- Permanent purge, external-system writeback and unattended migration.
- Bulk auto-extraction of entities/relations from historical records. Automatic extraction applies only to newly captured, successfully distilled messages.
- Legacy `.doc/.xls/.ppt`, proprietary `.wps/.et/.dps`, document macros, embedded attachments and OCR for scanned PDFs. WPS documents saved as OOXML/ODF are supported through those standard containers.
- Session-relevance ranking for the conversation pane’s “已存记忆” list; this checkpoint truthfully shows other active scope memories rather than calling them related candidates.

## Verified release gates
- `npm run verify:release`: Node and Vitest suites, TypeScript, Host/Client build, built registrations, working-tree package checks, exact tarball inspection, and Desktop patch application.
- Release 0.1.22 distribution: the exact `.tgz` installed into a disposable DSH Desktop 2.2.35 Profile as one package in under two seconds, without downloading or rebuilding native dependencies. The installed archive loaded under Electron ABI 148, opened `better-sqlite3`, loaded sqlite-vec v0.1.9, and composed one disabled legacy row plus one active agentOS context row without warnings.
- Disposable Profile: final tarball installed/imported with complete local rc2 dependencies; patch composition contains one disabled `dsh-opencontext` row and one active `agentos-context → dsh-agentos-context` row.
- Release 0.1.4: the exact archive passed package/version/content inspection, and Desktop profile preparation produced one disabled legacy `dsh-opencontext` row plus one active `agentos-context → dsh-agentos-context` row without patch warnings.
- Release 0.1.5: the full release gate passed with the dedicated memory settings section and bounded local binary document extraction; the exact archive passed identity/content inspection and disposable Desktop patch composition completed without warnings.
- Release 0.1.6: schema-v1 → schema-v2 migration was exercised against a real SQLite file and preserved the byte-identical historical `record_json`; layer, retention, promotion and pending ontology-candidate tests pass.
- Release 0.1.6 isolated Web UI: the exact `dsh-agentos-context-0.1.6.tgz` was unpacked into a disposable Desktop Profile, then started through the packaged Desktop CLI. A real Chromium session loaded the page, verified the first-level Memory settings entry and plugin card, created/revised/retired a memory, traversed all five workbench tabs, captured wide/narrow screenshots, and reported zero failed browser requests or console errors. The 760px view had no document or workbench horizontal overflow.
- Installed Electron ABI 148: the native knowledge-store upload/search/scope-isolation/delete tests passed, including vector-index cleanup after deletion.
- Installed DSH Desktop Electron runtime: DOCX/XLSX/PPTX/PDF/RTF extraction and corrupt/mismatched/oversized/cancelled input checks all passed.
- Real legacy database: `%USERPROFILE%\.opencontext\memory\store.db` passed SQLite `quick_check`; 5 populated scopes exposed 540 memories and 240 graph nodes through the prepared Electron runtime. The source database SHA-256 was unchanged before and after verification.
- The isolated Web-runtime UI validation loaded the plugin tree, served `__DSH_BOOT__` plus the agentOS client module, and rendered the settings card/workbench without browser console errors.
- Independent final host and client delta reviews reported no remaining blocker/high findings in the remediated areas.

## Still requires authorized runtime verification
- Actual active Electron Desktop layout, the current user theme/font-scale combination, and native-window restart behavior (isolated Web runtime UI was verified).
- Conversation view/composer and settings modal behavior inside the active shell.
- Active Profile add, application restart, real-shell interaction, uninstall and rollback (disposable Profile install/patch verification is complete).

No production Profile, credentials or memory data were modified during implementation.

## Rollback boundary
- Upgrade does not rewrite or bulk-copy the legacy OpenContext database.
- New memories, revisions, retirements, ontology data and usage traces live in the sidecar. A rollback to a legacy-only plugin cannot display those new records, and a legacy record retired only through the sidecar may become visible again.
- Preserve both the legacy OpenContext database and the agentOS sidecar for any downgrade or recovery exercise.