/** Observe the target's frozen tools/result emit event; never alter tool execution. */
import {resolveContextScope,resolveContextSessionId} from './context/scope.js';
function bounded(value,depth=0){
 if(depth>4)return '[nested data]';if(value===undefined)return '';if(value===null||typeof value==='boolean'||typeof value==='number')return String(value);if(typeof value==='string')return value.slice(0,1000);if(Array.isArray(value))return JSON.stringify(value.slice(0,50).map(item=>bounded(item,depth+1))).slice(0,1000);if(typeof value==='object'){const out={};for(const [key,item]of Object.entries(value).slice(0,100))out[key]=bounded(item,depth+1);return JSON.stringify(out).slice(0,1000);}return '[unsupported data]';}
function scopeOf(exec,config){return resolveContextScope({agent:exec?.agent},config);}
export function registerToolResultListener(ctx,backend,config){
 const handler=async(exec,result)=>{if(!(config.captureToolResults??false))return;try{
  if(!exec?.name||/^(?:oc_|memory_|knowledge_|context_)/u.test(String(exec.name)))return;
  const scopeId=scopeOf(exec,config),sessionId=resolveContextSessionId(exec?.agent?.session);
  const isError=result?.isError===true;const code=isError?(result.error?.info?.code??'TOOL_ERROR'):undefined;const parts=['Tool: '+String(exec.name),'Status: '+(isError?'ERROR':'SUCCESS')];
  if(exec.arguments!==undefined)parts.push('Arguments: '+bounded(exec.arguments));if(isError)parts.push('Error code: '+code);else{const value=bounded(result?.value);if(value)parts.push('Result: '+value);}
  const content=parts.join('\n');if(!content)return;
  await backend.captureSource({content,sourceType:'tool-interaction',metadata:{tool:String(exec.name),sessionId,success:!isError,callId:String(exec.callId??''),...(code?{errorCode:String(code)}:{}),ts:Date.now()},scopeId,userId:scopeId},{timeoutMs:config.requestTimeoutMs,captureOrigin:{actorRole:'tool',kind:'tool-result',sourceActorRole:'tool',sourceContent:content,complete:true,lineageId:'tool:'+String(exec.callId??exec.name)}});
 }catch{ctx.logger.warn?.('[agentOS context] tool result capture failed');}};
 return ctx.on('tools/result',handler);
}
