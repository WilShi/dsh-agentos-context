import test from 'node:test';
import assert from 'node:assert/strict';
let createContextService,createContextStore;
try{({createContextService}=await import('../src/context/service.js'));({createContextStore}=await import('../src/context/store.js'));}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
function fixture(){
 const records=[{id:'new',scopeId:'a',revision:1,content:'new text',kind:'note',lifecycle:'active',epistemic:'unverified',recordedAt:20,metadata:{},sourceId:'src-new',source:{id:'src-new',content:'new text'}}];let imports=0,legacyWrites=0;
 const legacyRows=[{id:'old',content:'old text',userId:'a',timestamp:10},{id:'foreign',content:'private',userId:'b',timestamp:11}];
 const store={listScopes:()=>[{id:'a',label:'a',count:records.length}],listMemories:({scopeId,lifecycle})=>records.filter(r=>r.scopeId===scopeId&&(!lifecycle||r.lifecycle===lifecycle)),getMemory:(scope,id)=>records.find(r=>r.scopeId===scope&&r.id===id),saveMemory:x=>{const r={...x,id:'saved',revision:1,lifecycle:'active',epistemic:'unverified',recordedAt:30};records.push(r);return r;},importLegacy:x=>{imports++;const r={...x,revision:1,lifecycle:'active',epistemic:'unverified',legacy:true};records.push(r);return r;},retireMemory:x=>{const r=records.find(r=>r.id===x.id);r.lifecycle='retired';r.revision++;return r;},getUsagePolicy:()=>({revision:0,paused:false,excludedIds:['new'],preferredIds:[]}),listEntities:()=>[],graph:()=>({nodes:[],edges:[],stats:{}})};
 const legacy={list:async()=>legacyRows,get:async({ids})=>legacyRows.filter(r=>ids.includes(r.id)),search:async()=>legacyRows.map(r=>({...r,score:.6})),remember:async()=>{legacyWrites++;}};
 return {store,legacy,records,counts:()=>({imports,legacyWrites}),service:createContextService({store,legacy,config:{},defaultScope:()=> 'a'})};
}
test('context service export exists',()=>assert.equal(typeof createContextService,'function'));
test('bootstrap exposes one explicit global scope alongside workspace scopes',async()=>{
 const store={listScopes:()=>[{id:'local:C:/project',label:'local:C:/project',count:2}],getMemory:()=>undefined,listUsage:()=>[]};
 const service=createContextService({store,legacy:{list:async()=>[]},config:{},defaultScope:()=> 'local:C:/project'});
 const boot=await service.bootstrap();const global=boot.scopes.find(scope=>scope.id==='dsh-default');
 assert.equal(boot.globalScope,'dsh-default');assert.deepEqual(global,{id:'dsh-default',label:'全局记忆',count:0});
});
test('bootstrap exposes current multidimensional scopes without rewriting existing scope ids',async()=>{
 const store={listScopes:()=>[{id:'local:C:/project',label:'local:C:/project',count:2}],getMemory:()=>undefined,listUsage:()=>[]};
 const session={id:'session-1',header:{id:'session-1',cwd:'C:/project',agentPreset:'coding'}};
 const service=createContextService({store,legacy:{list:async()=>[]},sessions:{get:id=>id==='session-1'?session:null},config:{scopeUserId:'demo',scopeAppId:'desktop'},defaultScope:()=> 'local:C:/project'});
 const boot=await service.bootstrap('session-1');
 assert.deepEqual(boot.currentScopes.map(row=>row.kind),['run','agent','workspace','user','app','global']);
 assert.deepEqual(boot.recallOrder,boot.currentScopes.map(row=>row.id));
 assert.equal(boot.defaultScope,'local:C:/project');
 assert.ok(boot.scopes.some(row=>row.id==='run:session-1'&&row.count===0));
});
test('upgrade compatibility discovers only known legacy application scopes',async()=>{
 const legacyRows=[
  {id:'old-app',userId:'local:D:\\DSH Desktop',content:'historical app memory',timestamp:3},
  {id:'old-default',userId:'local:default',content:'historical fallback memory',timestamp:2},
  {id:'old-project',userId:'local:D:\\projects\\private-a',content:'separate project memory',timestamp:1},
 ];
 const store={listScopes:()=>[],getMemory:()=>undefined,listUsage:()=>[]};
 const legacy={list:async({offset=0,limit,userId})=>(userId?legacyRows.filter(row=>row.userId===userId):legacyRows).slice(offset,offset+limit)};
 const service=createContextService({store,legacy,config:{compatibilityWorkspaceScopeIds:['local:D:\\DSH Desktop']},defaultScope:()=> 'local:C:\\Users\\me\\.dsh\\workspace'});
 assert.deepEqual(await service.compatibilityWorkspaceScopes('local:C:\\Users\\me\\.dsh\\workspace'),['local:D:\\DSH Desktop','local:default']);
 const boot=await service.bootstrap();
 assert.deepEqual(boot.compatibilityScopes,['local:D:\\DSH Desktop','local:default']);
 assert.deepEqual(boot.recallOrder,['local:C:\\Users\\me\\.dsh\\workspace','local:D:\\DSH Desktop','local:default','dsh-default']);
 assert.equal(boot.recallOrder.includes('local:D:\\projects\\private-a'),false);
});
test('bootstrap discovers knowledge-only legacy scopes so old uploads stay visible',async()=>{
 const store={listScopes:()=>[],getMemory:()=>undefined,listUsage:()=>[]};
 const legacy={list:async()=>[],listKnowledgeScopes:async()=>[{id:'local:default',count:1,chunks:12}]};
 const service=createContextService({store,legacy,config:{},defaultScope:()=> 'local:C:\\Users\\me\\.dsh\\workspace'});
 const scopes=await service.listScopes();const old=scopes.find(row=>row.id==='local:default');
 assert.equal(old.knowledgeCount,1);assert.equal(old.knowledgeChunks,12);assert.equal(old.count,0);
 assert.deepEqual(await service.compatibilityWorkspaceScopes('local:C:\\Users\\me\\.dsh\\workspace'),['local:default']);
});
test('listing merges legacy identity but never imports or leaks a foreign scope',async()=>{
 const f=fixture();const rows=await f.service.listMemories({scopeId:'a'});
 assert.deepEqual(rows.map(x=>x.id).sort(),['new','old']);assert.equal(f.counts().imports,0);
 assert.equal(rows.find(x=>x.id==='old').source.actorRole,'unknown');
});
test('new save uses sidecar and trusted origin not client metadata',()=>{
 const f=fixture();const r=f.service.saveMemory({scopeId:'a',content:'record',metadata:{actorRole:'human'}},{actorRole:'tool',kind:'tool-record'});
 assert.equal(r.source.actorRole,'tool');assert.equal(f.counts().legacyWrites,0);
});
test('wrong-scope legacy get returns no record',async()=>{
 const f=fixture();assert.equal(await f.service.getMemory({scopeId:'a',id:'foreign'}),undefined);
});
test('retiring legacy memory imports only on explicit mutation and shadows legacy reads',async()=>{
 const f=fixture();await f.service.retireMemory({scopeId:'a',id:'old',expectedRevision:1,reason:'retire'});
 assert.equal(f.counts().imports,1);assert.equal((await f.service.listMemories({scopeId:'a'})).some(x=>x.id==='old'),false);
});

