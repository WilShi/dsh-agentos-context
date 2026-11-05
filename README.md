---

> **Fork notice**: this package is a community fork of the internal `@deepseek-ai/dsh-agentos-context` 0.2.1-rc.5 source, published as `@wilshi/dsh-agentos-context` (MIT). It inlines the DSH 0.2.1 client primitives so the web half loads on the public build, removes deployment-specific gateway defaults and wording, and redesigns the memory graph. Data format, tools and RPC namespaces are unchanged.
description: "Automatic memory, scoped recall, ontology graph, and local document knowledge for DSH Web and Desktop profiles."
kind: "package-bundle"
---

# @deepseek/dsh-agentos-context

English | [中文](README.zh.md)

## Summary

agentOS Context adds automatic long-term memory, scoped recall, a source-backed ontology graph, and a local document knowledge base to a DSH profile. The Web application and DSH Desktop include it by default. Existing OpenContext data remains readable without a destructive migration, while new records use an additive sidecar. Profile maintainers can add or remove the bundle with `dsh plugin`; its ontology is intentionally finite rather than a general OWL reasoner.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

DSH Web and Desktop already mount this package through `dsh-web-app`. Open **Settings → Memory** to configure capture, recall, embeddings, distillation and retention, or use the Memory workspace for the list, graph, review and knowledge views. The Settings row and Conversation tab follow the active DSH language. A profile that does not include `dsh-web-app` can activate or remove the installed bundle explicitly:

```text
dsh plugin --profile <name> add @deepseek/dsh-agentos-context
dsh plugin --profile <name> remove @deepseek/dsh-agentos-context
```

Adding the bundle mounts the current implementation on the compatibility `dsh-opencontext` Loader row. Official Settings therefore imports the old section into the same namespace, preserves its values, and applies editable capture, recall, embedding, distillation, retention and scope fields live without remounting the plugin. The command fails if the installed package does not expose its `dsh.bundle.patch` declaration.

### Automatic memory and recall

Automatic human-prompt capture is enabled by default and can be disabled. Accepted prompts are distilled when a configured model is available; a temporary distillation failure retains a low-importance working memory for 24 hours instead of dropping the prompt. Recall searches authorized scopes in `run → agent → workspace → user → app → global` order, keeps run memory inside one Session, and injects only bounded evidence for the accepted user query.

The 3+1 hierarchy stores working, episodic, semantic and procedural layers independently from memory type. Repeated evidence can reinforce and promote a record; approximate conflicts become review candidates rather than overwriting an established fact. Explicitly saved local content remains lossless, including credential-like text; this package does not apply DLP scanning or automatic masking.

Searching the compact conversation Memory view is executed by every underlying scope instead of filtering only the recent records already loaded in the browser. The results are merged and ranked back into the aggregate view, so older matching memories remain discoverable without changing the active workspace.

### Knowledge and document parsing

Knowledge uploads are explicit. With All scopes selected, the Knowledge view aggregates current and legacy documents while new uploads continue to enter the shared global scope. It can upload, list, search, inspect, reindex and delete text files up to 4 MiB and DOCX, XLSX, PPTX, PDF, ODT, ODS, ODP, ODG, RTF or EPUB files up to 25 MiB. Binary extraction runs locally with OCR, attachment extraction and external parser services disabled; only bounded extracted text and source metadata enter the index. Indexing and search use separate default deadlines of 10 minutes and 30 seconds.

Lexical retrieval remains available without embedding credentials. When embeddings are configured, the package loads the local SQLite vector extension and combines lexical and semantic results. Model-backed distillation and embedding send selected text and the configured credential only to endpoints in the startup allowlist; remote endpoints must use HTTPS, while plain HTTP is allowed only for loopback addresses or endpoints explicitly listed in OPENCONTEXT_DSH_TRUSTED_GATEWAY_BASES.

### Graph, ontology and compatibility

The workbench offers a 2D relationship view and an optional remembered WebGL 3D point-cloud view with orbit, zoom, picking, community folding, active light or dark application colors and a source-backed detail drawer; an unsupported WebGL environment falls back to 2D. Model extraction can propose typed objects and relations, but each relation must quote its source exactly and stays pending until a person confirms it. The aggregate view folds a large graph into one community per memory scope before a person opens a scope, while a single scope uses deterministic relationship communities and retains cross-community edges.

