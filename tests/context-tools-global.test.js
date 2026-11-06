import test from 'node:test';
import assert from 'node:assert/strict';
import {registerTools} from '../src/tools.js';
import {makeKnowledgeTools} from '../src/tools-knowledge.js';

test('oc_remember accepts an explicit global scope while keeping workspace as the default',async()=>{
 const tools=[],writes=[];
 const ctx={tools:{register(tool){tools.push(tool);return()=>{}}}};
 const runtime={
  backend:{remember:async input=>(writes.push(input),{ids:['saved']})},
  config:{scopeId:'',maxRecallItems:8,maxBytes:8000,timeoutMs:1000},
 };
 registerTools(ctx,runtime,tool=>tool);
 const remember=tools.find(tool=>tool.name==='oc_remember');
 assert.equal(remember.parameters.scope.type,'string');
 const execution={signal:new AbortController().signal,agent:{session:{id:'s',header:{cwd:'C:/project'}}}};
 assert.equal((await remember.execute({content:'shared preference',scope:'global'},execution)).ok,true);
 assert.equal((await remember.execute({content:'project decision'},execution)).ok,true);
 assert.deepEqual(writes.map(write=>write.scopeId),['dsh-default','local:C:/project']);
});

test('oc_remember supports trusted run agent user and app scopes but rejects unavailable identity',async()=>{
 const tools=[],writes=[],ctx={tools:{register(tool){tools.push(tool);return()=>{}}}},runtime={backend:{remember:async input=>(writes.push(input),{ids:['saved']})},config:{scopeId:'',scopeUserId:'employee:demo',scopeAppId:'desktop',maxRecallItems:8,maxBytes:8000,timeoutMs:1000}};
 registerTools(ctx,runtime,tool=>tool);const remember=tools.find(tool=>tool.name==='oc_remember'),execution={signal:new AbortController().signal,agent:{session:{id:'s1',header:{id:'s1',cwd:'C:/project',agentPreset:'coding'}}}};
 for(const scope of ['run','agent','user','app'])assert.equal((await remember.execute({content:scope+' memory',scope},execution)).ok,true);
 assert.deepEqual(writes.map(row=>row.scopeId),['run:s1','agent:coding','user:employee%3Ademo','app:desktop']);
 const missing={signal:new AbortController().signal,agent:{session:{id:'s2',header:{id:'s2',cwd:'C:/project'}}}};
 assert.equal((await remember.execute({content:'not authorized',scope:'user'},missing)).ok,true,'configured user identity remains available');
 const noIdentityTools=[];registerTools({tools:{register(tool){noIdentityTools.push(tool);return()=>{}}}},{backend:runtime.backend,config:{scopeId:'',maxRecallItems:8,maxBytes:8000,timeoutMs:1000}},tool=>tool);
 assert.equal((await noIdentityTools.find(tool=>tool.name==='oc_remember').execute({content:'must fail',scope:'user'},missing)).ok,false);
});

