"""Extract a bounded installed package/reference baseline; never mutate the installation."""
import json,struct,hashlib
from pathlib import Path
archive=Path(r'D:\DSH Desktop\resources\app.asar')
root=Path(__file__).resolve().parents[1]/'research'/'installed'
package_names=['dsh-opencontext','@deepseek-ai/dsh-client-ui-conversation','@deepseek-ai/dsh-client-ui-settings-plugins','@deepseek-ai/dsh-session','@deepseek-ai/dsh-agent','@deepseek-ai/dsh-api-remotes','@deepseek-ai/dsh-client-ui-primitives']
refs=['references/package-and-profile.md','references/validation-matrix.md','references/rc2-dynamic-runtime.md','scripts/validate-package.mjs']
with archive.open('rb') as f:
    h=f.read(16);_,header_size,_,json_size=struct.unpack('<4I',h)
    if not 0<json_size<100_000_000:raise ValueError('Unexpected ASAR header')
    tree=json.loads(f.read(json_size));data_start=8+header_size
    def get(p):
        node=tree
        for part in p.split('/'):
            node=node.get('files',{}).get(part)
            if node is None:return None
        return node
    def leaves(n,p):
        if 'files' in n:
            for key,val in n['files'].items():yield from leaves(val,p+'/'+key)
        elif 'size' in n:yield p,n
    selected=[]
    for name in package_names:
        prefix='node_modules/'+name;n=get(prefix)
        if n is None:
            print('Missing package: '+name);continue
        entries=list(leaves(n,prefix))
        print(json.dumps({'package':name,'files':[p.removeprefix(prefix+'/') for p,n in entries][:100],'count':len(entries)},ensure_ascii=False))
        if name=='dsh-opencontext': selected.extend(entries)
        else:selected.extend((p,n) for p,n in entries if p.endswith(('.d.ts','package.json','client.js.map')))
    skill='node_modules/dsh-plugin-builder/skills/cordis-plugin-development/'
    for rel in refs:
        node=get(skill+rel)
        if node: selected.append((skill+rel,node))
        else:print('Missing reference: '+rel)
    seen=set();manifest=[]
    for path,node in selected:
        if path in seen:continue
        seen.add(path)
        if node['size']>20_000_000:raise ValueError('Oversized reference '+path)
        dest=root/path.removeprefix('node_modules/')
        dest.parent.mkdir(parents=True,exist_ok=True)
        if dest.exists():raise FileExistsError(dest)
        if node.get('unpacked'):
            data=Path(str(archive)+'.unpacked').joinpath(path).read_bytes()
        else:
            f.seek(data_start+int(node['offset']));data=f.read(node['size'])
        if len(data)!=node['size']:raise ValueError('Truncated entry '+path)
        dest.write_bytes(data)
        manifest.append({'source':path,'output':str(dest),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
    (root/'baseline-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Extracted '+str(len(manifest))+' bounded static files.')
