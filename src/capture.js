/** Capture only runtime-attributed human input, not role=user plugin or agent messages. */
import {createHash} from 'node:crypto';
import {humanMessageRows,sessionIdentity} from './context-origin.js';
export function registerCapture(ctx,backend,config,options={}){
 const distiller=options.distiller??null;let disposed=false,queued=0,tail=Promise.resolve();
 const seen=new Set();const abort=new AbortController();const warnings=new Set();
 const warn=code=>{if(!warnings.has(code)){warnings.add(code);ctx.logger.warn('[agentOS context] capture '+code);}};
 const off=ctx.on('agent/pre-step',async(payload,next)=>{
  const decision=await next();
  if(disposed||!config.capturePrompts||decision?.kind!=='enter'||payload?.signal?.aborted)return decision;
  const {sessionId,scopeId}=sessionIdentity(payload,config);
  const rows=humanMessageRows(decision.messages);
  if(!rows.length)return decision;
  if(queued>=64){warn('QUEUE_LIMIT');return decision;}
  const fresh=rows.filter(row=>{const key=sessionId+':'+(row.id||createHash('sha256').update(row.text).digest('hex'));if(seen.has(key))return false;seen.add(key);row.key=key;return true;});
  if(!fresh.length)return decision;
  queued++;
  const job=tail.then(async()=>{
   for(const row of fresh){
    if(disposed||abort.signal.aborted)break;
    const text=row.text.slice(0,32768);let entries=null,ontology=null;
    if(distiller&&config.distillOnCapture){
     let fallbackReason='';
     try{
      if(typeof distiller.distillEnvelope==='function'){
       const envelope=await distiller.distillEnvelope(text);if(envelope){entries=envelope.memories.filter(x=>x&&typeof x.content==='string'&&x.content.trim()).slice(0,12).map(x=>({content:x.content,kind:x.kind,layer:x.layer,importance:x.importance,distilled:true}));ontology={entities:envelope.entities,relations:envelope.relations};}
      }else if(typeof distiller.distillStructured==='function'){
       const facts=await distiller.distillStructured(text);if(Array.isArray(facts))entries=facts.filter(x=>x&&typeof x.content==='string'&&x.content.trim()).slice(0,12).map(x=>({content:x.content,kind:x.kind,layer:x.layer,importance:x.importance,distilled:true}));
      }else{
       const facts=await distiller.distill(text);if(Array.isArray(facts))entries=facts.filter(x=>typeof x==='string'&&x.trim()).slice(0,12).map(content=>({content,distilled:true}));
      }
     }
     catch{warn('DISTILL_UNAVAILABLE');fallbackReason='unavailable';}
     if(entries===null){if(!fallbackReason)warn('DISTILL_INVALID');fallbackReason=fallbackReason||'invalid';entries=[{content:text,kind:'note',layer:'working',importance:.25,distilled:false,fallbackReason}];}
    }else entries=[{content:text,distilled:false}];
    let sourceMemoryId=null;
    for(const item of entries){
     if(disposed||abort.signal.aborted)continue;
     const sourceText=item.distilled?text.slice(0,2000):text;
     try{
      const saved=await backend.captureSource({content:item.content,kind:item.kind,sourceType:item.distilled?'insight':'user_input',metadata:{sessionId,scopeId,sourceMessageId:row.id||null,captureId:row.key,actorRole:item.distilled?'assistant':'human',authorityKind:item.distilled?'derived':'direct-human',sourceActorRole:'human',sourceText,sourceTruncated:sourceText.length<row.text.length,lineageId:'user-message:'+row.key,...(item.distilled?{distilledFrom:'capture'}:{}),...(item.fallbackReason?{distillState:'local-fallback',distillFailure:item.fallbackReason}:{})},scopeId,userId:scopeId},{timeoutMs:config.requestTimeoutMs,signal:abort.signal,captureOrigin:{actorRole:item.distilled?'assistant':'human',kind:item.distilled?'derived-capture':'capture-fallback',sourceActorRole:'human',sourceContent:sourceText,complete:sourceText.length===row.text.length,lineageId:'user-message:'+row.key,layer:item.layer,importance:item.importance}});
      if(!sourceMemoryId&&typeof saved?.id==='string')sourceMemoryId=saved.id;
     }catch(error){warn(error?.code??'WRITE_UNAVAILABLE');}
    }
    if(config.ontologyEnabled!==false&&sourceMemoryId&&ontology&&(ontology.entities.length||ontology.relations.length)&&typeof backend.captureOntologyCandidates==='function'){
     try{await backend.captureOntologyCandidates({scopeId,sourceMemoryId,...ontology},{timeoutMs:config.requestTimeoutMs,signal:abort.signal});}
     catch(error){warn(error?.code??'ONTOLOGY_UNAVAILABLE');}
    }
   }
  }).catch(()=>warn('QUEUE_ERROR')).finally(()=>{queued--;while(seen.size>2048)seen.delete(seen.values().next().value);});
  tail=job;
  if(config.flushOnCapture)await job;
  return decision;
 });
 return async()=>{disposed=true;abort.abort();off();await tail;};
}