test('workspace reads include safe pre-upgrade compatibility scopes while writes stay current',async()=>{
 const tools=[],calls=[];
 const backend={
  compatibilityWorkspaceScopes:async scopeId=>{assert.equal(scopeId,'local:C:/project');return['local:D:\\DSH Desktop','local:default'];},
  search:async input=>(calls.push(['search',input.scopeId]),[{id:'hit-'+input.scopeId,scopeId:input.scopeId,content:input.scopeId,score:.8,timestamp:1,metadata:{}}]),
  list:async input=>(calls.push(['list',input.scopeId]),[{id:'list-'+input.scopeId,scopeId:input.scopeId,content:input.scopeId,timestamp:input.scopeId.includes('DSH')?3:1}]),
  get:async input=>(calls.push(['get',input.scopeId]),input.scopeId.includes('DSH')?[{id:'old-id',scopeId:input.scopeId,content:'old'}]:[]),
  remember:async input=>(calls.push(['remember',input.scopeId]),{ids:['saved']}),
 };
 registerTools({tools:{register(tool){tools.push(tool);return()=>{}}}},{backend,config:{scopeId:'',maxRecallItems:8,maxBytes:8000,timeoutMs:1000}},tool=>tool);
 const execution={signal:new AbortController().signal,agent:{session:{id:'s',header:{cwd:'C:/project'}}}};
 const search=await tools.find(tool=>tool.name==='oc_search').execute({query:'old'},execution);
 assert.deepEqual(search.data.hits.map(row=>row.scopeId),['local:C:/project','local:D:\\DSH Desktop','local:default']);
 const listed=await tools.find(tool=>tool.name==='oc_memory_list').execute({limit:10},execution);
 assert.equal(listed.data.items[0].scopeId,'local:D:\\DSH Desktop');
 const exact=await tools.find(tool=>tool.name==='oc_memory_get').execute({ids:['old-id']},execution);
 assert.equal(exact.data.items[0].scopeId,'local:D:\\DSH Desktop');
 await tools.find(tool=>tool.name==='oc_remember').execute({content:'new current memory'},execution);
 assert.deepEqual(calls.filter(([kind])=>kind==='remember'),[['remember','local:C:/project']]);
});

test('knowledge tools search current legacy and global scopes while skipping empty scopes',async()=>{
 const calls=[];const backend={
  compatibilityWorkspaceScopes:async()=>['local:default'],
  listDocuments:async({scopeId})=>{calls.push(['list',scopeId]);return{documents:scopeId==='local:empty'?[]:[{id:'doc-'+scopeId,filename:scopeId+'.md',chunks:1}]};},
  searchKnowledge:async({scopeId})=>{calls.push(['search',scopeId]);return{chunks:[{id:'chunk',documentId:'doc-'+scopeId,documentName:scopeId+'.md',content:scopeId,score:scopeId==='dsh-default'?.9:.8,metadata:{}}]};},
 };
 const tools=makeKnowledgeTools(backend,{scopeId:'',timeoutMs:1000,knowledgeSearchTimeoutMs:1000});
 const execution={signal:new AbortController().signal,agent:{session:{id:'s',header:{cwd:'C:/project'}}}};
 const out=await tools.find(tool=>tool.name==='knowledge_search').execute({query:'guide',limit:10,threshold:0},execution);
 assert.equal(out.ok,true);assert.deepEqual(out.data.chunks.map(row=>row.scopeId),['dsh-default','local:C:/project','local:default']);
 assert.deepEqual(calls.filter(([kind])=>kind==='search').map(([,scope])=>scope).sort(),['dsh-default','local:C:/project','local:default'].sort());
});

test('knowledge upload defaults to global scope and old document operations locate their real scope',async()=>{
 const calls=[];const backend={
  compatibilityWorkspaceScopes:async()=>['local:default'],
  uploadDocument:async input=>(calls.push(['upload',input.scopeId]),{documentId:'new',chunks:1,semanticIndexed:false,semanticPending:true}),
  listDocuments:async({scopeId})=>({documents:scopeId==='local:default'?[{id:'old',filename:'old.md',chunks:1}]:[]}),
  listDocumentChunks:async input=>(calls.push(['chunks',input.scopeId]),{document:{id:'old',filename:'old.md',chunks:1},chunks:[]}),
 };
 const tools=makeKnowledgeTools(backend,{scopeId:'',timeoutMs:1000});const execution={signal:new AbortController().signal,agent:{session:{id:'s',header:{cwd:'C:/project'}}}};
 const uploaded=await tools.find(tool=>tool.name==='knowledge_document_upload').execute({content:'content',filename:'new.md'},execution);
 assert.equal(uploaded.ok,true);assert.deepEqual(calls[0],['upload','dsh-default']);assert.equal(uploaded.data.semanticPending,true);
 const inspected=await tools.find(tool=>tool.name==='knowledge_document_chunks').execute({id:'old'},execution);
 assert.equal(inspected.ok,true);assert.deepEqual(calls.find(([kind])=>kind==='chunks'),['chunks','local:default']);
});