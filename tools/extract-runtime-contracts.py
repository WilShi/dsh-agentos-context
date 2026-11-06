import json,struct
from pathlib import Path
archive=Path(r'D:\DSH Desktop\resources\app.asar')
root=Path(__file__).resolve().parents[1]/'research'/'contracts'
prefixes=['node_modules/@deepseek-ai/dsh-client-ui-conversation','node_modules/@deepseek-ai/dsh-client-ui-primitives','node_modules/@deepseek-ai/dsh-client-ui-settings-plugins','node_modules/@deepseek-ai/dsh-client-ui-renderer','node_modules/@deepseek-ai/dsh-agent','node_modules/@deepseek-ai/dsh-session','node_modules/@deepseek-ai/dsh-web','node_modules/@deepseek-ai/dsh-api-remotes']
with archive.open('rb') as f:
 h=f.read(16);_,size,_,n=struct.unpack('<4I',h);tree=json.loads(f.read(n));start=8+size
 def get(p):
  node=tree
  for k in p.split('/'):
   node=node.get('files',{}).get(k)
   if node is None:return None
  return node
 def walk(node,p):
  if 'files' in node:
   for k,v in node['files'].items():yield from walk(v,p+'/'+k)
  elif 'size' in node:yield p,node
 selected=[]
 for p in prefixes:
  node=get(p)
  if node:selected.extend(walk(node,p))
  else:print('not present: '+p)
 for p in ['package.json','cordis.patch.yml']:
  node=get(p)
  if node:selected.append((p,node))
 for p,node in selected:
  if not p.endswith(('.js','.json','.css','.md','.yml','.yaml')):continue
  dest=root/p.removeprefix('node_modules/');dest.parent.mkdir(parents=True,exist_ok=True)
  if dest.exists():raise FileExistsError(dest)
  if node.get('unpacked'):data=Path(str(archive)+'.unpacked').joinpath(p).read_bytes()
  else:f.seek(start+int(node['offset']));data=f.read(node['size'])
  if len(data)!=node['size']:raise ValueError(p)
  dest.write_bytes(data)
 print('Extracted runtime contracts: '+str(len(selected)))