test('threshold applies to sidecar and low semantic scores cannot overwrite stronger lexical scores',async()=>{const row={id:'m',scopeId:'a',revision:1,content:'alpha match',kind:'note',lifecycle:'active',epistemic:'unverified',recordedAt:1,metadata:{},sourceId:'s'};const store={listMemories:()=>[row],getMemory:(_s,id)=>id==='m'?row:undefined,getUsagePolicy:()=>({paused:false,excludedIds:[],preferredIds:[]}),listEntities:()=>[],graph:()=>({nodes:[],edges:[]})};const vectorIndex={search:async()=>[{id:'m',revision:1,score:.1}]};const service=createContextService({store,legacy:{search:async()=>[]},vectorIndex,config:{},defaultScope:()=> 'a'});assert.deepEqual(await service.search({scopeId:'a',query:'alpha',threshold:.9}),[]);const rows=await service.search({scopeId:'a',query:'alpha',threshold:0});assert.equal(rows[0].score,.8);assert.equal(rows[0].metadata.searchMode,'lexical');});
test('coverage questions add a focused semantic query and diversify repeated sessions',async()=>{
 const records=[
  ...Array.from({length:4},(_,index)=>({id:'same-'+index,scopeId:'a',revision:1,content:'Melanie discussed a book '+index,kind:'note',lifecycle:'active',epistemic:'unverified',recordedAt:10-index,metadata:{session:'same'},sourceId:'s'+index})),
  {id:'other',scopeId:'a',revision:1,content:'Melanie read Charlotte Web',kind:'note',lifecycle:'active',epistemic:'unverified',recordedAt:1,metadata:{session:'other'},sourceId:'other-source'},
 ];
 const queries=[];const store={listMemories:()=>[],searchMemories:()=>[],getMemory:(_scope,id)=>records.find(row=>row.id===id),getUsagePolicy:()=>({paused:false,excludedIds:[],preferredIds:[]}),listEntities:()=>[],graph:()=>({nodes:[],edges:[]})};
 const vectorIndex={search:async({query})=>{queries.push(query);return records.map((row,index)=>({id:row.id,revision:1,score:.95-index*.01}));}};
 const service=createContextService({store,legacy:{search:async()=>[]},vectorIndex,config:{},defaultScope:()=> 'a'});
 const rows=await service.search({scopeId:'a',query:'What books has Melanie read?',threshold:0,limit:3});
 assert.equal(queries.length,2);assert.match(queries[1],/book/u);assert.ok(rows.some(row=>row.id==='other'));assert.equal(rows[0].metadata.searchModes.includes('semantic-focus'),true);
});
test('Chinese coverage questions produce a clean focused semantic query',async()=>{
 const row={id:'m',scopeId:'a',revision:1,content:'用户看过活着和围城',kind:'note',lifecycle:'active',epistemic:'unverified',recordedAt:1,metadata:{session:'s'},sourceId:'s'};
 const queries=[];const store={listMemories:()=>[],searchMemories:()=>[],getMemory:()=>row,getUsagePolicy:()=>({paused:false,excludedIds:[],preferredIds:[]}),listEntities:()=>[],graph:()=>({nodes:[],edges:[]})};
 const vectorIndex={search:async({query})=>{queries.push(query);return[{id:'m',revision:1,score:.9}];}};
 const service=createContextService({store,legacy:{search:async()=>[]},vectorIndex,config:{},defaultScope:()=> 'a'});
 await service.search({scopeId:'a',query:'请问用户看过哪些书？',threshold:0,limit:3});
 assert.equal(queries.length,2);assert.equal(queries[0],'请问用户看过哪些书？');assert.match(queries[1],/用户看过\s+书/u);assert.doesNotMatch(queries[1],/哪些|请问/u);
});
test('a stale legacy hit cannot nominate corrected sidecar content',async()=>{const row={id:'same',scopeId:'a',revision:2,content:'corrected unrelated',kind:'note',lifecycle:'active',epistemic:'unverified',recordedAt:2,metadata:{},sourceId:'s2'};const store={listMemories:()=>[row],getMemory:(_s,id)=>id==='same'?row:undefined,getUsagePolicy:()=>({paused:false,excludedIds:[],preferredIds:[]}),listEntities:()=>[],graph:()=>({nodes:[],edges:[]})};const service=createContextService({store,legacy:{search:async()=>[{id:'same',userId:'a',content:'alpha stale text',score:.9}]},config:{},defaultScope:()=> 'a'});assert.deepEqual(await service.search({scopeId:'a',query:'alpha',threshold:.3}),[]);});

