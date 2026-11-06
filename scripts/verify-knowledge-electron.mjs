import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {LibKnowledgeStore} from '../src/knowledge-store.js';
import Database from 'better-sqlite3';

const vector=text=>String(text).toLocaleLowerCase().includes('alpha')?[1,0,0]:String(text).toLocaleLowerCase().includes('beta')?[0,1,0]:[0,0,1];
const provider={getDimensions:()=>3,embedDocuments:async texts=>texts.map(vector),embedQuery:async text=>vector(text)};
const root=await mkdtemp(path.join(tmpdir(),'agentos-knowledge-electron-'));
const dbPath=path.join(root,'knowledge.db');
const started=performance.now();
let store=new LibKnowledgeStore({dbPath,provider});
let degradedStore=null;
try{
 const p=await store.uploadDocument({scopeId:'workspace:p',userId:'workspace:p',filename:'release-guide.md',mimeType:'text/markdown',content:'alpha 发布前必须完成回归测试、引用核对和回滚演练。',metadata:{team:'risk',version:2}});
 for(let index=0;index<24;index++)await store.uploadDocument({scopeId:'workspace:q',userId:'workspace:q',filename:`foreign-${index}.md`,mimeType:'text/markdown',content:`alpha foreign private ${index}`,metadata:{team:'other'}});
 const hybrid=await store.searchKnowledge({scopeId:'workspace:p',userId:'workspace:p',query:'发布前回归测试',limit:10,threshold:0,searchMode:'hybrid'});
 assert.equal(hybrid.chunks[0]?.documentId,p.documentId);
 assert.ok(hybrid.chunks[0]?.metadata.searchModes.includes('keyword'));
 assert.equal(hybrid.chunks.some(hit=>hit.documentName.startsWith('foreign-')),false);
 const semantic=await store.searchKnowledge({scopeId:'workspace:p',userId:'workspace:p',query:'alpha',limit:10,threshold:0,searchMode:'semantic'});
 assert.equal(semantic.chunks[0]?.documentId,p.documentId);
 const keyword=await store.searchKnowledge({scopeId:'workspace:p',userId:'workspace:p',query:'回滚演练',limit:10,threshold:0,searchMode:'keyword',documentIds:[p.documentId],metadata:{team:'risk'}});
 assert.equal(keyword.chunks[0]?.documentId,p.documentId);
 const rejected=await store.searchKnowledge({scopeId:'workspace:p',userId:'workspace:p',query:'回滚演练',limit:10,threshold:0,searchMode:'keyword',metadata:{team:'other'}});
 assert.equal(rejected.chunks.length,0);
 const inspected=await store.listDocumentChunks({scopeId:'workspace:p',userId:'workspace:p',id:p.documentId});
 assert.equal(inspected.document.filename,'release-guide.md');
 assert.ok(inspected.chunks[0].content.includes('回归测试'));
 const rebuilt=await store.reindexDocument({scopeId:'workspace:p',userId:'workspace:p',id:p.documentId});
 assert.equal(rebuilt.reindexed,true);assert.equal(rebuilt.chunks,p.chunks);assert.equal(rebuilt.semanticIndexed,true);
 store.close();
 store=new LibKnowledgeStore({dbPath,provider});
 const reopened=await store.searchKnowledge({scopeId:'workspace:p',userId:'workspace:p',query:'alpha',limit:10,threshold:0,searchMode:'hybrid'});
 assert.equal(reopened.chunks[0]?.documentId,p.documentId);
 const removed=await store.deleteDocuments({scopeId:'workspace:p',userId:'workspace:p',ids:[p.documentId]});
 assert.deepEqual(removed,{deleted:1,requested:1});
 assert.equal((await store.listDocuments({scopeId:'workspace:p',userId:'workspace:p',limit:10})).documents.length,0);
 assert.equal((await store.listDocuments({scopeId:'workspace:q',userId:'workspace:q',limit:100})).documents.length,24);
 const legacyPath=path.join(root,'knowledge-v1.db'),legacyDb=new Database(legacyPath);
 legacyDb.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,scopeId TEXT NOT NULL,userId TEXT NOT NULL,filename TEXT NOT NULL,mimeType TEXT NOT NULL,uploadedAt INTEGER NOT NULL,chunkCount INTEGER NOT NULL DEFAULT 0,metadata TEXT);
 CREATE TABLE chunks(id TEXT PRIMARY KEY,documentId TEXT NOT NULL,chunkIndex INTEGER NOT NULL,content TEXT NOT NULL,metadata TEXT,lexicalIndexed INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE knowledge_terms(term TEXT NOT NULL,chunkId TEXT NOT NULL,frequency INTEGER NOT NULL,PRIMARY KEY(term,chunkId));
 INSERT INTO documents VALUES('doc-legacy','workspace:legacy','workspace:legacy','legacytitle-2024.txt','text/plain',1,1,'{}');
 INSERT INTO chunks VALUES('doc-legacy_chunk_0','doc-legacy',0,'body without the title token','{}',1);
 INSERT INTO knowledge_terms VALUES('body','doc-legacy_chunk_0',1);
 PRAGMA application_id=${0x414f434b}; PRAGMA user_version=1;`);
 legacyDb.close();
 const migrated=new LibKnowledgeStore({dbPath:legacyPath,provider});
 const migratedHits=await migrated.searchKnowledge({scopeId:'workspace:legacy',userId:'workspace:legacy',query:'legacytitle 2024',limit:5,threshold:0,searchMode:'keyword'});
 assert.equal(migratedHits.chunks[0]?.documentId,'doc-legacy');
 migrated.close();
 const migratedDb=new Database(legacyPath,{readonly:true});
 assert.equal(migratedDb.pragma('user_version',{simple:true}),3);
 assert.ok(migratedDb.prepare('PRAGMA table_info(chunks)').all().some(column=>column.name==='lexicalVersion'));
 assert.ok(migratedDb.prepare('PRAGMA table_info(documents)').all().some(column=>column.name==='semanticIndexed'));
 migratedDb.close();
 const nativeFailure=()=>Object.assign(new Error('A dynamic link library (DLL) initialization routine failed. Windows error 1114'),{code:'ERR_DLOPEN_FAILED'});
 degradedStore=new LibKnowledgeStore({
  dbPath:path.join(root,'knowledge-native-fallback.db'),
  provider:{
   getModelName:()=> 'local-onnx',
   getDimensions:()=>384,
   embedDocuments:async()=>{throw nativeFailure()},
   embedQuery:async()=>{throw nativeFailure()},
  },
 });
 const degradedUpload=await degradedStore.uploadDocument({scopeId:'dsh-default',userId:'dsh-default',filename:'onnx-fallback.md',mimeType:'text/markdown',content:'DXP sync job data dictionary and field definitions',metadata:{}});
 assert.equal(degradedUpload.semanticIndexed,false);
 assert.equal(degradedUpload.semanticPending,true);
 assert.equal(degradedUpload.semanticErrorCode,'ERR_DLOPEN_FAILED');
 const degradedSearch=await degradedStore.searchKnowledge({scopeId:'dsh-default',userId:'dsh-default',query:'DXP sync job data dictionary',limit:5,threshold:0,searchMode:'hybrid'});
 assert.equal(degradedSearch.chunks[0]?.documentId,degradedUpload.documentId);
 assert.deepEqual(degradedSearch.chunks[0]?.metadata.searchModes,['keyword']);
 console.log(JSON.stringify({ok:true,hybridModes:hybrid.chunks[0].metadata.searchModes,scopeIsolation:true,reopen:true,reindex:true,batchDelete:true,v1Migration:true,nativeEmbeddingFallback:{errorCode:degradedUpload.semanticErrorCode,hits:degradedSearch.chunks.length,modes:degradedSearch.chunks[0].metadata.searchModes},elapsedMs:Number((performance.now()-started).toFixed(1))}));
}finally{
 degradedStore?.close();
 store.close();
 await rm(root,{recursive:true,force:true});
}
