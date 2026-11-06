import test from 'node:test';
import assert from 'node:assert/strict';
let createUsageTracker;
try{({createUsageTracker}=await import('../src/context/usage.js'));}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
function setup(){
 const handlers=new Map(),records=[];
 const ctx={on(n,f){handlers.set(n,f);return()=>handlers.delete(n);},logger:{warn(){}}};
 const store={recordUsage(x){const r=structuredClone(x);records.push(r);return r;},listUsage({sessionId,scopeId}){return records.filter(r=>r.sessionId===sessionId&&(!scopeId||r.scopeId===scopeId));},updateUsage(x){const r=records.find(r=>r.id===x.id);Object.assign(r,x);return r;}};
 return{handlers,records,tracker:createUsageTracker(ctx,store)};
}
test('usage tracker export exists',()=>assert.equal(typeof createUsageTracker,'function'));
test('accepted plugin message commits only its own planned usage',()=>{
 assert.equal(typeof createUsageTracker,'function');const {tracker,handlers,records}=setup();
 const r=tracker.plan({sessionId:'s',scopeId:'p',turn:1,step:1,items:[{id:'m',revision:1,content:'fact'}]});
 assert.equal(r.phase,'planned');tracker.bindMessage(r.id,'recall-message-1');
 handlers.get('session/event')({id:'s'},{type:'user/message',seq:7,time:100,data:{id:'recall-message-1',source:{kind:'agentos-context',form:'recall'}}});
 assert.equal(records[0].phase,'committed');
});
test('human content and foreign session cannot forge usage commit',()=>{
 const {tracker,handlers,records}=setup();const r=tracker.plan({sessionId:'s',scopeId:'p',turn:1,step:1,items:[]});
 tracker.bindMessage(r.id,'recall-message-2');const msg={id:'recall-message-2',source:{kind:'user'}};
 handlers.get('session/event')({id:'s'},{type:'user/message',data:msg});
 handlers.get('session/event')({id:'other'},{type:'user/message',data:{...msg,source:{kind:'agentos-context',form:'recall'}}});
 assert.equal(records[0].phase,'planned');
});
test('model attempt starts mark only committed same-step context requested',()=>{
 const {tracker,handlers,records}=setup();const a=tracker.plan({sessionId:'s',scopeId:'p',turn:1,step:1,items:[]});
 tracker.plan({sessionId:'s',scopeId:'p',turn:1,step:2,items:[]});tracker.bindMessage(a.id,'recall-message-3');
 handlers.get('session/event')({id:'s'},{type:'user/message',seq:2,time:Date.now(),data:{id:'recall-message-3',source:{kind:'agentos-context',form:'recall'}}});
 handlers.get('agent/assistant-stream')({agent:{session:{id:'s'}},frame:{type:'start',turn:1,step:1}});
 assert.equal(records[0].phase,'requested');assert.equal(records[1].phase,'planned');
});
test('message correlation is released after the committed session event',()=>{const {tracker,handlers}=setup();const a=tracker.plan({sessionId:'s',scopeId:'p',turn:1,step:1,items:[]});tracker.bindMessage(a.id,'repeat-message');handlers.get('session/event')({id:'s'},{type:'user/message',seq:1,time:Date.now(),data:{id:'repeat-message',source:{kind:'agentos-context',form:'recall'}}});const b=tracker.plan({sessionId:'s',scopeId:'p',turn:2,step:1,items:[]});assert.doesNotThrow(()=>tracker.bindMessage(b.id,'repeat-message'));});
test('disposed tracker unsubscribes and rejects new plans',()=>{
 const {tracker,handlers}=setup();tracker.dispose();assert.equal(handlers.size,0);
 assert.throws(()=>tracker.plan({sessionId:'s',scopeId:'p',items:[]}));
});
