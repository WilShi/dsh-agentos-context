import test from 'node:test';
import assert from 'node:assert/strict';
import {detectGraphCommunities,withGraphCommunities} from '../src/context/communities.js';

const nodes='abcdef'.split('').map(id=>({id,type:'entity',label:id.toUpperCase(),scopeId:'p'}));
const edge=(source,target,weight=1)=>({id:source+'-'+target,source,target,type:'related_to',status:'confirmed',weight});
const clustered={nodes,edges:[edge('a','b'),edge('b','c'),edge('a','c'),edge('d','e'),edge('e','f'),edge('d','f'),edge('c','d',.05)],stats:{nodeCount:6,edgeCount:7,truncated:false}};

test('community detection is deterministic and separates strongly connected groups',()=>{
 const first=detectGraphCommunities(clustered),second=detectGraphCommunities({nodes:[...nodes].reverse(),edges:[...clustered.edges].reverse()});
 assert.deepEqual(first,second);assert.equal(first.length,2);
 const sets=first.map(row=>row.nodeIds.join('')).sort();assert.deepEqual(sets,['abc','def']);
});

test('community projection keeps original cross-community edges and adds aggregate edges',()=>{
 const graph=withGraphCommunities(clustered);
 assert.equal(graph.edges.length,7);assert.equal(graph.communityEdges.length,1);assert.equal(graph.communityEdges[0].count,1);
 assert.ok(graph.nodes.every(node=>typeof node.communityId==='string'));
 assert.equal(graph.stats.communityCount,2);
});

test('small and disconnected graphs remain stable without dangling community data',()=>{
 const graph=withGraphCommunities({nodes:[{id:'solo',type:'memory',label:'Solo',scopeId:'p'}],edges:[],stats:{nodeCount:1,edgeCount:0,truncated:true}});
 assert.equal(graph.communities.length,1);assert.deepEqual(graph.communities[0].nodeIds,['solo']);assert.deepEqual(graph.communityEdges,[]);assert.equal(graph.stats.truncated,true);
});
