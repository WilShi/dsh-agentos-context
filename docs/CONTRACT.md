# Shared context service/store contract v2

All methods return lossless JSON; store methods are synchronous except close may be awaited. An error has code and a safe user-facing message. Desktop identity belongs to the authenticated DSH Connection carrier and service, never caller metadata; no raw browser HTTP mutation or credential route is registered. Client methods use the versioned `agentos-context/v1/*` namespace. Every entity/memory/relation operation is explicitly scoped.

## Records
Memory = {id, revision, scopeId, content, kind, layer, importance, expiresAt, promotedFrom, lifecycle, epistemic, sourceId, source, recordedAt, validFrom, validTo, metadata, legacy}; kind fact|decision|preference|constraint|outcome|plan|note; layer working|episodic|semantic|procedural; lifecycle active|candidate|retired; epistemic unverified|supported|contested|refuted. Source = {id,scopeId,content,kind,actorRole,complete,recordedAt,lineageId}; role human|assistant|agent|tool|unknown. Layer and kind are independent dimensions. Saving does not imply supported. Revision history keeps source and content immutable.
Entity = {id,revision,scopeId,name,type,aliases,recordedAt}. Types Project,Person,Requirement,API,Service,Constraint,Decision,Document.
Relation = {id,revision,scopeId,subjectId,predicate,objectId,sourceId,quote,status,validFrom,validTo,recordedAt}; status pending|confirmed|rejected. Confirmed relations require an existing same-scope source and an exact quote from it.
Graph = {nodes:[{id,type,subtype?,layer?,importance?,label,timestamp?,status?,scopeId,communityId?}],edges:[{id,source,target,type,status?,relationId?,sourceId?,quote?}],communities:[{id,label,summary,nodeIds,size,edgeCount,externalEdgeCount,topNodeIds,typeCounts,scopeId}],communityEdges:[{id,source,target,count,types}],stats:{nodeCount,edgeCount,communityCount,truncated}}. type is entity/memory/source for nodes; type is predicate or source/mentions for edges. Communities are a deterministic, read-only projection; original nodes and edges are retained. Truncation is explicit and never emits dangling edges.

## Scope identity and recall
Without a fixed `scopeId`, trusted runtime/config identities resolve in this order: `run → agent → workspace → user → app → global`. The run scope is derived from the current session id and is never authorized for another session. Agent, user and app scopes are omitted when no trusted identity exists. Caller message metadata is not an identity source. A configured fixed `scopeId` preserves legacy single-scope isolation. Automatic capture defaults to workspace; explicit tools may write only to scopes authorized for the current session.

## Module API: src/context/store.js
export createContextStore({dbPath, now?}) -> ContextStore. Tests use :memory: or explicit workspace temp files; never default to a user DB.
- listScopes() -> [{id,label,count}]
- saveMemory({scopeId,content,kind?,layer?,importance?,expiresAt?,source?,metadata?,idempotencyKey?,validFrom?,validTo?,entityIds?}) -> Memory
- importLegacy({id,scopeId,content,timestamp?,metadata?}) -> Memory; explicit mutation only, retain ID, unknown origin, do not modify external DB
- getMemory(scopeId,id,{knownAt?,validAt?}?) -> Memory|undefined
- listMemories({scopeId,query?,lifecycle?,epistemic?,layer?,limit?,knownAt?,validAt?}) -> Memory[]
- reviseMemory({scopeId,id,expectedRevision,content,reason,kind?,layer?,importance?,expiresAt?,validFrom?,validTo?,actorRole?}) -> Memory
- transitionMemory({scopeId,id,expectedRevision,layer,importance?,expiresAt?,reason}) -> Memory
- reinforceMemory({scopeId,id,expectedRevision,layer?,importance?,expiresAt?,source,reason?}) -> Memory
- expireMemories({scopeId,at?,limit?}) -> Memory[]; creates retired revisions, never deletes history
- retireMemory({scopeId,id,expectedRevision,reason}) -> Memory
- versions(scopeId,id) -> Memory[]
- createEntity({scopeId,name,type,aliases?}) -> Entity
- listEntities({scopeId,query?,limit?}) -> Entity[]
- getEntity(scopeId,id) -> Entity|undefined
- mergeEntities({scopeId,keepId,mergeId,keepRevision,mergeRevision,reason}) -> Entity; identical type, same scope, preserve aliases/source IDs and reject destructive self-relations
- createRelation({scopeId,subjectId,predicate,objectId,sourceId?,quote?,validFrom?,validTo?}) -> Relation (pending)
- reviewRelation({scopeId,id,expectedRevision,decision:'confirm'|'reject',reason}) -> Relation
- listRelations({scopeId,status?,knownAt?,validAt?}) -> Relation[]
- listReviews({scopeId}) -> pending Relation[]; conflict status may be attached, never silently auto-resolve
- validateRelation(input) -> {ok,errors:[{field,code,message}]}; pure validation, no writes
- getSchema() -> {version,memoryLayers:[{id,label}],types:[{id,label}],relations:[{id,label,domain:string[],range:string[]}]}
- graph({scopeId,rootId?,depth?,includePending?,limit?,knownAt?,validAt?}) -> Graph
- changes({scopeId,limit?}) -> [{id,action,targetId,reason,at,revision}]
- recordUsage({id,sessionId,scopeId,messageId?,turn?,step?,phase:'planned',items:[{id,revision,content,sourceId?,kind?,truncated?,legacy?}],reason?,at?}, {trustedLegacy?}) -> usage record; reject duplicate IDs with different payloads. `trustedLegacy` is private to the service-owned recall bridge: an absent sidecar id is accepted only when both the option and item.legacy are true.
- findUsageByMessageId({sessionId,messageId}) -> exact immutable usage snapshot or undefined; messageId is generated before recall insertion and persisted for restart-safe correlation.
- updateUsage({id,phase:'committed'|'requested'|'failed',eventSeq?,at?}) -> usage record; never mutate items
- listUsage({sessionId,scopeId?,limit?}) -> usage[]
- setUsagePolicy({sessionId,scopeId,memoryId?,mode?:'exclude'|'prefer'|'normal',paused?,expectedRevision?}) -> policy
- getUsagePolicy(sessionId) -> {revision,scopeId?,paused,excludedIds,preferredIds}
- close()

## Integration boundaries
The parent owns src/context/service.js, backend-bridge.js, routes.js, usage.js and all existing src files. The store implementer owns only src/context/{store,sqlite,schema,validation,errors,projections}.js and tests/context-store*.test.js, and may add a clearly named domain-only helper under src/context if needed. Notify before contract changes.
New store reads are not an implicit migration. Parent handles legacy backend lazy reads and calls importLegacy only before explicit legacy mutation/linking. Node SQLite adapter must not rebuild or overwrite shared better-sqlite3 binaries.

Schema v1 → v2 is an additive sidecar migration: three indexed columns are added while existing immutable `record_json` snapshots remain untouched. The projection boundary supplies semantic/0.5/non-expiring defaults for v1 and OpenContext records. Automatic ontology extraction is internal-only; extracted relations require exact source quotes and enter `pending`, never `confirmed`.
