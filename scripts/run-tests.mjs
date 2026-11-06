import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve('tests');
const filter=process.argv[2];
const names=(await readdir(root)).filter(x=>x.endsWith('.test.js')&&(!filter||x.includes(filter))).sort();
if(!names.length)throw new Error('No matching tests');
for(const name of names)await import(pathToFileURL(path.join(root,name)).href);
