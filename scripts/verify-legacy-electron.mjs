import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const source=path.resolve(process.argv[2]??'');
if(!process.argv[2]||!existsSync(source))throw new Error('Usage: <Electron with ELECTRON_RUN_AS_NODE=1> scripts/verify-legacy-electron.mjs <legacy store.db>');
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const originalHash=digest(source),temp=mkdtempSync(path.join(tmpdir(),'agentos-legacy-verify-')),copy=path.join(temp,'memory','store.db'),sidecarPath=path.join(temp,'agentos-context','context.db');
 mkdirSync(path.dirname(copy),{recursive:true});mkdirSync(path.dirname(sidecarPath),{recursive:true});
let backend,service;
try{
 const sourceDb=new Database(source,{readonly:true,fileMustExist:true});
 try{await sourceDb.backup(copy);}finally{sourceDb.close();}
 const copyDb=new Database(copy,{readonly:true,fileMustExist:true});let quick;
 try{quick=copyDb.pragma('quick_check',{simple:true});}finally{copyDb.close();}
 if(quick!=='ok')throw new Error('legacy snapshot failed quick_check');
 process.env.MEMORY_STORE_DB_PATH=copy;process.env.OPENCONTEXT_HOME=temp;
 const [{createLibBackend},{createContextStore},{createContextService}]=await Promise.all([import('../src/backend-lib.js'),import('../src/context/store.js'),import('../src/context/service.js')]);
 backend=createLibBackend({scopeId:'',timeoutMs:15000,maxRecallItems:8,dedupEnabled:false},{embeddingProvider:null});
 const store=createContextStore({dbPath:sidecarPath});service=createContextService({store,legacy:backend,config:{},defaultScope:()=> 'local:verification'});
 const scopes=await service.listScopes();const inspected=[];let legacyNodes=0,documentNodes=0,edgeCount=0,firstLegacy=null;
 for(const scope of scopes){const memories=await service.listMemories({scopeId:scope.id,limit:500});const graph=await service.graph({scopeId:scope.id,limit:200,depth:4});legacyNodes+=graph.nodes.filter(x=>x.legacy&&x.type==='memory').length;documentNodes+=graph.nodes.filter(x=>x.type==='document').length;edgeCount+=graph.edges.length;firstLegacy??=memories.find(x=>x.legacy);inspected.push({scopeId:scope.id,count:scope.count,listed:memories.length,graphNodes:graph.nodes.length,graphEdges:graph.edges.length});}
 if(!scopes.some(x=>x.count>0)||!firstLegacy||legacyNodes===0)throw new Error('legacy records were not exposed through the compatibility service and graph');
 const revised=await service.reviseMemory({scopeId:firstLegacy.scopeId,id:firstLegacy.id,expectedRevision:firstLegacy.revision,content:firstLegacy.content+'\n[temporary compatibility verification]',reason:'temporary compatibility verification'});
 if(revised.revision<2||!store.getMemory(firstLegacy.scopeId,firstLegacy.id))throw new Error('explicit legacy revision was not isolated into the sidecar');
 await service.close();service=null;await backend.dispose?.();backend=null;
 if(digest(source)!==originalHash)throw new Error('source legacy database changed during read-only verification');
 console.log(JSON.stringify({ok:true,source,quickCheck:quick,scopes:scopes.length,reportedRecords:scopes.reduce((n,x)=>n+x.count,0),legacyGraphNodes:legacyNodes,documentNodes,graphEdges:edgeCount,revisionCopiedToSidecar:true,sourceUnchanged:true,inspected},null,2));
}finally{
 await Promise.allSettled([Promise.resolve().then(()=>service?.close?.()),Promise.resolve().then(()=>backend?.dispose?.())]);
 rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