In Desktop, leaving native fullscreen also closes graph fullscreen when the DOM fullscreen event is absent. DOM fullscreen entry restores the graph after a rapid reentry, and a delayed earlier native exit does not close the active DOM graph. An explicit toggle or Escape exit remains in force when an earlier pending DOM fullscreen entry arrives; that entry is exited rather than restoring graph fullscreen. The CSS-only fullscreen fallback remains dismissible with Escape.

Legacy OpenContext memories and document references remain read-only inputs and are never rewritten at startup. The package preserves the `dsh-opencontext` settings namespace, reads compatibility identifiers, and keeps callable `oc_*` aliases while presenting `memory_*`, `knowledge_*` and `context_*` names. New revisions, retirements, usage traces and ontology state live in the agentOS Context sidecar; schema-v1 sidecars migrate additively to schema v2.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle patch inserts one dual-face Cordis package. Its Host face opens the compatibility backend and sidecar, registers authenticated `agentos-context/v1/*` RPC routes, model tools, the runtime skill and agent lifecycle listeners. Its Client face installs the first-level Memory settings section and workbench views. Browser operations use authenticated Connection RPC instead of legacy raw browser routes. Modal views use the shared Client UI primitive for focus containment, Escape handling and focus restoration, while this package owns only their content and layout.

Legacy OpenContext storage loads on its first operation, not while importing the plugin for CLI help or schema inspection. Disposing an unused compatibility backend closes any owned document store without loading legacy storage.

The sidecar keeps immutable source and memory revisions, typed entities, reviewed relations, temporal validity, idempotency and usage policy in SQLite. The vector index uses the same scope and revision checks, so a stale or unauthorized embedding cannot become a recall result. Existing OpenContext records are projected conservatively and stay in their original database.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Bundle activation and legacy-row suppression |
| [`src/index.ts`](src/index.ts) | Host entry, configuration and plugin assembly |
| [`src/context/store.js`](src/context/store.js) | Sidecar persistence, ontology and revision rules |
| [`src/recall.js`](src/recall.js) | Accepted-query scoped recall and prompt injection |
| [`src/document-parser.js`](src/document-parser.js) | Bounded local text and binary-document extraction |
| [`src-client/index.tsx`](src-client/index.tsx) | Settings and Memory workbench registration |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Compatibility and operation contract](docs/CONTRACT.md)
- [Interaction prototype](prototype/PROTOTYPE.md)
- [DSH profile and bundle composition](../../../docs/architecture.md)

-----

<a id="model-experience"></a>
## Model Experience

### Automatic recall

#### What the model sees

For an accepted human query, the package appends one `agentos-context`-origin user message containing a bounded `<opencontext_evidence>` block. The producer-owned source remains valid in the current Session format. The block labels recalled records as untrusted evidence, escapes record content and ids, and includes only records from scopes authorized for the current Session.

#### Token effect

Recall adds at most the configured `maxBytes` evidence budget plus its fixed wrapper. No matching record adds no message. The usage tracker records which exact revisions reached a committed request.

#### KV Cache effect

The evidence message follows the current human message, so a different query or memory result changes the request suffix without rewriting earlier durable conversation history.

### Memory and knowledge tools

#### What the model sees

The package registers descriptive tools including `memory_search`, `memory_save`, `knowledge_search` and `knowledge_document_upload`; older `oc_*` names remain callable aliases. Tool results return bounded structured records or document chunks and never grant authority to recalled text.

#### Token effect

Tool schemas contribute their fixed definitions to presets that mount this package. Tool calls add only the bounded result selected by the model and the configured per-operation limits.

#### KV Cache effect

Stable tool definitions can retain the request prefix cache. A tool result appends new history in the ordinary tool-call position and does not mutate previous messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The ontology uses approved finite entity and relationship types; it does not implement arbitrary OWL reasoning, organization-wide authorization, automatic conflict adjudication, review undo, irreversible purge or cross-project sharing.
- Legacy `.doc`, `.xls`, `.ppt` and proprietary `.wps`, `.et`, `.dps` files are not parsed. Save them as OOXML or ODF first. Image-only PDFs require OCR and are rejected when they contain no extractable text.
- Automatic capture writes to the current workspace by default. User, Agent and application scopes require trusted runtime identity or explicit local configuration; an untrusted message cannot manufacture those identities.
- Rolling back to the legacy plugin leaves original records intact but hides sidecar-only writes. A legacy record retired only in the sidecar can therefore reappear after rollback; preserve both databases during evaluation.
- Knowledge uploads are local explicit actions. This package does not crawl folders, synchronize external repositories or perform OCR.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>