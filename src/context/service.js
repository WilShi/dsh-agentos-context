/** One authority for the new UI, compatibility tools and recall. Legacy reads never migrate data. */
import {prepareKnowledgeDocument} from '../document-parser.js';
import {containsSecret} from '../secrets.js';
import {withGraphCommunities} from './communities.js';
import {GLOBAL_SCOPE_ID,createEntityScope,resolveContextIdentity,resolveContextScope,scopeKind} from './scope.js';
const KINDS=new Set(['fact','decision','preference','constraint','outcome','plan','note']);
const TRUST_METADATA_KEYS=new Set(['actorRole','sourceActorRole','authorityKind','confirmed','epistemic','lifecycle','scopeId','sourceId','policyRevision']);
const LEGACY_PAGE_SIZE=500;
const LEGACY_SCOPE_SCAN_LIMIT=100000;
// The graph workbench is designed for a complete workspace-scale projection.
// Keep a hard safety bound, but do not silently collapse a normal 1k-memory
// workspace to the former 200-node transport cap.
const GRAPH_LIMIT=2000;
const DOCUMENT_LIST_LIMIT=200;
const LEGACY_SEARCH_SCAN_LIMIT=5000;
const LEGACY_APP_SCOPE_BASENAMES=new Set(['dsh desktop']);
const fail=(code,message)=>Object.assign(new Error(message),{code});
const throwIfAborted=opts=>{if(opts?.signal?.aborted)throw fail('ABORTED','操作已取消');};
const MAX_SCOPE_ID_LENGTH=256; // keep in sync with validation.js identifier()
export function safeScope(value){if(typeof value!=='string'||!value.trim()||value.length>MAX_SCOPE_ID_LENGTH||value.includes('\0'))throw fail('INVALID_INPUT','请选择有效的记忆范围');return value.trim();}
export function cleanMetadata(value,depth=0){
 if(value===undefined||value===null)return {};
 if(depth>8)throw fail('INVALID_INPUT','元数据层级过深');
 if(Array.isArray(value)){if(value.length>1000)throw fail('INVALID_INPUT','元数据过大');return value.map(x=>typeof x==='object'&&x!==null?cleanMetadata(x,depth+1):x);}
 if(typeof value!=='object')throw fail('INVALID_INPUT','元数据必须是对象');
 const out={};const entries=Object.entries(value);if(entries.length>200)throw fail('INVALID_INPUT','元数据字段过多');
 for(const [key,v]of entries){
  if(['__proto__','prototype','constructor'].includes(key)||TRUST_METADATA_KEYS.has(key))continue;
  if(typeof v==='string')out[key]=v.slice(0,32768);
  else if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))out[key]=v;
  else if(v&&typeof v==='object')out[key]=cleanMetadata(v,depth+1);
 }
 return out;
}
export function scopeOf(row){return row?.userId||row?.scopeId||row?.metadata?.scopeId||'legacy:unknown';}
function normalizedScopePath(scopeId){return typeof scopeId==='string'&&scopeId.startsWith('local:')?scopeId.slice(6).replace(/[\\/]+$/u,''):'';}
function isLegacyApplicationScope(scopeId,candidates=[]){
 if(scopeId==='local:default')return true;
 if(candidates.includes(scopeId))return true;
 const path=normalizedScopePath(scopeId);if(!path)return false;
 const basename=path.split(/[\\/]/u).at(-1)?.toLocaleLowerCase();
 return LEGACY_APP_SCOPE_BASENAMES.has(basename)||/[\\/]windows[\\/]system32$/iu.test(path);
}
function legacyMemory(row){
 const scopeId=scopeOf(row),metadata=cleanMetadata(row.metadata??{}),sourceText=typeof metadata.sourceText==='string'?metadata.sourceText:row.content;
 return {id:row.id,revision:1,scopeId,content:row.content,kind:KINDS.has(metadata.category)?metadata.category:'note',layer:'semantic',importance:.5,expiresAt:null,promotedFrom:null,lifecycle:'active',epistemic:'unverified',sourceId:'legacy-source:'+row.id,source:{id:'legacy-source:'+row.id,scopeId,content:sourceText,kind:'legacy',actorRole:'unknown',complete:false,recordedAt:row.timestamp??null,lineageId:'legacy:'+row.id},recordedAt:row.timestamp??null,timestamp:row.timestamp??null,validFrom:null,validTo:null,metadata,legacy:true};
}
const temporal=x=>x?.knownAt!==undefined||x?.validAt!==undefined;
const limitOf=x=>Number.isSafeInteger(x)&&x>0?Math.min(x,500):100;
function active(row,at=Date.now()){return row&&row.lifecycle==='active'&&!['contested','refuted'].includes(row.epistemic)&&(row.expiresAt===undefined||row.expiresAt===null||row.expiresAt>at);}
function warnKnowledge(operation,error){
 const code=typeof error?.code==='string'?error.code:'UNKNOWN';
 const message=typeof error?.message==='string'?error.message:String(error);
 console.warn(`[agentos-context] knowledge ${operation} failed (${code}): ${message}`);
}
function layerOf(row){return row?.layer??'semantic';}
function lexicalLegacyScore(query,content){
 const q=String(query??'').normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu,' ').trim(),text=String(content??'').normalize('NFKC').toLocaleLowerCase();
 if(!q||!text)return 0;if(text.includes(q))return .8;
 const terms=new Set(q.split(/[^\p{L}\p{N}]+/u).filter(term=>term.length>=2&&term.length<=32));
 for(const run of q.match(/[\p{Script=Han}]{2,}/gu)??[])for(let index=0;index<run.length-1;index++)terms.add(run.slice(index,index+2));
 if(!terms.size)return 0;let matches=0;for(const term of terms)if(text.includes(term))matches++;
 return matches?Math.min(.79,.35+.45*matches/terms.size):0;
}
const MEMORY_STOP_WORDS=new Set(['a','an','and','are','as','at','be','been','being','by','can','could','did','do','does','for','from','had','has','have','how','if','in','into','is','it','its','may','might','of','on','or','should','that','the','their','them','there','these','they','this','those','to','was','were','what','when','where','which','who','why','will','with','would']);
function lexicalTerms(query){
 const normalized=String(query??'').normalize('NFKC').toLocaleLowerCase();
 const terms=new Set();
 for(const term of normalized.split(/[^\p{L}\p{N}]+/u)){
  if(term.length<2||term.length>64||MEMORY_STOP_WORDS.has(term))continue;
  terms.add(term);
  if(/^[a-z]+ies$/u.test(term)&&term.length>4)terms.add(term.slice(0,-3)+'y');
  else if(/^[a-z]+s$/u.test(term)&&term.length>3&&!term.endsWith('ss'))terms.add(term.slice(0,-1));
 }
 for(const run of normalized.match(/[\p{Script=Han}]{2,}/gu)??[]){
  if(run.length<=16)terms.add(run);
  for(let index=0;index<run.length-1;index++)terms.add(run.slice(index,index+2));
 }
 return [...terms].sort((a,b)=>b.length-a.length).slice(0,24);
}
function coverageQuery(query){
 const normalized=String(query??'').normalize('NFKC').toLocaleLowerCase();
 return /(?:有哪些|哪些|多少|全部|所有|列出|分别|几个|几次)/u.test(normalized)||/\b(?:how many|how often|list all|which|what (?:books?|items?|instruments?|activities|events?|places?|types?|kinds?|ways?|fields?|changes|symbols?|artists?|bands?|pets?|names?|subjects?|things?)|what kind|what type|where has)\b/u.test(normalized);
}
function semanticQueries(query){
 const raw=String(query??'').trim(),coverageFocused=raw.normalize('NFKC').toLocaleLowerCase().replace(/(?:请问|请帮我|帮我|告诉我|有哪些|哪些|多少|全部|所有|列出|分别|几个|几次)/gu,' ').replace(/[?？!！,，。；;：:]+/gu,' ').replace(/\s+/gu,' ').trim();
 const focused=/\p{Script=Han}/u.test(coverageFocused)?coverageFocused:lexicalTerms(coverageFocused||raw).slice(0,12).join(' ');
 if(!coverageQuery(raw)||!focused||focused===raw.toLocaleLowerCase()||focused.length<4)return[raw];
 return[raw,focused];
}
function retrievalGroup(row){
 const metadata=row?.metadata??{};
 const group=metadata.sessionId??metadata.session??metadata.date;
 return group===undefined||group===null||group===''?`memory:${row.id}`:`session:${String(group)}`;
}
function diversifyMemoryResults(rows,limit,query){
 if(!coverageQuery(query)||rows.length<=limit)return rows.slice(0,limit);
 const groups=new Map();
 for(const row of rows){const key=retrievalGroup(row),group=groups.get(key)??[];group.push(row);groups.set(key,group);}
 if(groups.size>=rows.length*.8)return rows.slice(0,limit);
 const result=[];
 for(let depth=0;result.length<limit;depth++){
  let added=false;
  for(const group of groups.values())if(group[depth]){result.push(group[depth]);added=true;if(result.length>=limit)break;}
  if(!added)break;
 }
 return result;
}
function usableInSession(row,sessionId){return layerOf(row)!=='working'||(typeof sessionId==='string'&&(row.metadata?.sessionId===sessionId||row.scopeId===createEntityScope('run',sessionId)));}
function rankOf(row,retrievalScore,modes){
 const layerBoost={working:.08,episodic:.05,semantic:.03,procedural:.06}[layerOf(row)]??.03;
 const importance=typeof row?.importance==='number'?Math.max(0,Math.min(1,row.importance)):.5;
 const age=typeof row?.recordedAt==='number'?Math.max(0,Date.now()-row.recordedAt):Number.POSITIVE_INFINITY;
 const recency=Math.max(0,1-age/(1000*60*60*24*90));
 const fusionBonus=Math.min(.1,Math.max(0,modes.size-1)*.04);
 return Math.min(1.25,retrievalScore+fusionBonus+importance*.08+recency*.03+layerBoost);
}
function graphLabel(value){const flat=String(value??'').replace(/\s+/g,' ').trim();return flat.length>48?flat.slice(0,47)+'…':flat;}
/** Slice a full projection to the requested window while keeping full totals. */
function windowGraph(graph,limit){
 const nodes=graph.nodes.slice(0,limit),ids=new Set(nodes.map(node=>node.id));
 const edges=graph.edges.filter(edge=>ids.has(edge.source)&&ids.has(edge.target));
 return{nodes,edges,stats:{...graph.stats,nodeCount:nodes.length,edgeCount:edges.length,totalNodeCount:graph.nodes.length,totalEdgeCount:graph.edges.length,truncated:!!graph.stats?.truncated||graph.nodes.length>nodes.length}};
}
function graphSubset(graph,rootId,depth,limit){
 if(!rootId)return graph;
 const nodes=new Map(graph.nodes.map(node=>[node.id,node]));if(!nodes.has(rootId))return{nodes:[],edges:[],stats:{...graph.stats,nodeCount:0,edgeCount:0,totalNodeCount:0,totalEdgeCount:0,truncated:false}};
 const adjacency=new Map();for(const edge of graph.edges){if(!nodes.has(edge.source)||!nodes.has(edge.target))continue;for(const [a,b] of [[edge.source,edge.target],[edge.target,edge.source]]){const set=adjacency.get(a)??new Set();set.add(b);adjacency.set(a,set);}}
 // Expand to the hard bound so totals describe the whole reachable component;
 // the returned window is still limited to `limit` below.
 const cap=GRAPH_LIMIT,selected=new Set([rootId]),order=[rootId],queue=[[rootId,0]];let limitHit=false;
 while(queue.length){const [id,d]=queue.shift();if(d>=depth)continue;for(const next of adjacency.get(id)??[]){if(selected.has(next))continue;if(selected.size>=cap){limitHit=true;continue;}selected.add(next);order.push(next);queue.push([next,d+1]);}}
 const reachable=order.map(id=>nodes.get(id)).filter(Boolean);
 // Root first, then nearest: a limited window of a rooted query must still
 // contain the root (and its closest neighbourhood).
 const keptNodes=reachable.slice(0,limit),ids=new Set(keptNodes.map(node=>node.id));
 const edges=graph.edges.filter(edge=>ids.has(edge.source)&&ids.has(edge.target));
 const totalEdges=graph.edges.filter(edge=>selected.has(edge.source)&&selected.has(edge.target)).length;
 return{nodes:keptNodes,edges,stats:{...graph.stats,nodeCount:keptNodes.length,edgeCount:edges.length,totalNodeCount:reachable.length,totalEdgeCount:totalEdges,truncated:!!graph.stats?.truncated||limitHit||reachable.length>keptNodes.length}};
}
export function createContextService({store,legacy,config={},defaultScope=()=>config.scopeId||'local:'+process.cwd(),sessions,vectorIndex}){
 let legacyWarning=null,legacyScanWarning=null;
 // Backwards-compatible diagnostics: the legacy plain `warnings` strings stay
 // for older clients, while `warningDetails` carries a stable code (+ optional
 // params) so localized clients can render the same condition in their locale
 // instead of echoing Chinese host text.
 const warningDetails=new Map();
 const setWarningDetail=(code,message,params)=>{warningDetails.set(code,{code,message,...(params===undefined?{}:{params})});};
 const clearWarningDetail=code=>{warningDetails.delete(code);};
 function scope(input){const value=safeScope(input?.scopeId||defaultScope());if(config.scopeId&&value!==config.scopeId)throw fail('NOT_FOUND','没有可访问的记录');return value;}
 // Expiry maintenance is a write; throttle it so read paths (list/search/graph)
 // do not open a write transaction on every call (HOST-REVIEW M10).
 const MAINTAIN_INTERVAL_MS=60_000,lastMaintained=new Map();
 function maintain(scopeId,options={}){
  const now=Date.now(),previous=lastMaintained.get(scopeId)??0;
  if(options.force!==true&&now-previous<MAINTAIN_INTERVAL_MS)return [];
  lastMaintained.set(scopeId,now);
  const expired=typeof store?.expireMemories==='function'?store.expireMemories({scopeId,limit:200}):[];
  for(const row of expired)vectorIndex?.remove?.(scopeId,row.id);
  return expired;
 }
 async function legacyRead(method,input,opts){
  throwIfAborted(opts);
  try{const rows=await legacy?.[method]?.(input,opts);throwIfAborted(opts);legacyWarning=null;clearWarningDetail('LEGACY_READ_FAILED');return Array.isArray(rows)?rows:[];}
  catch(error){if(error?.code==='ABORTED')throw error;legacyWarning='旧记忆暂不可读，当前只显示可用的新记忆；未更改旧数据库。';setWarningDetail('LEGACY_READ_FAILED',legacyWarning);return [];}
 }
 async function legacyListPages(input,opts,{cap=LEGACY_SCOPE_SCAN_LIMIT,reportPaging=false}={}){
  const rows=[],seen=new Set();let offset=0;
  if(reportPaging){legacyScanWarning=null;clearWarningDetail('LEGACY_PAGING_UNSUPPORTED');clearWarningDetail('LEGACY_SCAN_TRUNCATED');}
  while(rows.length<cap){
   const page=await legacyRead('list',{...input,limit:LEGACY_PAGE_SIZE,offset},opts);if(!page.length)break;
   let added=0;for(const row of page){const key=typeof row?.id==='string'?scopeOf(row)+'\0'+row.id:null;if(!key||seen.has(key))continue;seen.add(key);rows.push(row);added++;if(rows.length>=cap)break;}
   if(page.length<LEGACY_PAGE_SIZE)break;
   // Older backends silently ignore offset. Stop rather than looping forever,
   // and surface an explicit warning in the workbench bootstrap response.
   if(added===0){if(reportPaging){legacyScanWarning='旧记忆后端不支持分页，范围列表可能不完整。';setWarningDetail('LEGACY_PAGING_UNSUPPORTED',legacyScanWarning);}break;}
   offset+=page.length;
  }
  if(rows.length>=cap&&reportPaging){legacyScanWarning=`旧记忆超过 ${cap} 条，范围统计已截断。`;setWarningDetail('LEGACY_SCAN_TRUNCATED',legacyScanWarning,{cap});}
  return rows;
 }
 async function scanLegacy(opts){return legacyListPages({},opts,{cap:LEGACY_SCOPE_SCAN_LIMIT,reportPaging:true});}
 async function legacyGet(scopeId,id,opts){
  const rows=await legacyRead('get',{ids:[id],userId:scopeId},opts);const row=rows.find(x=>x.id===id&&scopeOf(x)===scopeId);
  return row&&typeof row.content==='string'?legacyMemory(row):undefined;
 }
 async function getMemory(input,opts){
  const scopeId=scope(input);if(typeof input.id!=='string'||!input.id)return undefined;
  const current=store.getMemory(scopeId,input.id);
  if(current)return temporal(input)?store.getMemory(scopeId,input.id,{knownAt:input.knownAt,validAt:input.validAt}):current;
  if(temporal(input))return undefined;
  return legacyGet(scopeId,input.id,opts);
 }
 async function ensureMutable(input,opts){
  throwIfAborted(opts);
  const scopeId=scope(input);let current=store.getMemory(scopeId,input.id);if(current)return current;
  const old=await legacyGet(scopeId,input.id,opts);throwIfAborted(opts);if(!old)throw fail('NOT_FOUND','没有可访问的记忆');
  // Recheck after asynchronous legacy lookup; never overwrite a concurrent sidecar revision.
  current=store.getMemory(scopeId,input.id);if(current)return current;
  return store.importLegacy({id:old.id,scopeId,content:old.content,timestamp:old.recordedAt,metadata:old.metadata});
 }
 function layerExpiry(layer){
  if(layer==='working')return Date.now()+Math.max(1,Math.min(168,config.workingMemoryHours??24))*60*60*1000;
  if(layer==='episodic')return Date.now()+Math.max(1,Math.min(3650,config.episodicMemoryDays??90))*24*60*60*1000;
  return null;
 }
 function placementDefaults(input,previous){
  if(config.memoryLayeringEnabled===false)return{...input,layer:'semantic',expiresAt:null};
  const layer=input.layer??previous?.layer??'semantic';
  if(input.expiresAt!==undefined||layer===previous?.layer)return{...input,layer};
  return{...input,layer,expiresAt:layerExpiry(layer)};
 }
 async function listMemories(input,opts){
  const scopeId=scope(input),limit=limitOf(input.limit),lifecycle=input.lifecycle??'active';
  if(!temporal(input))maintain(scopeId);
  const local=store.listMemories({scopeId,query:input.query,lifecycle,epistemic:input.epistemic,layer:input.layer,limit,knownAt:input.knownAt,validAt:input.validAt});
  const out=new Map(local.map(x=>[x.id,x]));
  if(!temporal(input)&&lifecycle==='active'&&(input.layer===undefined||input.layer==='semantic')){
   const request={...(scopeId==='legacy:unknown'?{}:{userId:scopeId})};
   const rows=await legacyListPages(request,opts,{cap:LEGACY_SCOPE_SCAN_LIMIT,reportPaging:true});
   for(const raw of rows){
     if(scopeOf(raw)!==scopeId||typeof raw.id!=='string'||typeof raw.content!=='string')continue;
    if(store.getMemory(scopeId,raw.id))continue;
    const row=legacyMemory(raw);if(input.query&&!row.content.toLowerCase().includes(input.query.toLowerCase()))continue;
    if(input.epistemic&&row.epistemic!==input.epistemic)continue;out.set(row.id,row);
   }
  }
  return [...out.values()].sort((a,b)=>(b.recordedAt??0)-(a.recordedAt??0)).slice(0,limit);
 }
 function saveMemory(input,origin={actorRole:'unknown',kind:'record'}){
   const scopeId=scope(input);if(typeof input.content!=='string'||!input.content.trim())throw fail('INVALID_INPUT','记忆内容为空');
   const sourceContent=typeof origin.sourceContent==='string'?origin.sourceContent:input.content;
   // Explicit saves are rejected too: a credential written into the sidecar is
   // replayed into later prompts through recall. Callers must redact first.
   if(containsSecret(input.content)||containsSecret(sourceContent))throw fail('SECRET_REJECTED','content');
  const requestedLayer=config.memoryLayeringEnabled===false?'semantic':origin.layer??input.layer??'semantic';
  const defaultImportance={working:.35,episodic:.55,semantic:.7,procedural:.8}[requestedLayer]??.7;
  const defaultExpiry=layerExpiry(requestedLayer);
  const placement={
   layer:requestedLayer,
   importance:origin.importance??input.importance??defaultImportance,
   expiresAt:origin.expiresAt!==undefined?origin.expiresAt:input.expiresAt!==undefined?input.expiresAt:defaultExpiry,
   ...(origin.lifecycle!==undefined?{lifecycle:origin.lifecycle}:{}),
  };
  const saved=store.saveMemory({scopeId,content:input.content,kind:KINDS.has(input.kind)?input.kind:'note',...placement,metadata:cleanMetadata(input.metadata??{}),source:{content:sourceContent,kind:origin.kind??'record',actorRole:origin.sourceActorRole??origin.actorRole??'unknown',complete:origin.complete!==false,...(typeof origin.lineageId==='string'?{lineageId:origin.lineageId}:{})},...(input.idempotencyKey?{idempotencyKey:input.idempotencyKey}:{}),...(input.validFrom!==undefined?{validFrom:input.validFrom}:{}),...(input.validTo!==undefined?{validTo:input.validTo}:{}),...(Array.isArray(input.entityIds)?{entityIds:input.entityIds}:{})});
  vectorIndex?.enqueue?.(saved);return saved;
 }
 async function reviseMemory(input,opts){
  if(typeof input.content==='string'&&containsSecret(input.content))throw fail('SECRET_REJECTED','content');
  const previous=await ensureMutable(input,opts);throwIfAborted(opts);const result=store.reviseMemory({...placementDefaults(input,previous),scopeId:scope(input),actorRole:opts?.actorRole??'unknown'});vectorIndex?.enqueue?.(result);return result;}
 async function transitionMemory(input,opts){const previous=await ensureMutable(input,opts);throwIfAborted(opts);const result=store.transitionMemory({...placementDefaults(input,previous),scopeId:scope(input)});vectorIndex?.enqueue?.(result);return result;}
 async function reinforceMemory(input,origin={},opts){
  if(typeof origin.sourceContent==='string'&&containsSecret(origin.sourceContent))throw fail('SECRET_REJECTED','source.content');
  await ensureMutable(input,opts);throwIfAborted(opts);const scopeId=scope(input),previous=store.getMemory(scopeId,input.id);
  const result=store.reinforceMemory({...input,scopeId,expectedRevision:input.expectedRevision??previous.revision,source:{content:origin.sourceContent??input.content??previous.content,kind:origin.kind??'repeated-observation',actorRole:origin.sourceActorRole??origin.actorRole??'unknown',complete:origin.complete!==false,...(typeof origin.lineageId==='string'?{lineageId:origin.lineageId}:{})}});
  vectorIndex?.enqueue?.(result);return result;
 }
 async function retireMemory(input,opts){await ensureMutable(input,opts);throwIfAborted(opts);const scopeId=scope(input),result=store.retireMemory({...input,scopeId});vectorIndex?.remove?.(scopeId,result.id);return result;}
 async function search(input,opts){
   const scopeId=scope(input);const query=typeof input.query==='string'?input.query.trim():'';if(!query)return [];
  maintain(scopeId);
  const policy=input.sessionId?store.getUsagePolicy(input.sessionId):{paused:false,excludedIds:[],preferredIds:[]};
  const policyMatches=!policy.scopeId||policy.scopeId===scopeId;
  const authorizedScopes=new Set(Array.isArray(input.authorizedScopeIds)?input.authorizedScopeIds:[policy.scopeId,scopeId,GLOBAL_SCOPE_ID].filter(Boolean));
  if(policy.scopeId&&!policyMatches&&!authorizedScopes.has(scopeId))throw fail('NOT_FOUND','会话记忆范围不一致');
  if(policy.paused||config.recallEnabled===false)return [];
  const threshold=typeof input.threshold==='number'&&Number.isFinite(input.threshold)?Math.max(0,Math.min(1,input.threshold)):0.3;
   const excluded=new Set(policyMatches?policy.excludedIds:[]),limit=Math.min(limitOf(input.limit),50),out=new Map();
   const put=(row,score,mode)=>{
    if(!Number.isFinite(score)||score<threshold||!active(row)||!usableInSession(row,input.sessionId))return;
    const existing=out.get(row.id),modes=new Set(existing?.metadata?.searchModes??[]);modes.add(mode);
    const wins=!existing||score>(existing.score??-Infinity),retrievalScore=Math.max(existing?.score??-Infinity,score),searchMode=wins?mode:existing.metadata.searchMode,rankScore=mode==='preferred'||searchMode==='preferred'?1.3:rankOf(row,retrievalScore,modes);
    out.set(row.id,{...row,score:retrievalScore,metadata:{...row.metadata,searchMode,searchModes:[...modes].sort(),retrievalScore,rankScore}});
   };
   const normalizedQuery=query.normalize('NFKC').toLocaleLowerCase(),terms=lexicalTerms(query),lexicalCandidates=new Map();
   if(typeof store.searchMemories==='function'){
    const exact=store.listMemories({scopeId,query,lifecycle:'active',limit:500});
    for(const row of exact)lexicalCandidates.set(row.id,row);
    if(!exact.length){
     const queries=terms.filter(term=>term!==normalizedQuery);
     if(queries.length)for(const row of store.searchMemories({scopeId,queries,lifecycle:'active',limit:500}))lexicalCandidates.set(row.id,row);
    }
   }else{
    for(const row of store.listMemories({scopeId,query,lifecycle:'active',limit:500}))lexicalCandidates.set(row.id,row);
    for(const term of terms)for(const row of store.listMemories({scopeId,query:term,lifecycle:'active',limit:500}))lexicalCandidates.set(row.id,row);
   }
  for(const row of lexicalCandidates.values()){
   if(!active(row)||excluded.has(row.id)||!usableInSession(row,input.sessionId))continue;
   const content=row.content.normalize('NFKC').toLocaleLowerCase(),matched=terms.filter(term=>content.includes(term)).length;
   const score=content.includes(normalizedQuery)?.8:matched?Math.min(.79,.35+.44*matched/Math.max(1,terms.length)):0;
   if(score)put(row,score,'lexical');
  }
   if(vectorIndex){
   const semanticLimit=Math.max(100,limit*8);
   const queries=semanticQueries(query),batches=await Promise.all(queries.map(value=>vectorIndex.search({scopeId,query:value,limit:semanticLimit,minScore:threshold},opts)));
   for(let queryIndex=0;queryIndex<batches.length;queryIndex++)for(const hit of batches[queryIndex]){
    const row=store.getMemory(scopeId,hit.id);
    if(row?.revision===hit.revision&&active(row)&&!excluded.has(row.id)&&usableInSession(row,input.sessionId))put(row,hit.score,queryIndex===0?'semantic':'semantic-focus');
   }
  }
   const legacyHits=await legacyRead('search',{query,userId:scopeId,scopeId,limit,threshold},opts);
   for(const raw of legacyHits){
    if(typeof raw.id!=='string'||typeof raw.content!=='string'||scopeOf(raw)!==scopeId||excluded.has(raw.id))continue;
    const overlay=store.getMemory(scopeId,raw.id);if(overlay)continue;
    put(legacyMemory(raw),Number.isFinite(raw.score)?raw.score:.5,'legacy');
   }
   // Older OpenContext FTS tokenization returns no rows for many Chinese
   // phrases. A bounded, read-only scan keeps upgrades searchable without
   // rewriting the legacy database or mixing unrelated workspace scopes.
   if(legacyHits.length<limit){
    const rows=await legacyListPages({userId:scopeId},opts,{cap:LEGACY_SEARCH_SCAN_LIMIT});
    for(const raw of rows){
     if(typeof raw.id!=='string'||typeof raw.content!=='string'||scopeOf(raw)!==scopeId||excluded.has(raw.id)||store.getMemory(scopeId,raw.id))continue;
     const score=lexicalLegacyScore(query,raw.content);if(score>0)put(legacyMemory(raw),score,'legacy-lexical');
    }
   }
  if(config.ontologyEnabled!==false){
   for(const entity of store.listEntities({scopeId,query,limit:3})){
    const graph=store.graph({scopeId,rootId:entity.id,depth:2,includePending:false,limit:80});
    for(const node of graph.nodes){if(node.type!=='memory'||excluded.has(node.id))continue;const row=store.getMemory(scopeId,node.id);if(active(row))put(row,.45,'graph');}
   }
  }
  for(const id of policyMatches?policy.preferredIds:[]){if(excluded.has(id))continue;const row=await getMemory({scopeId,id},opts);if(active(row))put(row,1,'preferred');}
   const ranked=[...out.values()].sort((a,b)=>(b.metadata?.rankScore??b.score??0)-(a.metadata?.rankScore??a.score??0)||(b.score??0)-(a.score??0));
   return diversifyMemoryResults(ranked,limit,query);
 }
 async function graph(input,opts){
  const scopeId=scope(input),limit=Number.isSafeInteger(input.limit)?Math.min(input.limit,GRAPH_LIMIT):GRAPH_LIMIT;
  if(!temporal(input))maintain(scopeId);
  // Project at the hard safety bound once, then slice the returned window:
  // stats.totalNodeCount/totalEdgeCount must describe the whole depth-bounded
  // graph rather than the limit window. The projection stays bounded by
  // GRAPH_LIMIT / LIMITS.graphEdges, so this is not an unbounded scan.
  const local=store.graph({...input,scopeId,limit:GRAPH_LIMIT});
  const depth=Number.isSafeInteger(input.depth)?input.depth:2;
  if(temporal(input)){
   const full={...local,stats:{...local.stats,totalNodeCount:local.nodes.length,totalEdgeCount:local.edges.length}};
   return withGraphCommunities(input.rootId===undefined?windowGraph(full,limit):graphSubset(full,input.rootId,depth,limit));
  }
  const legacyRows=await legacyListPages({userId:scopeId},opts,{cap:LEGACY_SCOPE_SCAN_LIMIT,reportPaging:true}),nodeMap=new Map(local.nodes.map(node=>[node.id,node])),edges=[...local.edges];
  const usable=[];for(const raw of legacyRows){if(scopeOf(raw)!==scopeId||typeof raw?.id!=='string'||typeof raw?.content!=='string'||store.getMemory(scopeId,raw.id))continue;const row=legacyMemory(raw);usable.push(row);nodeMap.set(row.id,{id:row.id,type:'memory',subtype:typeof row.metadata?.sourceType==='string'?row.metadata.sourceType:undefined,label:graphLabel(row.content),timestamp:row.recordedAt??undefined,scopeId,legacy:true});}
  try{const result=await legacy?.listDocuments?.({scopeId,userId:scopeId,limit:Math.min(limit,200)},opts);for(const doc of result?.documents??[]){if(typeof doc?.id!=='string'||nodeMap.has(doc.id))continue;nodeMap.set(doc.id,{id:doc.id,type:'document',label:graphLabel(doc.filename??doc.id),timestamp:doc.uploadedAt,scopeId,legacy:true});}}catch{}
  const ids=new Set(nodeMap.keys()),edgeIds=new Set(edges.map(edge=>edge.id)),sessionsMap=new Map();
  const addEdge=edge=>{if(ids.has(edge.source)&&ids.has(edge.target)&&!edgeIds.has(edge.id)){edgeIds.add(edge.id);edges.push(edge);}};
  for(const row of usable){const metadata=row.metadata??{};if(typeof metadata.supersedes==='string')addEdge({id:row.id+'->'+metadata.supersedes+':supersedes',source:row.id,target:metadata.supersedes,type:'supersedes',status:'legacy'});if(typeof metadata.documentId==='string')addEdge({id:row.id+'->'+metadata.documentId+':references',source:row.id,target:metadata.documentId,type:'references',status:'legacy'});if(typeof metadata.sessionId==='string'&&metadata.sessionId){const chain=sessionsMap.get(metadata.sessionId)??[];chain.push(row);sessionsMap.set(metadata.sessionId,chain);}}
  for(const chain of sessionsMap.values()){chain.sort((a,b)=>(a.recordedAt??0)-(b.recordedAt??0));for(let i=1;i<chain.length;i++)addEdge({id:chain[i-1].id+'->'+chain[i].id+':session',source:chain[i-1].id,target:chain[i].id,type:'session',status:'legacy'});}
  try {
    const { existsSync } = await import('node:fs');
    const { getOpenContextPath } = await import('@melandlabs/env-config');
    const Database = (await import('better-sqlite3')).default;
    const summaryPath = getOpenContextPath('memory', 'store.db');
    if (existsSync(summaryPath)) {
      const summaryDb = new Database(summaryPath, { readonly: true });
      try {
        const cutoffSeconds = Math.floor((Date.now() - 365 * 86400000) / 1000);
        const summaryRows = summaryDb.prepare('SELECT summary_id, summary_text, source_record_ids, created_at FROM memory_summaries WHERE created_at >= ? ORDER BY created_at DESC LIMIT 800').all(cutoffSeconds);
        for (const row of summaryRows) {
          let recordIds = [];
          try { recordIds = JSON.parse(row.source_record_ids ?? '[]'); } catch { recordIds = []; }
          if (!Array.isArray(recordIds) || recordIds.length === 0) continue;
          const summaryNodeId = 'summary:' + row.summary_id;
          if (!nodeMap.has(summaryNodeId)) {
            nodeMap.set(summaryNodeId, { id: summaryNodeId, type: 'summary', label: graphLabel(String(row.summary_text ?? '').slice(0, 80)), timestamp: typeof row.created_at === 'number' ? row.created_at * 1000 : undefined, scopeId, legacy: true });
          }
          ids.add(summaryNodeId);
          const selected = recordIds.filter((value) => typeof value === 'number' || typeof value === 'string').slice(0, 64);
          if (selected.length === 0) continue;
          let messages = [];
          try {
            const placeholders = selected.map(() => '?').join(',');
            messages = summaryDb.prepare('SELECT id, message_id FROM raw_messages WHERE id IN (' + placeholders + ')').all(...selected);
          } catch { messages = []; }
          for (const message of messages) {
            const candidates = [message.message_id, String(message.id), 'memory:' + message.message_id, 'memory:' + String(message.id)];
            const target = candidates.find((candidate) => typeof candidate === 'string' && nodeMap.has(candidate));
            if (target === undefined) continue;
            addEdge({ id: summaryNodeId + '->' + target + ':summarizes', source: summaryNodeId, target, type: 'summarizes', status: 'legacy' });
          }
        }
      } finally { summaryDb.close(); }
    }
  } catch { /* 摘要合并是尽力而为：读不到旧库时不阻塞关系图 */ }
  const nodes=[...nodeMap.values()].sort((a,b)=>(b.timestamp??0)-(a.timestamp??0));
  // Full merged projection (bounded by the projection caps); the root-aware
  // window and stats.totals are derived below without touching these counts.
  const full={nodes,edges,stats:{nodeCount:nodes.length,edgeCount:edges.length,totalNodeCount:nodes.length,totalEdgeCount:edges.length,truncated:!!local.stats?.truncated,depthLimited:!!local.stats?.depthLimited}};
  return withGraphCommunities(input.rootId===undefined?windowGraph(full,limit):graphSubset(full,input.rootId,depth,limit));
 }
 async function cleanDocumentInput(input,opts){
  const scopeId=scope(input),filename=typeof input?.filename==='string'?input.filename.trim():'',mimeType=typeof input?.mimeType==='string'?input.mimeType.trim():'application/octet-stream';
  if(!filename||filename.length>512||/[\0-\x1f]/.test(filename))throw fail('INVALID_INPUT','文档名称无效');
  if(!mimeType||mimeType.length>160||/[\0-\x1f]/.test(mimeType))throw fail('INVALID_INPUT','文档类型无效');
  const parsed=await prepareKnowledgeDocument({...input,filename,mimeType},opts);
  return{scopeId,content:parsed.content,filename,mimeType:parsed.mimeType,metadata:cleanMetadata({...input?.metadata,sourceFormat:parsed.sourceFormat,sourceBytes:parsed.sourceBytes,parseWarningCodes:parsed.warningCodes})};
 }
 function visibleDocument(row,scopeId){
   if(!row||typeof row.id!=='string'||typeof row.filename!=='string'||row.filename.length>512)return null;
  return{id:row.id,filename:row.filename,mimeType:typeof row.mimeType==='string'?row.mimeType:'text/plain',uploadedAt:Number.isFinite(row.uploadedAt)?row.uploadedAt:null,chunks:Number.isSafeInteger(row.chunks)?row.chunks:0,metadata:cleanMetadata(row.metadata??{}),scopeId,semanticIndexed:row.semanticIndexed===true,semanticPending:row.semanticPending===true,semanticModel:typeof row.semanticModel==='string'?row.semanticModel:null,semanticDimensions:Number.isSafeInteger(row.semanticDimensions)?row.semanticDimensions:null};
 }
 async function listDocuments(input={},opts){
  const scopeId=scope(input),limit=Number.isSafeInteger(input.limit)?Math.max(1,Math.min(DOCUMENT_LIST_LIMIT,input.limit)):100;
  throwIfAborted(opts);
  if(typeof legacy?.listDocuments!=='function')throw fail('STORE_UNAVAILABLE','知识库暂不可用');
  try{const result=await legacy?.listDocuments?.({scopeId,userId:scopeId,limit},opts);throwIfAborted(opts);return (result?.documents??[]).map(row=>visibleDocument(row,scopeId)).filter(Boolean);}
  catch(error){if(error?.code==='ABORTED')throw error;warnKnowledge('list',error);throw fail('STORE_UNAVAILABLE','知识库暂不可用');}
 }
 let uploadInFlight=0;
 const UPLOAD_CONCURRENCY=1;
 async function withUploadSlot(run){
  // One bounded upload at a time: a 25 MB base64 body plus parser buffers is
  // the largest transient allocation in the host (HOST-REVIEW M6).
  if(uploadInFlight>=UPLOAD_CONCURRENCY)throw fail('LIMIT_EXCEEDED','同时只允许一个文档解析任务，请稍后重试');
  uploadInFlight+=1;
  try{return await run();}finally{uploadInFlight-=1;}
 }
 async function uploadDocumentInner(input,opts){
  const data=await cleanDocumentInput(input,opts);throwIfAborted(opts);
  if(typeof legacy?.uploadDocument!=='function')throw fail('STORE_UNAVAILABLE','知识库暂不可用');
  try{const result=await legacy?.uploadDocument?.({...data,userId:data.scopeId},opts);throwIfAborted(opts);if(typeof result?.documentId!=='string')throw fail('STORE_FAILURE','知识库未返回文档标识');return{documentId:result.documentId,chunks:Number.isSafeInteger(result.chunks)?result.chunks:0,sourceFormat:data.metadata.sourceFormat,sourceBytes:data.metadata.sourceBytes,warningCodes:data.metadata.parseWarningCodes??[],semanticIndexed:result.semanticIndexed===true,semanticPending:result.semanticPending===true,semanticErrorCode:typeof result.semanticErrorCode==='string'?result.semanticErrorCode:null};}
  catch(error){if(['ABORTED','LIMIT_EXCEEDED','INVALID_INPUT','SECRET_REJECTED','DOCUMENT_FORMAT_UNSUPPORTED','DOCUMENT_PARSE_FAILED','DOCUMENT_PARSER_UNAVAILABLE','STORE_FAILURE'].includes(error?.code))throw error;if(error?.code==='SQLITE_FULL')throw fail('STORE_FULL','本地磁盘空间不足，知识库文件无法继续写入');warnKnowledge('upload',error);throw fail('STORE_UNAVAILABLE','知识库暂不可用');}
 }
async function uploadDocument(input,opts){return withUploadSlot(()=>uploadDocumentInner(input,opts));}
 async function searchDocuments(input={},opts){
  const scopeId=scope(input),query=typeof input.query==='string'?input.query.trim():'';
   if(!query||query.length>4096)throw fail('INVALID_INPUT','请输入有效的文档检索内容');
  const limit=Number.isSafeInteger(input.limit)?Math.max(1,Math.min(50,input.limit)):12,threshold=typeof input.threshold==='number'&&Number.isFinite(input.threshold)?Math.max(-1,Math.min(1,input.threshold)):0.3;
  const searchMode=['hybrid','semantic','keyword'].includes(input.searchMode)?input.searchMode:'hybrid';
  const documentIds=Array.isArray(input.documentIds)?[...new Set(input.documentIds.filter(id=>typeof id==='string'&&id.trim()&&id.length<=512).map(id=>id.trim()))].slice(0,100):undefined;
  const metadata=input.metadata===undefined?undefined:cleanMetadata(input.metadata);
  throwIfAborted(opts);
  if(typeof legacy?.searchKnowledge!=='function')throw fail('STORE_UNAVAILABLE','知识库暂不可用');
   try{const result=await legacy?.searchKnowledge?.({scopeId,userId:scopeId,query,limit,threshold,searchMode,documentIds,metadata},opts);throwIfAborted(opts);return (result?.chunks??[]).filter(row=>typeof row?.id==='string'&&typeof row?.documentId==='string'&&typeof row?.documentName==='string'&&typeof row?.content==='string').map(row=>({id:row.id,scopeId,documentId:row.documentId,documentName:row.documentName,content:row.content,chunkIndex:Number.isSafeInteger(row.chunkIndex)?row.chunkIndex:0,score:Number.isFinite(row.score)?row.score:0,metadata:cleanMetadata(row.metadata??{})}));}
  catch(error){if(error?.code==='ABORTED'||error?.code==='INVALID_INPUT')throw error;warnKnowledge('search',error);throw fail('STORE_UNAVAILABLE','知识库暂不可用');}
 }
 async function listDocumentChunks(input={},opts){
  const scopeId=scope(input),id=typeof input.id==='string'?input.id.trim():'';
  if(!id||id.length>512||/[\0-\x1f]/.test(id))throw fail('INVALID_INPUT','文档标识无效');
  throwIfAborted(opts);if(typeof legacy?.listDocumentChunks!=='function')throw fail('STORE_UNAVAILABLE','当前知识库版本不支持查看分块');
  try{const result=await legacy.listDocumentChunks({scopeId,userId:scopeId,id,limit:Math.min(5000,Number.isSafeInteger(input.limit)?input.limit:5000)},opts);throwIfAborted(opts);return{document:result?.document?visibleDocument(result.document,scopeId):null,chunks:(result?.chunks??[]).filter(row=>typeof row?.id==='string'&&typeof row?.content==='string').map(row=>({id:row.id,scopeId,documentId:id,chunkIndex:Number.isSafeInteger(row.chunkIndex)?row.chunkIndex:0,content:row.content,metadata:cleanMetadata(row.metadata??{})}))};}
  catch(error){if(error?.code==='ABORTED'||error?.code==='INVALID_INPUT')throw error;warnKnowledge('chunks',error);throw fail('STORE_UNAVAILABLE','文档分块暂不可用');}
 }
 async function reindexDocument(input={},opts){
  const scopeId=scope(input),id=typeof input.id==='string'?input.id.trim():'';
  if(!id||id.length>512||/[\0-\x1f]/.test(id))throw fail('INVALID_INPUT','文档标识无效');
  throwIfAborted(opts);if(typeof legacy?.reindexDocument!=='function')throw fail('STORE_UNAVAILABLE','当前知识库版本不支持重建索引');
  try{const result=await legacy.reindexDocument({scopeId,userId:scopeId,id},opts);throwIfAborted(opts);return{reindexed:result?.reindexed===true,chunks:Number.isSafeInteger(result?.chunks)?result.chunks:0,semanticIndexed:result?.semanticIndexed===true,semanticPending:result?.semanticPending===true,semanticErrorCode:typeof result?.semanticErrorCode==='string'?result.semanticErrorCode:null};}
  catch(error){if(error?.code==='ABORTED'||error?.code==='INVALID_INPUT')throw error;if(error?.code==='SQLITE_FULL')throw fail('STORE_FULL','本地磁盘空间不足，无法重建知识库索引');warnKnowledge('reindex',error);throw fail('STORE_UNAVAILABLE','重建索引未完成');}
 }
 async function deleteDocuments(input={},opts){
  const scopeId=scope(input),ids=Array.isArray(input.ids)?[...new Set(input.ids.filter(id=>typeof id==='string'&&id.trim()&&id.length<=512).map(id=>id.trim()))]:[];
  if(!ids.length||ids.length>100)throw fail('INVALID_INPUT','请选择 1 到 100 篇文档');
  throwIfAborted(opts);if(typeof legacy?.deleteDocuments!=='function')throw fail('STORE_UNAVAILABLE','当前知识库版本不支持批量删除');
  try{const result=await legacy.deleteDocuments({scopeId,userId:scopeId,ids},opts);throwIfAborted(opts);return{deleted:Number.isSafeInteger(result?.deleted)?result.deleted:0,requested:ids.length};}
  catch(error){if(error?.code==='ABORTED'||error?.code==='INVALID_INPUT')throw error;warnKnowledge('delete-batch',error);throw fail('STORE_UNAVAILABLE','批量删除未完成');}
 }
 async function deleteDocument(input={},opts){
  const scopeId=scope(input),id=typeof input.id==='string'?input.id.trim():'';
  if(!id||id.length>512||/[\0-\x1f]/.test(id))throw fail('INVALID_INPUT','文档标识无效');
  throwIfAborted(opts);
  if(typeof legacy?.deleteDocument!=='function')throw fail('STORE_UNAVAILABLE','知识库暂不可用');
  try{const result=await legacy?.deleteDocument?.({scopeId,userId:scopeId,id},opts);throwIfAborted(opts);return{deleted:result?.deleted===true};}
  catch(error){if(error?.code==='ABORTED'||error?.code==='INVALID_INPUT')throw error;warnKnowledge('delete',error);throw fail('STORE_UNAVAILABLE','知识库暂不可用');}
 }
 async function captureOntologyCandidates(input={},opts){
  throwIfAborted(opts);const scopeId=scope(input),memory=store.getMemory(scopeId,input.sourceMemoryId);
  if(!memory||memory.lifecycle==='retired')throw fail('INVALID_REFERENCE','候选关系缺少可用的来源记忆');
  const rawEntities=Array.isArray(input.entities)?input.entities.slice(0,12):[],rawRelations=Array.isArray(input.relations)?input.relations.slice(0,12):[];
  const schema=store.getSchema(),types=new Set(schema.types.map(row=>row.id)),predicates=new Set(schema.relations.map(row=>row.id));
  const normalized=value=>String(value??'').normalize('NFKC').trim().toLocaleLowerCase();
  const byName=new Map(),entities=[];
  const findEntity=(name,type)=>store.listEntities({scopeId,query:name,limit:100}).find(row=>row.type===type&&[row.name,...row.aliases].some(alias=>normalized(alias)===normalized(name)));
  for(const candidate of rawEntities){
   throwIfAborted(opts);if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))continue;
   const name=typeof candidate.name==='string'?candidate.name.trim():'',type=typeof candidate.type==='string'?candidate.type:'';
    if(!name||name.length>120||!types.has(type))continue;
    const aliases=Array.isArray(candidate.aliases)?candidate.aliases.filter(value=>typeof value==='string'&&value.trim()).map(value=>value.trim()).slice(0,12):[];
   let entity=findEntity(name,type);
   if(!entity){try{entity=store.createEntity({scopeId,name,type,aliases});}catch(error){if(error?.code!=='ENTITY_CONFLICT')continue;entity=findEntity(name,type);}}
   if(!entity)continue;entities.push(entity);byName.set(normalized(name),entity);for(const alias of aliases)byName.set(normalized(alias),entity);
  }
  const relations=[];
  for(const candidate of rawRelations){
   throwIfAborted(opts);if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))continue;
   const subject=byName.get(normalized(candidate.subject)),object=byName.get(normalized(candidate.object)),predicate=typeof candidate.predicate==='string'?candidate.predicate:'',quote=typeof candidate.quote==='string'?candidate.quote.trim():'';
    if(!subject||!object||subject.id===object.id||!predicates.has(predicate)||!quote||quote.length>1000||!memory.source?.content?.includes(quote))continue;
   try{relations.push(store.createRelation({scopeId,subjectId:subject.id,predicate,objectId:object.id,sourceId:memory.sourceId,quote}));}catch{/* Model candidates that fail ontology or evidence validation are discarded. */}
  }
  return{entities,relations};
 }
  const service={store,scope,getMemory,listMemories,saveMemory,reviseMemory,transitionMemory,reinforceMemory,retireMemory,search,maintain,
  warnings:()=>[legacyWarning,legacyScanWarning].filter(Boolean),
  warningDetails:()=>[...warningDetails.values()],
   async listScopes(){const map=new Map(store.listScopes().map(x=>[x.id,{...x}]));const fallback=safeScope(defaultScope());if(!map.has(fallback))map.set(fallback,{id:fallback,label:fallback,count:0});if(!config.scopeId&&!map.has(GLOBAL_SCOPE_ID))map.set(GLOBAL_SCOPE_ID,{id:GLOBAL_SCOPE_ID,label:'全局记忆',count:0});for(const row of await scanLegacy()){const id=scopeOf(row);if(config.scopeId&&id!==config.scopeId)continue;if(typeof row.id==='string'&&store.getMemory(id,row.id))continue;const current=map.get(id)??{id,label:id==='legacy:unknown'?'旧记忆（范围未记录）':id===GLOBAL_SCOPE_ID?'全局记忆':id,count:0};current.count++;map.set(id,current);}if(typeof legacy?.listKnowledgeScopes==='function'){try{for(const row of await legacy.listKnowledgeScopes({},{})){if(!row||typeof row.id!=='string'||!row.id||(config.scopeId&&row.id!==config.scopeId))continue;const current=map.get(row.id)??{id:row.id,label:row.id,count:0};current.knowledgeCount=Number.isSafeInteger(row.count)?row.count:0;current.knowledgeChunks=Number.isSafeInteger(row.chunks)?row.chunks:0;map.set(row.id,current);}}catch(error){warnKnowledge('scopes',error);}}const global=map.get(GLOBAL_SCOPE_ID);if(global)global.label='全局记忆';return [...map.values()];},
   async compatibilityWorkspaceScopes(scopeId){
    if(config.scopeId)return[];
    const current=safeScope(scopeId),configured=Array.isArray(config.compatibilityWorkspaceScopeIds)?config.compatibilityWorkspaceScopeIds.filter(x=>typeof x==='string'):[];
    const rows=await service.listScopes();
    return rows.filter(row=>row.id!==current&&(row.count>0||row.knowledgeCount>0)&&scopeKind(row.id)==='workspace'&&isLegacyApplicationScope(row.id,configured)).sort((a,b)=>(b.count+(b.knowledgeCount??0))-(a.count+(a.knowledgeCount??0))||a.id.localeCompare(b.id)).map(row=>row.id);
   },
   async bootstrap(sessionId){
    const listed=await service.listScopes(),session=sessionId?sessions?.get?.(sessionId):null,traces=sessionId?store.listUsage({sessionId,limit:1}):[];
    const identity=session?resolveContextIdentity({session},config):null,sessionScope=identity?.scopeId??traces[0]?.scopeId??null,activeScope=sessionScope??safeScope(defaultScope());
    const currentScopes=identity?.scopes??[{kind:scopeKind(activeScope),id:activeScope},...(config.scopeId?[]:[{kind:'global',id:GLOBAL_SCOPE_ID}])];
    const map=new Map(listed.map(row=>[row.id,{...row}]));
    for(const current of currentScopes)if(!map.has(current.id))map.set(current.id,{id:current.id,label:current.id,count:0});
    const scopes=[...map.values()];maintain(activeScope);
    const baseRecall=identity?.recallScopeIds??[activeScope,...(config.scopeId?[]:[GLOBAL_SCOPE_ID])],compatibility=await service.compatibilityWorkspaceScopes(activeScope),recallOrder=[];
    for(const id of baseRecall){recallOrder.push(id);if(id===activeScope)recallOrder.push(...compatibility);}
    return {displayName:'agentOS context',scopes,defaultScope:activeScope,sessionScope,globalScope:config.scopeId?null:GLOBAL_SCOPE_ID,currentScopes,recallOrder:[...new Set(recallOrder)],compatibilityScopes:compatibility,features:{ontology:config.ontologyEnabled!==false,recall:config.recallEnabled!==false,capture:!!config.capturePrompts},memoryLayers:['working','episodic','semantic','procedural'],legacyScopeScanLimit:LEGACY_SCOPE_SCAN_LIMIT,warnings:service.warnings(),warningDetails:service.warningDetails()};
   },
  async versions(input){const scopeId=scope(input);if(store.getMemory(scopeId,input.id))return store.versions(scopeId,input.id);const old=await legacyGet(scopeId,input.id);return old?[old]:[];},
  listEntities:input=>store.listEntities({...input,scopeId:scope(input)}),
  createEntity:input=>store.createEntity({...input,scopeId:scope(input)}),
  mergeEntities:input=>store.mergeEntities({...input,scopeId:scope(input)}),
  async createRelation(input,opts){throwIfAborted(opts);const scopeId=scope(input);let sourceId=input.sourceId;if(input.sourceMemoryId){const memory=await ensureMutable({scopeId,id:input.sourceMemoryId},opts);sourceId=memory.sourceId;}throwIfAborted(opts);const {sourceMemoryId,...rest}=input;return store.createRelation({...rest,scopeId,...(sourceId?{sourceId}:{})});},
  reviewRelation:input=>store.reviewRelation({...input,scopeId:scope(input)}),
  listReviews:input=>store.listReviews({...input,scopeId:scope(input)}),
  graph,
  listDocuments,uploadDocument,searchDocuments,listDocumentChunks,reindexDocument,deleteDocument,deleteDocuments,captureOntologyCandidates,
  schema:()=>store.getSchema(),
  validateRelation:input=>store.validateRelation({...input,scopeId:scope(input)}),
  changes:input=>store.changes({...input,scopeId:scope(input)}),
  usage:input=>({items:store.listUsage({sessionId:input.sessionId,scopeId:scope(input),limit:input.limit??30}),policy:store.getUsagePolicy(input.sessionId)}),
  async setUsagePolicy(input,opts){throwIfAborted(opts);const scopeId=scope(input);if(input.memoryId&&!await getMemory({scopeId,id:input.memoryId},opts))throw fail('NOT_FOUND','没有可访问的记忆');throwIfAborted(opts);return store.setUsagePolicy({...input,scopeId});},
  async close(){const results=await Promise.allSettled([Promise.resolve().then(()=>vectorIndex?.close?.()),Promise.resolve().then(()=>store.close())]);const failed=results.find(x=>x.status==='rejected');if(failed?.status==='rejected')throw failed.reason;}
 };
 return service;
}
