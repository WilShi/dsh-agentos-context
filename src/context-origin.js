import {resolveContextIdentity} from './context/scope.js';
/** Source roles are authorization evidence from the runtime, never inferred from text. */
export function messageText(message) {
 if(typeof message?.content==='string')return message.content.trim();
 if(!Array.isArray(message?.content))return '';
 return message.content.filter(b=>b&&b.type==='text'&&typeof b.text==='string').map(b=>b.text).join('\n').trim();
}
export function isHumanMessage(message) {
 return message?.role==='user'&&message?.source?.kind==='user';
}
export function humanMessageRows(messages) {
 if(!Array.isArray(messages))return [];
 const seen=new Set();const rows=[];
 for(const message of messages){
  if(!isHumanMessage(message))continue;
  const text=messageText(message);if(!text)continue;
  const id=typeof message.id==='string'?message.id:'';
  if(id&&seen.has(id))continue;if(id)seen.add(id);
  rows.push({id,text});
 }
 return rows;
}
export function sessionIdentity(payload,config={}) {
 return resolveContextIdentity(payload,config);
}
