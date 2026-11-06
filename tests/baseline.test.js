import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {formatPreparedContext} from '../src/prepared-context.js';
import {containsSecret} from '../src/secrets.js';
test('installed baseline frames evidence as untrusted',()=>{
 const p=formatPreparedContext([{id:'fixture',content:'sample'}],8000);
 assert.equal(p.status,'ready');assert.match(p.content,/untrusted historical evidence/);
});
test('installed baseline handles an empty recall',()=>{
 assert.equal(formatPreparedContext([],8000).status,'empty');
});
test('generic authorization and api-key assignments are blocked before egress',()=>{for(const text of ['Authorization: Bearer abcdefgh12345678','Basic dXNlcjpwYXNzd29yZA==','api_key=abcdef123456'])assert.equal(containsSecret(text),true);});
test('normal fixture text is not a credential',()=>{
 assert.equal(containsSecret('A local design decision with a public issue ID'),false);
});
test('3D point cloud redraws on demand instead of relying on a preserved drawing buffer',()=>{
 const source=readFileSync(new URL('../src-client/ContextGraph3D.tsx',import.meta.url),'utf8');
 // 0.8.0: the buffered frame was the main memory/perf cost; the renderer now
 // uses the compositor default and redraws on visibility change instead.
 assert.match(source,/preserveDrawingBuffer:\s*false/u);
 assert.match(source,/document\.addEventListener\(["']visibilitychange["'],\s*renderWhenVisible\)/u);
});

test('3D point cloud renders an initial frame while hidden and redraws when restored',()=>{
 const source=readFileSync(new URL('../src-client/ContextGraph3D.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(source,/!document\.hidden\)\s*renderer\.render/u);
 assert.match(source,/document\.addEventListener\(["']visibilitychange["'],\s*renderWhenVisible\)/u);
 assert.match(source,/document\.removeEventListener\(["']visibilitychange["'],\s*renderWhenVisible\)/u);
});

test('3D point cloud follows the active light or dark application theme',()=>{
 const source=readFileSync(new URL('../src-client/ContextGraph3D.tsx',import.meta.url),'utf8');
 const styles=readFileSync(new URL('../src-client/Context.module.css',import.meta.url),'utf8');
 assert.match(source,/\? mix\(layer, \{ r: 6, g: 11, b: 18 \}, 0\.58\)\s*: mix\(layer, accent, 0\.055\)/u);
 assert.match(styles,/\.graph3d \{[^}]*--dsw-alias-bg-layer-1/u);
 assert.match(styles,/:is\(body,html\)\[data-ds-dark-theme\] \.graph3d \{/u);
 assert.match(styles,/:is\(body,html\)\[data-ds-dark-theme\] \.graph3dControls button/u);
});