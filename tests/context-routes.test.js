import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
let createContextHandler;
try{({createContextHandler}=await import('../src/context/routes.js'));}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
async function call(handler,{method='GET',path='/memories?scopeId=p',body,headers={}}={}){
 const req=Readable.from(body===undefined?[]:[typeof body==='string'?body:JSON.stringify(body)]);
 req.url='/opencontext-api/context'+path;req.method=method;req.headers={host:'127.0.0.1:3333',...(method==='POST'?{'content-type':'application/json','x-agentos-context':'1',origin:'http://127.0.0.1:3333'}:{}),...headers};
 let status=200,text='';const res={setHeader(){},writeHead(s){status=s;},end(x=''){text+=x;},get statusCode(){return status;},set statusCode(s){status=s;}};
 await handler(req,res);return{status,body:text?JSON.parse(text):null};
}
function fixture(){const calls=[];const service={warnings:()=>[],listMemories:async x=>(calls.push(x),[{id:'m',scopeId:'p',content:'record'}]),saveMemory:(x,origin)=>(calls.push({x,origin}),{id:'m'}),retireMemory:async()=>{throw Object.assign(new Error('private SQL /private/file'),{code:'VERSION_CONFLICT'});}};return{calls,handler:createContextHandler(service)};}
test('handler export exists',()=>assert.equal(typeof createContextHandler,'function'));
test('GET returns structured real service data',async()=>{const f=fixture(),r=await call(f.handler);assert.equal(r.status,200);assert.equal(r.body.data.items[0].id,'m');});
test('writes reject a foreign origin before service calls',async()=>{const f=fixture(),r=await call(f.handler,{method:'POST',path:'/memories/save',body:{scopeId:'p',content:'x'},headers:{origin:'http://evil.invalid'}});assert.equal(r.status,403);assert.equal(f.calls.length,0);});
test('writes require an explicit same-origin application header',async()=>{const f=fixture(),r=await call(f.handler,{method:'POST',path:'/memories/save',body:{scopeId:'p',content:'x'},headers:{'x-agentos-context':''}});assert.equal(r.status,403);});
test('unknown authority fields never reach the service',async()=>{const f=fixture(),r=await call(f.handler,{method:'POST',path:'/memories/save',body:{scopeId:'p',content:'x',actorRole:'human',confirmed:true}});assert.equal(r.status,400);assert.equal(f.calls.length,0);});
test('valid UI save gets server-owned human origin',async()=>{const f=fixture(),r=await call(f.handler,{method:'POST',path:'/memories/save',body:{scopeId:'p',content:'x',idempotencyKey:'k'}});assert.equal(r.body.ok,true);assert.equal(f.calls[0].origin.actorRole,'human');});
test('revision errors are safe and semantically classified',async()=>{const f=fixture(),r=await call(f.handler,{method:'POST',path:'/memories/retire',body:{scopeId:'p',id:'m',expectedRevision:1,reason:'r'}});assert.equal(r.status,409);assert.equal(r.body.code,'VERSION_CONFLICT');assert.ok(!JSON.stringify(r).includes('/private/file'));});
test('arrays and invalid JSON bodies are rejected',async()=>{const f=fixture();for(const body of [[],null,'{bad'])assert.equal((await call(f.handler,{method:'POST',path:'/memories/save',body})).status,400);});
test('unknown routes do not claim success',async()=>{const f=fixture();assert.equal((await call(f.handler,{path:'/missing'})).status,404);});
