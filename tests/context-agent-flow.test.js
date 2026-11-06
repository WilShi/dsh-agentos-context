import test from 'node:test';
import assert from 'node:assert/strict';
import {createContextStore} from '../src/context/store.js';
import {createContextService} from '../src/context/service.js';
import {createBackendBridge} from '../src/context/backend-bridge.js';
import {createUsageTracker} from '../src/context/usage.js';
import {registerRecall} from '../src/recall.js';

function runtime(store){
 const listeners=new Map();
 const ctx={on(name,fn){listeners.set(name,fn);return()=>listeners.delete(name)},logger:{warn(){}}};
 return{listeners,tracker:createUsageTracker(ctx,store)};
}

test('saved memory travels through recall and actual request lifecycle',async()=>{
 const store=createContextStore({dbPath:':memory:'});
 const service=createContextService({store,legacy:{list:async()=>[],get:async()=>[],search:async()=>[],dispose:async()=>{}},config:{ontologyEnabled:true,recallEnabled:true},defaultScope:()=> 'local:C:/project'});
 const backend=createBackendBridge({service,legacy:{mode:'lib',dispose:async()=>{}},defaultScope:()=> 'local:C:/project'});
 service.saveMemory({scopeId:'local:C:/project',content:'deployment requires explicit confirmation',kind:'constraint'},{actorRole:'human',kind:'manual'});
 const {listeners,tracker}=runtime(store);let recall;
 registerRecall({on(_name,fn){recall=fn;return()=>{}},logger:{warn(){}}},backend,{scopeId:'',recallEnabled:true,maxRecallItems:8,maxBytes:8000,requestTimeoutMs:1000},{usage:tracker});
 const session={id:'session-1',header:{id:'session-1',cwd:'C:/project'}},question={id:'q',role:'user',source:{kind:'user'},content:[{type:'text',text:'explicit confirmation'}]};
 const result=await recall({agent:{session},messages:[question],turn:1,step:1},async()=>({kind:'enter',messages:[question]}));
 const inserted=result.messages.at(-1);assert.equal(inserted.source.kind,'agentos-context');assert.equal(inserted.source.form,'recall');assert.equal(Object.hasOwn(inserted.source,'plugin'),false);assert.equal(Object.hasOwn(inserted,'meta'),false);assert.match(inserted.content[0].text,/deployment requires explicit confirmation/);
 const planned=store.listUsage({sessionId:'session-1'})[0];assert.equal(planned.phase,'planned');assert.equal(planned.messageId,inserted.id);
 listeners.get('session/event')(session,{type:'user/message',seq:2,time:Date.now()+1000,data:inserted});assert.equal(store.listUsage({sessionId:'session-1'})[0].phase,'committed');
 listeners.get('agent/assistant-stream')({agent:{session},frame:{type:'start',turn:1,step:1}});assert.equal(store.listUsage({sessionId:'session-1'})[0].phase,'requested');
 tracker.dispose();await service.close();
});

test('real recall combines current workspace and global memory with a valid trace',async()=>{
 const store=createContextStore({dbPath:':memory:'});
 const legacy={list:async()=>[],get:async()=>[],search:async()=>[],dispose:async()=>{}};
 const config={ontologyEnabled:true,recallEnabled:true};
 const service=createContextService({store,legacy,config,defaultScope:()=> 'local:C:/project'});
 const backend=createBackendBridge({service,legacy,config,defaultScope:()=> 'local:C:/project'});
 service.saveMemory({scopeId:'local:C:/project',content:'release requires workspace approval',kind:'constraint'},{actorRole:'human',kind:'manual'});
 service.saveMemory({scopeId:'dsh-default',content:'release notes should always be concise',kind:'preference'},{actorRole:'human',kind:'manual'});
 const {tracker}=runtime(store);let recall;
 registerRecall({on(_name,fn){recall=fn;return()=>{}},logger:{warn(){}}},backend,{scopeId:'',recallEnabled:true,maxRecallItems:8,maxBytes:8000,requestTimeoutMs:1000},{usage:tracker});
 const session={id:'session-global',header:{cwd:'C:/project'}},question={id:'q-global',role:'user',source:{kind:'user'},content:[{type:'text',text:'release'}]};
 const result=await recall({agent:{session},messages:[question],turn:1,step:1},async()=>({kind:'enter',messages:[question]}));
 const text=result.messages.at(-1).content[0].text;assert.match(text,/workspace approval/);assert.match(text,/always be concise/);
 const scopes=store.listUsage({sessionId:'session-global'})[0].items.map(item=>item.scopeId??'local:C:/project').sort();assert.deepEqual(scopes,['dsh-default','local:C:/project']);
 tracker.dispose();await service.close();
});

test('real multidimensional recall isolates run memory and shares user app and agent memory across workspaces',async()=>{
 const store=createContextStore({dbPath:':memory:'}),legacy={list:async()=>[],get:async()=>[],search:async()=>[],dispose:async()=>{}},config={ontologyEnabled:true,recallEnabled:true,scopeUserId:'demo',scopeAppId:'desktop'};
 const service=createContextService({store,legacy,config,defaultScope:()=> 'local:C:/one'}),backend=createBackendBridge({service,legacy,config,defaultScope:()=> 'local:C:/one'}),{tracker}=runtime(store);let recall;
 registerRecall({on(_name,fn){recall=fn;return()=>{}},logger:{warn(){}}},backend,{...config,scopeId:'',maxRecallItems:12,maxBytes:12000,requestTimeoutMs:1000},{usage:tracker});
 for(const [scopeId,content,layer] of [['run:one','shared run one','working'],['agent:coding','shared agent','semantic'],['local:C:/one','shared workspace one','semantic'],['user:demo','shared user','semantic'],['app:desktop','shared app','semantic'],['dsh-default','shared global','semantic']])service.saveMemory({scopeId,content,kind:'fact',layer},{actorRole:'human',kind:'manual'});
 const ask=async(id,cwd)=>{const session={id,header:{id,cwd,agentPreset:'coding'}},question={id:'q-'+id,role:'user',source:{kind:'user'},content:[{type:'text',text:'shared'}]};return recall({agent:{session},messages:[question],turn:1,step:1},async()=>({kind:'enter',messages:[question]}));};
 const first=await ask('one','C:/one'),firstText=first.messages.at(-1).content[0].text;for(const phrase of ['shared run one','shared agent','shared workspace one','shared user','shared app','shared global'])assert.match(firstText,new RegExp(phrase));
 const second=await ask('two','D:/two'),secondText=second.messages.at(-1).content[0].text;assert.doesNotMatch(secondText,/shared run one|shared workspace one/);for(const phrase of ['shared agent','shared user','shared app','shared global'])assert.match(secondText,new RegExp(phrase));
 tracker.dispose();await service.close();
});

test('usage message correlation survives tracker restart',()=>{
 const store=createContextStore({dbPath:':memory:'}),saved=store.saveMemory({scopeId:'p',content:'fact'});
 const first=runtime(store);first.tracker.plan({sessionId:'s',scopeId:'p',messageId:'recall-message',turn:1,step:1,items:[{id:saved.id,revision:saved.revision,content:saved.content,sourceId:saved.sourceId,kind:saved.kind}]});first.tracker.dispose();
 const second=runtime(store);second.listeners.get('session/event')({id:'s'},{type:'user/message',seq:1,time:Date.now()+1000,data:{id:'recall-message',source:{kind:'agentos-context',form:'recall'}}});
 const usage=store.listUsage({sessionId:'s'})[0];assert.equal(usage.phase,'committed');assert.equal(usage.messageId,'recall-message');second.tracker.dispose();store.close();
});