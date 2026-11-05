/** Add bounded, source-framed context only after downstream policy admits the human message. */
import {randomUUID} from 'node:crypto';import {deriveQuery,formatPreparedContext} from './prepared-context.js';import {sessionIdentity} from './context-origin.js';
function ranked(hit){return Number(hit?.metadata?.rankScore??hit?.score??0);}
async function searchScopes(backend,identity,config,query,signal){
 const baseScopes=identity.recallScopeIds??[identity.scopeId],compatibility=typeof backend.compatibilityWorkspaceScopes==='function'?await backend.compatibilityWorkspaceScopes(identity.workspaceScope??identity.scopeId):[];
 const scopes=[];for(const id of baseScopes){scopes.push(id);if(id===(identity.workspaceScope??identity.scopeId))scopes.push(...(Array.isArray(compatibility)?compatibility:[]));}
 const uniqueScopes=[...new Set(scopes)],authorizedScopeIds=[...new Set([...(identity.authorizedScopeIds??baseScopes),...uniqueScopes])],priority=new Map(uniqueScopes.map((id,index)=>[id,index]));
 const batches=await Promise.all(uniqueScopes.map(scopeId=>backend.search({query,limit:config.maxRecallItems,scopeId,userId:scopeId,sessionId:identity.sessionId,authorizedScopeIds},{timeoutMs:config.requestTimeoutMs,signal})));
 const rows=new Map();for(let index=0;index<batches.length;index++)for(const hit of batches[index]??[]){const scopeId=typeof hit?.scopeId==='string'&&hit.scopeId?hit.scopeId:uniqueScopes[index],key=scopeId+'\0'+hit.id,previous=rows.get(key);if(!previous||ranked(hit)>ranked(previous))rows.set(key,{...hit,scopeId});}
 return [...rows.values()].sort((a,b)=>ranked(b)-ranked(a)||(priority.get(a.scopeId)??999)-(priority.get(b.scopeId)??999)||(b.recordedAt??b.timestamp??0)-(a.recordedAt??a.timestamp??0)).slice(0,config.maxRecallItems);
}
export function registerRecall(ctx,backend,config,options={}){let disposed=false;const off=ctx.on('agent/pre-step',async(payload,next)=>{
 const decision=await next();if(disposed||payload?.signal?.aborted||decision?.kind!=='enter')return decision;
 const identity=sessionIdentity(payload,config);let prepared=null;
 try{const query=deriveQuery(decision.messages);if(config.recallEnabled!==false&&query){const hits=await searchScopes(backend,identity,config,query,payload?.signal);prepared=formatPreparedContext(hits,config.maxBytes);}}
 catch(error){ctx.logger.warn('[agentOS context] recall unavailable ('+(error?.code??'RECALL_ERROR')+')');return decision;}
 if(!prepared?.content)return decision;
 try{const messageId=randomUUID();const usage=options.usage?.plan({sessionId:identity.sessionId,scopeId:identity.scopeId,authorizedScopeIds:identity.authorizedScopeIds,messageId,step:payload?.step,turn:payload?.turn,items:prepared.items,reason:'accepted-query-and-scope-match'});const evidence={id:messageId,role:'user',content:[{type:'text',text:prepared.content}],source:{kind:'agentos-context',form:'recall'}};if(usage?.id)options.usage?.bindMessage?.(usage.id,evidence.id);return{...decision,messages:[...(decision.messages??[]),evidence]};}
 catch(error){ctx.logger.warn('[agentOS context] context preparation skipped ('+(error?.code??'CONTEXT_ERROR')+')');return decision;}
 });return()=>{disposed=true;off();};}
