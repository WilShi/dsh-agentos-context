/** One scope resolver prevents no-cwd sessions from splitting reads, writes and UI state. */
export const GLOBAL_SCOPE_ID='dsh-default';
export const ENTITY_SCOPE_KINDS=Object.freeze(['run','agent','workspace','user','app','global']);

function sessionOf(value){return value?.agent?.session??value?.session??value;}
function cleanIdentity(value){
 if(typeof value!=='string')return null;
 const normalized=value.normalize('NFKC').trim();
 if(!normalized||normalized.length>512||/[\0-\x1f\x7f]/u.test(normalized))return null;
 return normalized;
}
function configured(config,key){return cleanIdentity(config?.[key]);}
function trustedSessionIdentity(session,key){
 const header=session?.header;
 const direct=cleanIdentity(header?.[key]);
 if(direct)return direct;
 const nested=cleanIdentity(header?.identity?.[key]);
 if(nested)return nested;
 return cleanIdentity(session?.identity?.[key]);
}

export function createEntityScope(kind,value){
 if(!['run','agent','user','app'].includes(kind))return null;
 const clean=cleanIdentity(value);if(!clean)return null;
 try{return kind+':'+encodeURIComponent(clean);}catch{return null;}
}

export function scopeKind(scopeId){
 if(scopeId===GLOBAL_SCOPE_ID)return'global';
 if(typeof scopeId!=='string')return'unknown';
 if(scopeId.startsWith('local:')||scopeId.startsWith('session:'))return'workspace';
 const kind=scopeId.slice(0,scopeId.indexOf(':'));
 return ['run','agent','user','app'].includes(kind)?kind:'unknown';
}

export function resolveContextScope(input={},config={}){
 const explicit=input?.scopeId??config?.scopeId;if(typeof explicit==='string'&&explicit.trim())return explicit.trim();
 const session=sessionOf(input);const cwd=session?.header?.cwd??input?.cwd;if(typeof cwd==='string'&&cwd.trim())return 'local:'+cwd;
 const id=session?.id??session?.header?.id;if(typeof id==='string'&&id.trim())return 'session:'+id;
 return 'local:default';
}

export function resolveContextSessionId(input={}){const session=sessionOf(input);const id=session?.id??session?.header?.id;return typeof id==='string'&&id.trim()?id:'session-unknown';}

/**
 * Resolve only identities owned by the runtime/session header or local plugin
 * configuration. Message metadata is intentionally ignored so model/user text
 * cannot select another person's memory partition.
 */
export function resolveContextIdentity(input={},config={}){
 const session=sessionOf(input),sessionId=resolveContextSessionId(session),workspaceScope=resolveContextScope(input,config);
 if(typeof config?.scopeId==='string'&&config.scopeId.trim()){
  const fixed=config.scopeId.trim();
  return{session,sessionId,scopeId:fixed,workspaceScope:fixed,scopes:[{kind:scopeKind(fixed),id:fixed}],recallScopeIds:[fixed],authorizedScopeIds:[fixed]};
 }
 const rows=[];
 const add=(kind,id)=>{if(id&&!rows.some(row=>row.id===id))rows.push({kind,id});};
 add('run',sessionId==='session-unknown'?null:createEntityScope('run',sessionId));
 add('agent',createEntityScope('agent',configured(config,'scopeAgentId')??trustedSessionIdentity(session,'agentId')??cleanIdentity(session?.header?.agentPreset)));
 add('workspace',workspaceScope);
 add('user',createEntityScope('user',configured(config,'scopeUserId')??trustedSessionIdentity(session,'userId')));
 add('app',createEntityScope('app',configured(config,'scopeAppId')??trustedSessionIdentity(session,'appId')));
 add('global',GLOBAL_SCOPE_ID);
 const ids=rows.map(row=>row.id);
 return{session,sessionId,scopeId:workspaceScope,workspaceScope,scopes:rows,recallScopeIds:ids,authorizedScopeIds:ids};
}
