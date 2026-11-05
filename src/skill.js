/** Register the user-facing agentOS context skill through the target ctx.skills service. */
import {SKILL_BODY} from './skill-body.js';
export function registerSkill(ctx){
 let registered=()=>{};
 const stop=ctx.inject(['skills'],skillCtx=>{registered=skillCtx.skills.register({name:'agentos-context',description:'How agentOS context provides durable memory, knowledge retrieval, typed relationships, sources, and grounded recall.',source:'runtime',content:SKILL_BODY});});
 return()=>{try{registered();}finally{if(typeof stop==='function')stop();}};
}
