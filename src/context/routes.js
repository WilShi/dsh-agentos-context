/** Same-origin UI data plane. Authentication stays with the existing DSH webServer. */
const BASE='/opencontext-api/context';
const MAX_BODY=128*1024;
const MESSAGES={INVALID_INPUT:'请求字段不正确，请检查输入。',NOT_FOUND:'没有可访问的记录。',VERSION_CONFLICT:'内容已被更新，请刷新后重新核对。',IDEMPOTENCY_CONFLICT:'本次操作编号已用于不同内容。',ENTITY_CONFLICT:'该类型已存在相同名称或别名。',TYPE_MISMATCH:'不同类型的对象不能合并。',MERGE_CONFLICT:'合并会破坏现有关系，请先处理冲突。',INVALID_RELATION:'关系不符合类型定义。',INVALID_EVIDENCE:'引用必须是来源中的原文片段。',EVIDENCE_REQUIRED:'确认关系前请补充来源和原文。',INVALID_REFERENCE:'引用的记录当前不可用。',INVALID_TRANSITION:'当前状态不允许该操作。',SECRET_REJECTED:'内容疑似包含凭据，已拒绝保存。',LIMIT_EXCEEDED:'达到本次处理上限，请缩小范围。',STORE_CLOSED:'记忆服务已停止。',STORE_UNAVAILABLE:'记忆存储暂不可用。',STORE_FAILURE:'记忆操作未完成，请稍后重试。',ABORTED:'操作已取消。'};
const err=(code,status)=>Object.assign(new Error(code),{code,status});
function reply(res,status,payload){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(payload));}
function object(body,allowed){if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)||['__proto__','constructor','prototype'].includes(k)))throw err('INVALID_INPUT',400);return body;}
function query(url,allowed){const out={};for(const [k,v]of url.searchParams){if(!allowed.includes(k)||Object.hasOwn(out,k))throw err('INVALID_INPUT',400);if(['limit','depth','knownAt','validAt'].includes(k)){const n=Number(v);if(!v||!Number.isSafeInteger(n)||n<0)throw err('INVALID_INPUT',400);out[k]=n;}else if(k==='includePending'){if(!['true','false'].includes(v))throw err('INVALID_INPUT',400);out[k]=v==='true';}else out[k]=v;}return out;}
async function readBody(req){let size=0;const chunks=[];for await(const chunk of req){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=b.length;if(size>MAX_BODY)throw err('LIMIT_EXCEEDED',413);chunks.push(b);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw err('INVALID_INPUT',400);}}
const writeKeys={
 '/memories/save':['scopeId','content','kind','layer','importance','expiresAt','metadata','idempotencyKey','validFrom','validTo','entityIds'],
 '/memories/revise':['scopeId','id','expectedRevision','content','kind','layer','importance','expiresAt','reason','validFrom','validTo'],
 '/memories/transition':['scopeId','id','expectedRevision','layer','importance','expiresAt','reason'],
 '/memories/retire':['scopeId','id','expectedRevision','reason'],
 '/entities/create':['scopeId','name','type','aliases'],
 '/entities/merge':['scopeId','keepId','mergeId','keepRevision','mergeRevision','reason'],
 '/relations/create':['scopeId','subjectId','predicate','objectId','sourceId','sourceMemoryId','quote','validFrom','validTo'],
 '/relations/review':['scopeId','id','expectedRevision','decision','reason'],
 '/schema/check':['scopeId','subjectId','predicate','objectId','sourceId','quote','validFrom','validTo'],
 '/usage/policy':['sessionId','scopeId','memoryId','mode','paused','expectedRevision'],
};
const readKeys={
 '/bootstrap':['sessionId'], '/scopes':[],
 '/memories':['scopeId','query','lifecycle','epistemic','layer','limit','knownAt','validAt'],
 '/memory':['scopeId','id','knownAt','validAt'], '/versions':['scopeId','id'],
 '/entities':['scopeId','query','limit'],
 '/graph':['scopeId','rootId','depth','includePending','limit','knownAt','validAt'],
 '/reviews':['scopeId'], '/schema':[], '/usage':['scopeId','sessionId','limit'], '/changes':['scopeId','limit'],
};
export function createContextHandler(service){return async function contextHandler(req,res){
 let sub;
 try{
  const host=typeof req.headers?.host==='string'?req.headers.host:'localhost';
  const base=new URL('http://'+host);const url=new URL(req.url??'/',base);
  if(url.origin!==base.origin)throw err('INVALID_INPUT',400);
  sub=url.pathname.slice(BASE.length)||'/';
  if(req.method==='GET'){
   if(!Object.hasOwn(readKeys,sub)){reply(res,Object.hasOwn(writeKeys,sub)?405:404,{ok:false,code:'NOT_FOUND',message:'接口不可用。'});return;}
   const x=query(url,readKeys[sub]);let data;
   switch(sub){
    case '/bootstrap':data=await service.bootstrap(x.sessionId);break;
    case '/scopes':data={items:await service.listScopes()};break;
    case '/memories':data={items:await service.listMemories(x)};break;
    case '/memory':{const item=await service.getMemory(x);if(!item)throw err('NOT_FOUND',404);data={item};break;}
    case '/versions':data={items:await service.versions(x)};break;
    case '/entities':data={items:service.listEntities(x)};break;
    case '/graph':data=await service.graph(x);break;
    case '/reviews':data={items:service.listReviews(x)};break;
    case '/schema':data=service.schema();break;
    case '/usage':data=service.usage(x);break;
    case '/changes':data={items:service.changes(x)};break;
   }
   reply(res,200,{ok:true,data,warnings:service.warnings?.()??[]});return;
  }
  if(req.method!=='POST'){reply(res,405,{ok:false,code:'METHOD_NOT_ALLOWED',message:'请求方法不受支持。'});return;}
  if(!Object.hasOwn(writeKeys,sub)){reply(res,Object.hasOwn(readKeys,sub)?405:404,{ok:false,code:'NOT_FOUND',message:'接口不可用。'});return;}
  if(req.headers['x-agentos-context']!=='1')throw err('FORBIDDEN',403);
  const origin=req.headers.origin;
  if(typeof origin!=='string'||origin!==base.origin)throw err('FORBIDDEN',403);
  if(req.headers['content-type']?.split(';')[0]?.trim().toLowerCase()!=='application/json')throw err('INVALID_INPUT',415);
  const input=object(await readBody(req),writeKeys[sub]);let data;
  if(req.aborted)throw err('ABORTED',409);
  switch(sub){
   case '/memories/save':data={item:service.saveMemory(input,{actorRole:'human',kind:'manual'})};break;
   case '/memories/revise':data={item:await service.reviseMemory(input,{actorRole:'human'})};break;
   case '/memories/transition':data={item:await service.transitionMemory(input)};break;
   case '/memories/retire':data={item:await service.retireMemory(input)};break;
   case '/entities/create':data={item:service.createEntity(input)};break;
   case '/entities/merge':data={item:service.mergeEntities(input)};break;
   case '/relations/create':data={item:await service.createRelation(input)};break;
   case '/relations/review':data={item:service.reviewRelation(input)};break;
   case '/schema/check':data=service.validateRelation(input);break;
   case '/usage/policy':data={policy:await service.setUsagePolicy(input)};break;
  }
  reply(res,200,{ok:true,data,warnings:service.warnings?.()??[]});
 }catch(error){
  const code=Object.hasOwn(MESSAGES,error?.code)?error.code:error?.code==='FORBIDDEN'?'FORBIDDEN':'INTERNAL_ERROR';
  const status=error?.status??(code==='VERSION_CONFLICT'||code==='IDEMPOTENCY_CONFLICT'?409:code==='NOT_FOUND'?404:code.startsWith('STORE_')||code==='INTERNAL_ERROR'?503:400);
  reply(res,status,{ok:false,code,message:MESSAGES[code]??(code==='FORBIDDEN'?'请求来源不允许执行此操作。':'操作未完成，请稍后重试。'),...(typeof error.field==='string'&&/^[\w.[\]-]{1,100}$/.test(error.field)?{field:error.field}:{})});
 }
};}
