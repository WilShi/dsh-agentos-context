/** Preserve oc_* method shapes while routing memory authority through the shared context service. */
import {createHash} from 'node:crypto';
const error=(code,message)=>Object.assign(new Error(message),{code});
const kinds=new Set(['fact','decision','preference','constraint','outcome','plan','note']);
const trustKeys=new Set(['actorRole','sourceActorRole','authorityKind','confirmed','epistemic','lifecycle','scopeId','sourceId','policyRevision']);
const untrustedMetadata=value=>Object.fromEntries(Object.entries(value&&typeof value==='object'&&!Array.isArray(value)?value:{}).filter(([key])=>!trustKeys.has(key)));
function checkSignal(opts){if(opts?.signal?.aborted)throw error('ABORTED','操作已取消');}
const DAY=24*60*60*1000;
function placementFor(input,trusted,config){
 if(config.memoryLayeringEnabled===false)return{layer:'semantic',expiresAt:null,importance:trusted?.importance??.7};
 const sourceType=String(input?.sourceType??'');const category=String(input?.metadata?.category??'');
 let layer=trusted?.layer;
 if(layer===undefined){
  if(sourceType==='tool-interaction'||sourceType==='turn-summary'||sourceType==='task-outcome')layer='episodic';
  else if(sourceType==='user_input')layer='working';
  else if(sourceType==='insight'&&/(?:procedure|workflow|playbook|lesson|pattern|方法|流程|经验)/iu.test(category))layer='procedural';
  else layer='semantic';
 }
 const now=Date.now(),workingHours=Number.isFinite(config.workingMemoryHours)?Math.max(1,Math.min(168,config.workingMemoryHours)):24,episodicDays=Number.isFinite(config.episodicMemoryDays)?Math.max(1,Math.min(3650,config.episodicMemoryDays)):90;
 const expiresAt=trusted?.expiresAt!==undefined?trusted.expiresAt:layer==='working'?now+workingHours*60*60*1000:layer==='episodic'?now+episodicDays*DAY:null;
 const importance=trusted?.importance!==undefined?trusted.importance:layer==='working'?.35:layer==='episodic'?.55:layer==='procedural'?.8:.7;
 return{layer,expiresAt,importance};
}
function reinforcementPlacement(memory,config){
 const count=(Number.isSafeInteger(memory?.metadata?.evidenceCount)&&memory.metadata.evidenceCount>0?memory.metadata.evidenceCount:1)+1;
 const durable=kinds.has(memory?.kind)&&memory.kind!=='note'&&memory.kind!=='outcome';
 if(memory?.layer==='working'&&count>=2)return placementFor({sourceType:'turn-summary'},{layer:'episodic',importance:Math.min(1,(memory.importance??.35)+.12)},config);
 if(memory?.layer==='episodic'&&count>=3&&durable)return{layer:'semantic',importance:Math.min(1,(memory.importance??.55)+.12),expiresAt:null};
 return{layer:memory?.layer??'semantic',importance:Math.min(1,(memory?.importance??.5)+.05),expiresAt:memory?.expiresAt??null};
}
export function createBackendBridge({service,legacy,defaultScope,config={}}){
 const scopeOf=input=>input?.scopeId||input?.userId||defaultScope();
 const bridge={...legacy,mode:legacy?.mode??'lib'};
  bridge.search=async(input={},opts)=>{checkSignal(opts);return service.search({...input,scopeId:scopeOf(input)},opts);};
  bridge.compatibilityWorkspaceScopes=async(scopeId)=>service.compatibilityWorkspaceScopes(scopeId);
 bridge.list=async(input={},opts)=>{checkSignal(opts);const rows=await service.listMemories({...input,scopeId:scopeOf(input),lifecycle:'active'},opts);return rows.filter(r=>input.since===undefined||(r.recordedAt??0)>=input.since).map(r=>({...r,timestamp:r.recordedAt??undefined}));};
 bridge.get=async(input={},opts)=>{checkSignal(opts);const rows=[];for(const id of input.ids??[]){const row=await service.getMemory({scopeId:scopeOf(input),id},opts);if(row)rows.push({...row,timestamp:row.recordedAt??undefined});}return rows;};
 bridge.remember=async(input={},opts)=>{
  checkSignal(opts);
  const trusted=opts?.captureOrigin;
  const origin=trusted?{actorRole:trusted.actorRole??'unknown',kind:trusted.kind??'capture',sourceActorRole:trusted.sourceActorRole??'unknown',sourceContent:trusted.sourceContent??input.content,complete:trusted.complete!==false,...(typeof trusted.lineageId==='string'?{lineageId:trusted.lineageId}:{})}:{actorRole:'tool',kind:input.sourceType??'tool-record',complete:true};
  const category=input.metadata?.category;
  const key=trusted?.lineageId?'capture:'+createHash('sha256').update(scopeOf(input)+'|'+trusted.lineageId+'|'+input.content).digest('hex'):undefined;
  const scopeId=scopeOf(input),kind=kinds.has(input.kind)?input.kind:kinds.has(category)?category:input.sourceType==='task-outcome'?'outcome':'note';
  const placement=placementFor(input,trusted,config),metadata={...untrustedMetadata(input.metadata),sourceType:input.sourceType??'tool-record'};
  if(config.autoConsolidate!==false&&config.dedupEnabled===true&&typeof service.search==='function'&&typeof input.content==='string'){
   try{
    const normalized=input.content.trim().replace(/\s+/gu,' ').toLocaleLowerCase();
    const literal=await service.listMemories({scopeId,query:input.content,lifecycle:'active',limit:50},opts);
    const exact=literal.find(row=>!row.legacy&&typeof row.content==='string'&&row.content.trim().replace(/\s+/gu,' ').toLocaleLowerCase()===normalized);
    const sameCapture=exact&&typeof metadata.captureId==='string'&&exact.metadata?.captureId===metadata.captureId;
    if(exact&&!sameCapture&&typeof service.reinforceMemory==='function'){
     const result=await service.reinforceMemory({scopeId,id:exact.id,expectedRevision:exact.revision,...reinforcementPlacement(exact,config),reason:'Repeated supporting observation.'},origin,opts);
     return{ids:[result.id],revision:result.revision,deduped:'reinforced'};
    }
    const hits=await service.search({scopeId,query:input.content,sessionId:metadata.sessionId,limit:8,threshold:config.dedupReviseThreshold??.85},opts);
    const near=hits.find(row=>!row.legacy&&row.score>=(config.dedupReviseThreshold??.85));
    if(near){metadata.candidateFor=near.id;origin.lifecycle='candidate';}
   }catch{/* consolidation must never block a memory write */}
  }
  const sessionId=typeof input.sessionId==='string'&&input.sessionId?input.sessionId:(typeof metadata.sessionId==='string'?metadata.sessionId:undefined);
  // The session id lets the service authorize a trusted identity scope without
  // weakening workspace access (HOST-REVIEW H2).
  const result=service.saveMemory({scopeId,content:input.content,kind,metadata,...placement,...(sessionId?{sessionId}:{}),...(key?{idempotencyKey:key}:{})}, {...origin,...placement});
  return {ids:[result.id],revision:result.revision};
 };
 bridge.captureSource=async(input,opts)=>{const result=await bridge.remember(input,opts);return{id:result.ids[0]};};
 bridge.captureOntologyCandidates=async(input={},opts)=>{
  checkSignal(opts);
  return service.captureOntologyCandidates({...input,scopeId:scopeOf(input)},opts);
 };
 bridge.revise=async(input={},opts)=>{
  checkSignal(opts);const scopeId=scopeOf(input);const old=await service.getMemory({scopeId,id:input.id},opts);
  if(!old)throw error('NOT_FOUND','没有可访问的记忆');checkSignal(opts);
  const updated=await service.reviseMemory({scopeId,id:input.id,expectedRevision:input.expectedRevision??old.revision,content:input.content,reason:input.reason||'通过记忆工具修订',...(typeof input.sessionId==='string'&&input.sessionId?{sessionId:input.sessionId}:{})}, {...opts,actorRole:'tool'});
  return {deprecatedId:input.id,newId:updated.id,revision:updated.revision};
 };
 bridge.retire=async(input={},opts)=>{
  checkSignal(opts);const scopeId=scopeOf(input),old=await service.getMemory({scopeId,id:input.id},opts);
  if(!old)throw error('NOT_FOUND','没有可访问的记忆');checkSignal(opts);
  const updated=await service.retireMemory({scopeId,id:input.id,expectedRevision:input.expectedRevision??old.revision,reason:input.reason||'通过记忆工具停止召回',...(typeof input.sessionId==='string'&&input.sessionId?{sessionId:input.sessionId}:{})},opts);
  return {ok:true,revision:updated.revision};
 };
 bridge.captureInsight=async(input={},opts)=>{const out=await bridge.remember({...input,sourceType:'insight',metadata:{...input.metadata,category:input.category}},opts);return{id:out.ids[0]};};
 bridge.searchInsights=async(input={},opts)=>{const limit=Number.isSafeInteger(input.limit)?Math.max(1,Math.min(50,input.limit)):10;const rows=await bridge.search({...input,limit:50},opts);return{insights:rows.filter(r=>(input.since===undefined||(r.recordedAt??r.timestamp??0)>=input.since)&&(!input.categories?.length||input.categories.includes(r.metadata?.category??r.kind))).slice(0,limit).map(r=>({id:r.id,content:r.content,category:r.metadata?.category??r.kind??'note',score:r.score??0,timestamp:r.recordedAt??r.timestamp??null,metadata:r.metadata??{}}))};};
 bridge.health=async()=>{try{service.store.listScopes();return{ok:true,mode:bridge.mode,details:'agentOS context sidecar ready; legacy compatibility is checked lazily on read'};}catch{return{ok:false,mode:bridge.mode,details:'agentOS context storage unavailable'};}};
 bridge.dispose=async()=>{const results=await Promise.allSettled([Promise.resolve().then(()=>service.close?.()),Promise.resolve().then(()=>legacy?.dispose?.())]);const failed=results.find(x=>x.status==='rejected');if(failed?.status==='rejected')throw failed.reason;};
 return bridge;
}
