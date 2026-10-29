/** Verifica a interface do empacotador e não exige a CLI externa no CI. */
import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const cmd=join(root,'scripts/sign-release.mjs');
describe('sign-release usa Minisign OFICIAL',()=>{
 it('recusa operação sem argumentos',()=>{
   const result=spawnSync('node',[cmd],{encoding:'utf8'});
   assert.notEqual(result.status,0);
   assert.match(result.stderr,/Uso:/);
 });
 it('não gera chaves privadas customizadas via Node',()=>{
   const src=readFileSync(cmd,'utf8');
   assert.match(src,/minisign\(\['-G'/);
   assert.match(src,/minisign\(\['-S'/);
   assert.match(src,/minisign\(\['-V'/);
   assert.doesNotMatch(src,/generateKeyPairSync/);
 });
});
