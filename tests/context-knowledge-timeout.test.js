import test from 'node:test';
import assert from 'node:assert/strict';
import {createLibBackend} from '../src/backend-lib.js';

const delay=(value,ms=20)=>new Promise(resolve=>setTimeout(()=>resolve(value),ms));

test('large knowledge operations do not inherit the short interactive timeout',async()=>{
 const knowledgeStore={
  uploadDocument:()=>delay({documentId:'doc-1',chunks:2}),
  searchKnowledge:()=>delay({chunks:[{id:'chunk-1'}]}),
  listDocuments:()=>delay({documents:[]}),
  deleteDocument:()=>delay({deleted:true}),
  close(){},
 };
 const backend=createLibBackend({scopeId:'scope',timeoutMs:2,knowledgeUploadTimeoutMs:100,knowledgeSearchTimeoutMs:100},{knowledgeStore});
 assert.deepEqual(await backend.uploadDocument({content:'text',filename:'a.txt',mimeType:'text/plain'}),{documentId:'doc-1',chunks:2});
 assert.deepEqual(await backend.searchKnowledge({query:'text',limit:2}),{chunks:[{id:'chunk-1'}]});
 await assert.rejects(backend.listDocuments({limit:2}));
 await assert.rejects(backend.uploadDocument({content:'text',filename:'a.txt',mimeType:'text/plain'},{timeoutMs:2}));
 await backend.dispose();
});