test('aborted legacy mutation never imports or revises after delayed lookup',async()=>{const store=createContextStore({dbPath:':memory:'});let resolveGet;const legacy={get:async()=>new Promise(resolve=>{resolveGet=resolve}),list:async()=>[],search:async()=>[]};const service=createContextService({store,legacy,config:{},defaultScope:()=> 'p'});const controller=new AbortController();const pending=service.reviseMemory({scopeId:'p',id:'legacy',expectedRevision:1,content:'replacement',reason:'test'},{signal:controller.signal});controller.abort();resolveGet([{id:'legacy',userId:'p',content:'old',timestamp:1}]);await assert.rejects(pending,{code:'ABORTED'});assert.equal(store.getMemory('p','legacy'),undefined);store.close();});
test('search applies per-session exclusion to all sources',async()=>{
 const f=fixture();const rows=await f.service.search({scopeId:'a',query:'text',sessionId:'s'});
 assert.equal(rows.some(x=>x.id==='new'),false);assert.equal(rows.some(x=>x.id==='foreign'),false);assert.equal(rows.some(x=>x.id==='old'),true);
});
test('Chinese legacy search falls back to a bounded lexical scan when old FTS returns no rows',async()=>{
 const rows=[{id:'legacy-cn',userId:'local:D:\\DSH Desktop',content:'用户对情绪监控方向感兴趣，偏好使用大数据量',timestamp:10}];
 const store={listMemories:()=>[],getMemory:()=>undefined,getUsagePolicy:()=>({paused:false,excludedIds:[],preferredIds:[]}),listEntities:()=>[],graph:()=>({nodes:[],edges:[]})};
 const legacy={search:async()=>[],list:async({offset=0,limit})=>rows.slice(offset,offset+limit)};
 const service=createContextService({store,legacy,config:{},defaultScope:()=> 'local:D:\\DSH Desktop'});
 const hits=await service.search({scopeId:'local:D:\\DSH Desktop',query:'情绪监控数据集有什么偏好',threshold:.3,limit:8});
 assert.equal(hits[0].id,'legacy-cn');
 assert.equal(hits[0].metadata.searchMode,'legacy-lexical');
});

