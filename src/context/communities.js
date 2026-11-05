/** Deterministic Louvain-style community projection for bounded context graphs. */
const EPSILON=1e-9;

function edgeWeight(edge){
 const explicit=Number(edge?.weight);if(Number.isFinite(explicit)&&explicit>0)return Math.min(100,explicit);
 if(edge?.status==='pending')return .55;
 if(edge?.status==='confirmed')return 1.35;
 if(edge?.type==='mentions')return 1.2;
 if(edge?.type==='session')return .45;
 return 1;
}
function hash(value){let out=2166136261;for(let i=0;i<value.length;i++){out^=value.charCodeAt(i);out=Math.imul(out,16777619);}return(out>>>0).toString(36);}
function flat(value){return String(value??'').replace(/<\/?(?:path|file|url|workspace)>/giu,'').replace(/\s+/gu,' ').trim();}

export function detectGraphCommunities(graph){
 const nodes=[...(graph?.nodes??[])].sort((a,b)=>String(a.id).localeCompare(String(b.id))),ids=new Set(nodes.map(node=>node.id));
 if(!nodes.length)return[];
 const adjacency=new Map(nodes.map(node=>[node.id,new Map()])),degree=new Map(nodes.map(node=>[node.id,0]));
 for(const edge of graph?.edges??[]){
  if(!ids.has(edge.source)||!ids.has(edge.target)||edge.source===edge.target)continue;
  const weight=edgeWeight(edge),a=adjacency.get(edge.source),b=adjacency.get(edge.target);
  a.set(edge.target,(a.get(edge.target)??0)+weight);b.set(edge.source,(b.get(edge.source)??0)+weight);
  degree.set(edge.source,(degree.get(edge.source)??0)+weight);degree.set(edge.target,(degree.get(edge.target)??0)+weight);
 }
 const totalDegree=[...degree.values()].reduce((sum,value)=>sum+value,0);
 const membership=new Map(nodes.map(node=>[node.id,node.id]));
 const totals=new Map(nodes.map(node=>[node.id,degree.get(node.id)??0]));
 if(totalDegree>0){
  const order=[...nodes].sort((a,b)=>(degree.get(b.id)??0)-(degree.get(a.id)??0)||String(a.id).localeCompare(String(b.id)));
  for(let pass=0;pass<24;pass++){
   let moved=false;
   for(const node of order){
    const id=node.id,current=membership.get(id),nodeDegree=degree.get(id)??0;
    if(nodeDegree<=0)continue;
    totals.set(current,(totals.get(current)??0)-nodeDegree);
    const weights=new Map([[current,0]]);
    for(const [neighbor,weight] of adjacency.get(id)){const community=membership.get(neighbor);weights.set(community,(weights.get(community)??0)+weight);}
    let best=current,bestGain=(weights.get(current)??0)-nodeDegree*(totals.get(current)??0)/totalDegree;
    for(const [community,inside] of [...weights].sort(([a],[b])=>String(a).localeCompare(String(b)))){
     const gain=inside-nodeDegree*(totals.get(community)??0)/totalDegree;
     if(gain>bestGain+EPSILON||(Math.abs(gain-bestGain)<=EPSILON&&String(community)<String(best))){best=community;bestGain=gain;}
    }
    membership.set(id,best);totals.set(best,(totals.get(best)??0)+nodeDegree);if(best!==current)moved=true;
   }
   if(!moved)break;
  }
 }
 const groups=new Map();for(const node of nodes){const key=membership.get(node.id);const members=groups.get(key)??[];members.push(node);groups.set(key,members);}
 const communities=[];
 for(const members of groups.values()){
  members.sort((a,b)=>(degree.get(b.id)??0)-(degree.get(a.id)??0)||(b.importance??0)-(a.importance??0)||String(a.id).localeCompare(String(b.id)));
  const memberIds=members.map(node=>node.id).sort(),memberSet=new Set(memberIds),internal=[],external=[];
  for(const edge of graph?.edges??[]){const source=memberSet.has(edge.source),target=memberSet.has(edge.target);if(source&&target)internal.push(edge);else if(source||target)external.push(edge);}
  const typeCounts={};for(const node of members)typeCounts[node.type]=(typeCounts[node.type]??0)+1;
  const names=members.map(node=>flat(node.label)).filter(Boolean).slice(0,2),label=names.join('、')+(members.length>2?` 等 ${members.length} 项`:'')||`社区 ${communities.length+1}`;
  communities.push({id:'community:'+hash(memberIds.join('\0')),label,summary:`聚合 ${members.length} 个节点、${internal.length} 条内部关系，并连接 ${external.length} 条跨社区关系。`,nodeIds:memberIds,size:members.length,edgeCount:internal.length,externalEdgeCount:external.length,topNodeIds:members.slice(0,5).map(node=>node.id),typeCounts,scopeId:members[0]?.scopeId??''});
 }
 return communities.sort((a,b)=>b.size-a.size||b.edgeCount-a.edgeCount||a.id.localeCompare(b.id));
}

export function withGraphCommunities(graph){
 const base={nodes:[...(graph?.nodes??[])],edges:[...(graph?.edges??[])],stats:{nodeCount:graph?.nodes?.length??0,edgeCount:graph?.edges?.length??0,truncated:!!graph?.stats?.truncated,...(graph?.stats??{})}};
 const communities=detectGraphCommunities(base),byNode=new Map();for(const community of communities)for(const id of community.nodeIds)byNode.set(id,community.id);
 const nodes=base.nodes.map(node=>({...node,communityId:byNode.get(node.id)}));
 const cross=new Map();
 for(const edge of base.edges){const a=byNode.get(edge.source),b=byNode.get(edge.target);if(!a||!b||a===b)continue;const [source,target]=a<b?[a,b]:[b,a],key=source+'\0'+target,row=cross.get(key)??{id:'community-edge:'+hash(key),source,target,count:0,types:[]},types=new Set(row.types);row.count++;types.add(edge.type);row.types=[...types].sort();cross.set(key,row);}
 return{...base,nodes,communities,communityEdges:[...cross.values()].sort((a,b)=>a.id.localeCompare(b.id)),stats:{...base.stats,communityCount:communities.length}};
}
