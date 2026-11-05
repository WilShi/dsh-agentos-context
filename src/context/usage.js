/** Trace accepted recall messages and model attempt starts; never infer usage from similarity. */
import {randomUUID} from 'node:crypto';
function failure(code,message){return Object.assign(new Error(message),{code});}
export function createUsageTracker(ctx,store){
 let disposed=false;const pending=new Map(),messageUsage=new Map();
 const warn=()=>{try{ctx.logger?.warn?.('[agentOS context] usage trace update unavailable');}catch{}};
 const dropMessageFor=usageId=>{for(const [messageId,id] of messageUsage)if(id===usageId)messageUsage.delete(messageId);};
 const update=(row,phase,eventSeq,at)=>{const changed=store.updateUsage({id:row.id,phase,...(Number.isSafeInteger(eventSeq)?{eventSeq}:{}),...(Number.isSafeInteger(at)?{at}:{})});pending.set(row.id,{...row,phase:changed?.phase??phase});return changed;};
 const offEvent=ctx.on('session/event',(session,event)=>{if(disposed)return;try{
  if(event?.type==='user/message'){
   const message=event.data;if(message?.source?.kind!=='agentos-context'||message.source.form!=='recall'||typeof message?.id!=='string')return;
   const usageId=messageUsage.get(message.id);const sid=session?.id??session?.header?.id;const row=pending.get(usageId)??store.findUsageByMessageId?.({sessionId:sid,messageId:message.id});if(!row||row.sessionId!==(session?.id??session?.header?.id)||row.phase!=='planned')return;messageUsage.delete(message.id);update(row,'committed',event.seq,event.time);
  }else if(event?.type==='turn/end'){
   const sid=session?.id??session?.header?.id;for(const row of pending.values())if(row.sessionId===sid&&['planned','committed'].includes(row.phase)&&(event.data?.turn===undefined||row.turn===event.data.turn)){dropMessageFor(row.id);update(row,'failed',event.seq,event.time);}
  }
 }catch{warn();}});
 const offStream=ctx.on('agent/assistant-stream',(payload)=>{if(disposed||payload?.frame?.type!=='start')return;try{const sid=payload.agent?.session?.id??payload.agent?.session?.header?.id;for(const row of pending.values())if(row.phase==='committed'&&row.sessionId===sid&&row.turn===payload.frame.turn&&row.step===payload.frame.step)update(row,'requested');}catch{warn();}});
 return {
  plan(input){if(disposed)throw failure('DISPOSED','记忆追踪器已停止');if(typeof input?.sessionId!=='string'||!input.sessionId||typeof input.scopeId!=='string'||!input.scopeId||!Array.isArray(input.items))throw failure('INVALID_INPUT','缺少会话或记忆追踪信息');if(pending.size>=512){for(const [id,row]of pending)if(['requested','failed'].includes(row.phase)){dropMessageFor(id);pending.delete(id);if(pending.size<384)break;}}if(pending.size>=512)throw failure('USAGE_LIMIT','未完成的记忆追踪过多');const record=store.recordUsage({id:'usage-'+randomUUID(),sessionId:input.sessionId,scopeId:input.scopeId,phase:'planned',items:input.items,...(typeof input.messageId==='string'?{messageId:input.messageId}:{}),...(Number.isSafeInteger(input.turn)&&input.turn>0?{turn:input.turn}:{}),...(Number.isSafeInteger(input.step)&&input.step>0?{step:input.step}:{}),...(typeof input.reason==='string'?{reason:input.reason}:{})},{trustedLegacy:true,authorizedScopeIds:input.authorizedScopeIds});pending.set(record.id,{id:record.id,sessionId:record.sessionId,scopeId:record.scopeId,turn:record.turn,step:record.step,phase:record.phase});return record;},
  bindMessage(usageId,messageId){if(disposed)throw failure('DISPOSED','记忆追踪器已停止');if(typeof messageId!=='string'||!messageId||messageUsage.has(messageId)||!pending.has(usageId))throw failure('INVALID_INPUT','记忆引用关联无效');messageUsage.set(messageId,usageId);},
  dispose(){if(disposed)return;disposed=true;offEvent();offStream();pending.clear();messageUsage.clear();}
 };
}