test('legacy scope discovery paginates past five hundred records',async()=>{
 const legacyRows=[...Array.from({length:500},(_,i)=>({id:'a-'+i,userId:'a',content:'row '+i,timestamp:i})),{id:'b-only',userId:'b',content:'second page',timestamp:501}];
 const offsets=[];const legacy={list:async({offset=0,limit,userId})=>{offsets.push(offset);const rows=userId?legacyRows.filter(x=>x.userId===userId):legacyRows;return rows.slice(offset,offset+limit);}};
 const store={listScopes:()=>[],getMemory:()=>undefined,listUsage:()=>[]};
 const service=createContextService({store,legacy,config:{},defaultScope:()=> 'a'});const scopes=await service.listScopes();
 assert.ok(offsets.includes(500));assert.equal(scopes.find(x=>x.id==='a').count,500);assert.equal(scopes.find(x=>x.id==='b').count,1);
});

test('legacy memories and documents are merged into a bounded non-dangling graph',async()=>{
 const rows=[{id:'old-a',userId:'a',content:'first memory',timestamp:10,metadata:{sessionId:'s'}},{id:'old-b',userId:'a',content:'second memory',timestamp:20,metadata:{sessionId:'s',supersedes:'old-a',documentId:'doc-1'}}];
 const legacy={list:async({offset=0,limit})=>rows.slice(offset,offset+limit),listDocuments:async()=>({documents:[{id:'doc-1',filename:'guide.md',uploadedAt:5}]})};
 const store={getMemory:()=>undefined,graph:()=>({nodes:[],edges:[],stats:{nodeCount:0,edgeCount:0,truncated:false}})};
 const graph=await createContextService({store,legacy,config:{},defaultScope:()=> 'a'}).graph({scopeId:'a',rootId:'old-b',depth:1,limit:20});
 assert.deepEqual(new Set(graph.nodes.map(x=>x.id)),new Set(['old-a','old-b','doc-1']));assert.ok(graph.edges.some(x=>x.type==='supersedes'));assert.ok(graph.edges.some(x=>x.type==='references'));assert.ok(graph.edges.some(x=>x.type==='session'));const ids=new Set(graph.nodes.map(x=>x.id));assert.ok(graph.edges.every(x=>ids.has(x.source)&&ids.has(x.target)));
});

