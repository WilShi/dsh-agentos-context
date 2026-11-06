import path from 'node:path';
import {mkdirSync} from 'node:fs';
function explicit(value){
 if(value===undefined||value===null||value==='')return null;
 if(typeof value!=='string'||value.length>4096||value.includes('\0')||!/^(?:[A-Za-z]:[\\/]|\/)/.test(value)||/^(?:https?:|file:|\\\\|\/\/)/i.test(value))throw Object.assign(new Error('agentOS context 数据库路径必须是本机绝对路径'),{code:'INVALID_INPUT'});
 return path.normalize(value);
}
export function resolveContextDbPath(config={},env=process.env,openContextDir){
 if(typeof openContextDir!=='string'||!path.isAbsolute(openContextDir))throw Object.assign(new Error('OpenContext 数据目录无效'),{code:'INVALID_INPUT'});
 const dshHome=explicit(env.DSH_HOME);
 // Config (Settings/patch) wins; the environment variable only supplies the
 // default for deployments that do not edit the profile (HOST-REVIEW M4).
 return explicit(config.contextDbPath)??explicit(env.AGENTOS_CONTEXT_DB_PATH)??(dshHome?path.join(dshHome,'data','agentos-context','context.db'):path.join(openContextDir,'agentos-context','context.db'));
}
export function prepareContextDbPath(config,env,openContextDir){const dbPath=resolveContextDbPath(config,env,openContextDir);mkdirSync(path.dirname(dbPath),{recursive:true});return dbPath;}
