/** Durable turn summaries derive from committed session/event turn closures only. */
import {resolveContextScope,resolveContextSessionId} from './context/scope.js';
function scopeOf(session,config){return resolveContextScope({session},config);}
function reasonKind(reason){return typeof reason?.kind==='string'?reason.kind:'ended';}
export function registerTurnEndListener(ctx,backend,config){
 const handler=async(session,event)=>{if(!(config.autoSummarize??false)||event?.type!=='turn/end')return;try{
  const scopeId=scopeOf(session,config),sessionId=resolveContextSessionId(session),turn=event.data?.turn;
  const content='Turn '+(Number.isSafeInteger(turn)?turn:'unknown')+' ended: '+reasonKind(event.data?.reason);
  await backend.remember({content,sourceType:'turn-summary',metadata:{sessionId,turn:Number.isSafeInteger(turn)?turn:null,reason:reasonKind(event.data?.reason),eventSeq:event.seq,ts:event.time??Date.now()},scopeId,userId:scopeId},{timeoutMs:config.requestTimeoutMs,captureOrigin:{actorRole:'tool',kind:'turn-summary',sourceActorRole:'tool',sourceContent:content,complete:true,lineageId:'turn-end:'+sessionId+':'+String(turn)}});
 }catch{ctx.logger.warn?.('[agentOS context] turn summary capture failed');}};
 return ctx.on('session/event',handler);
}