test('knowledge operations stay scope-bound and reject oversized uploads before backend calls',async()=>{
 const calls=[];const legacy={listDocuments:async input=>(calls.push(['list',input]),{documents:[{id:'d1',filename:'notes.md',mimeType:'text/markdown',uploadedAt:1,chunks:2,metadata:{}}]}),uploadDocument:async input=>(calls.push(['upload',input]),{documentId:'d1',chunks:2}),searchKnowledge:async input=>(calls.push(['search',input]),{chunks:[{id:'c1',documentId:'d1',documentName:'notes.md',content:'matching text',chunkIndex:0,score:.9,metadata:{}}]}),deleteDocument:async input=>(calls.push(['delete',input]),{deleted:true})};
 const store={};const service=createContextService({store,legacy,config:{},defaultScope:()=> 'a'});
 assert.equal((await service.listDocuments({scopeId:'a'}))[0].scopeId,'a');assert.equal((await service.uploadDocument({scopeId:'a',filename:'notes.md',mimeType:'text/markdown',content:'safe document'})).documentId,'d1');assert.equal((await service.searchDocuments({scopeId:'a',query:'matching'}))[0].documentId,'d1');assert.equal((await service.deleteDocument({scopeId:'a',id:'d1'})).deleted,true);assert.ok(calls.every(([,input])=>input.scopeId==='a'&&input.userId==='a'));
 const binary=await service.uploadDocument({scopeId:'a',filename:'notes.rtf',mimeType:'application/rtf',dataBase64:Buffer.from('{\\rtf1\\ansi parsed office text}').toString('base64')});assert.equal(binary.sourceFormat,'rtf');const uploaded=calls.findLast(([kind])=>kind==='upload')[1];assert.equal(uploaded.content,'parsed office text');assert.equal(uploaded.metadata.sourceFormat,'rtf');assert.equal(uploaded.metadata.sourceBytes,31);assert.equal('dataBase64' in uploaded,false);
 const before=calls.length;await assert.rejects(service.uploadDocument({scopeId:'a',filename:'huge.txt',mimeType:'text/plain',content:'x'.repeat(4*1024*1024+1)}),{code:'LIMIT_EXCEEDED'});assert.equal(calls.length,before);
});
test('knowledge retrieval management forwards hybrid controls and keeps every mutation scope-bound',async()=>{const calls=[];const legacy={searchKnowledge:async input=>(calls.push(['search',input]),{chunks:[]}),listDocumentChunks:async input=>(calls.push(['chunks',input]),{document:{id:'d',filename:'guide.md',chunks:1},chunks:[{id:'c',content:'alpha',chunkIndex:0}]}),reindexDocument:async input=>(calls.push(['reindex',input]),{reindexed:true,chunks:1}),deleteDocuments:async input=>(calls.push(['delete',input]),{deleted:1,requested:1})};const service=createContextService({store:{},legacy,config:{},defaultScope:()=> 'a'});await service.searchDocuments({scopeId:'a',query:'alpha',searchMode:'hybrid',documentIds:['d'],metadata:{team:'risk'}});assert.equal((await service.listDocumentChunks({scopeId:'a',id:'d'})).chunks[0].content,'alpha');assert.equal((await service.reindexDocument({scopeId:'a',id:'d'})).reindexed,true);assert.equal((await service.deleteDocuments({scopeId:'a',ids:['d']})).deleted,1);assert.ok(calls.every(([,input])=>input.scopeId==='a'&&input.userId==='a'));assert.deepEqual(calls[0][1].documentIds,['d']);assert.equal(calls[0][1].searchMode,'hybrid');});