import test from 'node:test';
import assert from 'node:assert/strict';
import {registerSkill} from '../src/skill.js';
import {registerTools} from '../src/tools.js';
import {registerKnowledgeTools} from '../src/tools-knowledge.js';
import {registerSummaryTools} from '../src/tools-summary.js';
import {registerInsightsTools} from '../src/tools-insights.js';
import {SKILL_BODY} from '../src/skill-body.js';

test('agentOS context runtime skill satisfies the RC2 registration contract',()=>{
 let registration;
 let disposed=0;
 let injectionDisposed=0;
 const ctx={
  inject(dependencies,callback){
   assert.deepEqual(dependencies,['skills']);
   callback({skills:{register(value){registration=value;return()=>{disposed++;};}}});
   return()=>{injectionDisposed++;};
  },
 };
 const dispose=registerSkill(ctx);
 assert.equal(registration.name,'agentos-context');
 assert.equal(registration.source,'runtime');
 assert.equal(typeof registration.content,'string');
 assert.match(registration.content,/agentOS context/u);
 dispose();
 assert.equal(disposed,1);
 assert.equal(injectionDisposed,1);
});

test('runtime skill documents every descriptive public tool and prefers no oc alias',()=>{
 const names=[];
 const ctx={tools:{register(tool){names.push(tool.name);return()=>{};}}};
 const runtime={backend:{},config:{}};
 const identity=value=>value;
 registerTools(ctx,runtime,identity);
 registerKnowledgeTools(ctx,runtime,identity);
 registerSummaryTools(ctx,runtime,identity);
 registerInsightsTools(ctx,runtime,identity);
 const publicNames=[...new Set(names.filter(name=>/^(?:memory|knowledge|context)_/u.test(name)))].sort();
 assert.deepEqual(publicNames,[
  'context_prepare',
  'knowledge_document_chunks',
  'knowledge_document_delete',
  'knowledge_document_list',
  'knowledge_document_reindex',
  'knowledge_document_upload',
  'knowledge_search',
  'memory_capture_source',
  'memory_get',
  'memory_insight_capture',
  'memory_insights_search',
  'memory_list',
  'memory_recent_summaries',
  'memory_retire',
  'memory_revise',
  'memory_save',
  'memory_search',
  'memory_session_summary',
  'memory_task_outcome',
 ]);
 for(const name of publicNames)assert.match(SKILL_BODY,new RegExp('`'+name+'(?:\\s|\\s*\\{)','u'),name);
 for(const alias of names.filter(name=>name.startsWith('oc_')))assert.doesNotMatch(SKILL_BODY,new RegExp('`'+alias+'\\s*\\{','u'),alias);
 assert.match(SKILL_BODY,/Never choose an\s+`oc_\*` alias/u);
});
