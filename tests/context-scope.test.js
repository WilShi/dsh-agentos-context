import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GLOBAL_SCOPE_ID,
  createEntityScope,
  resolveContextIdentity,
  scopeKind,
} from '../src/context/scope.js';

test('entity scope ids are canonical, bounded, and cannot collide across dimensions',()=>{
 assert.equal(createEntityScope('user',' employee:demo '),'user:employee%3Ademo');
 assert.equal(createEntityScope('agent','研发 助手'),'agent:%E7%A0%94%E5%8F%91%20%E5%8A%A9%E6%89%8B');
 assert.equal(createEntityScope('app','dsh-desktop'),'app:dsh-desktop');
 assert.equal(createEntityScope('run','session-1'),'run:session-1');
 assert.equal(createEntityScope('workspace','x'),null);
 assert.equal(createEntityScope('user',''),null);
 assert.equal(createEntityScope('user','x\0y'),null);
 assert.equal(scopeKind(GLOBAL_SCOPE_ID),'global');
 assert.equal(scopeKind('local:C:/project'),'workspace');
 assert.equal(scopeKind('session:legacy'),'workspace');
 assert.equal(scopeKind('user:demo'),'user');
});

test('context identity uses only trusted session/config metadata and preserves recall order',()=>{
 const session={id:'session-1',header:{id:'session-1',cwd:'C:/project',agentPreset:'coding',userId:'demo',appId:'desktop'}};
 const identity=resolveContextIdentity({agent:{session},messages:[{userId:'spoof'}]},{scopeId:''});
 assert.equal(identity.scopeId,'local:C:/project');
 assert.deepEqual(identity.scopes.map(row=>row.kind),['run','agent','workspace','user','app','global']);
 assert.deepEqual(identity.recallScopeIds,[
  'run:session-1','agent:coding','local:C:/project','user:demo','app:desktop','dsh-default',
 ]);
 assert.deepEqual(identity.authorizedScopeIds,identity.recallScopeIds);
});

test('missing user and agent identity never creates fabricated scopes',()=>{
 const identity=resolveContextIdentity({agent:{session:{id:'session-2',header:{id:'session-2',cwd:'C:/project'}}}},{});
 assert.deepEqual(identity.scopes.map(row=>row.kind),['run','workspace','global']);
 assert.equal(identity.scopes.some(row=>row.kind==='user'||row.kind==='agent'||row.kind==='app'),false);
});

test('configured entity identities are trusted while a fixed legacy scope remains isolated',()=>{
 const session={id:'s',header:{id:'s',cwd:'C:/project'}};
 const identity=resolveContextIdentity({session},{scopeUserId:'u',scopeAgentId:'a',scopeAppId:'desktop'});
 assert.deepEqual(identity.recallScopeIds,['run:s','agent:a','local:C:/project','user:u','app:desktop','dsh-default']);
 const fixed=resolveContextIdentity({session},{scopeId:'tenant:fixed',scopeUserId:'u'});
 assert.deepEqual(fixed.recallScopeIds,['tenant:fixed']);
 assert.deepEqual(fixed.authorizedScopeIds,['tenant:fixed']);
});