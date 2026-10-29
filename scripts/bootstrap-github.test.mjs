import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const read=(p)=>readFileSync(join(root,p),'utf8');
describe('bootstrap do GitHub (verificações offline)',()=>{
 it('não executa em diretório com CR IA pré-existente',()=>{
  assert.match(read('scripts/bootstrap-github.sh'),/Já existe \$APP_DIR/);
  assert.match(read('scripts/bootstrap-github.sh'),/Volumes CR IA encontrados/);
 });
 it('token por prompt oculto, clona via askpass, não armazena no remote',()=>{
  const text=read('scripts/bootstrap-github.sh');
  assert.match(text,/read -r -s -p 'Token GitHub/);
  assert.match(text,/GIT_ASKPASS/);
  assert.match(text,/credential\.helper=/);
  assert.doesNotMatch(text,/https:\/\/[^"\s]+\$\{?TOKEN/);
 });
 it('cria segredos com Python e não publica env',()=>{
  assert.match(read('scripts/bootstrap-github.sh'),/cria-generate-env\.py/);
  assert.match(read('.gitignore'),/^\.env$/m);
  assert.match(read('scripts/cria-generate-env.py'),/os\.O_EXCL/);
 });
 it('shell e Python possuem sintaxe válida',()=>{
  const sh=spawnSync('bash',['-n',join(root,'scripts/bootstrap-github.sh'),join(root,'scripts/atualizar-github.sh')],{encoding:'utf8'});
  assert.equal(sh.status,0,sh.stderr);
  const py=spawnSync('python3',['-c',`import ast; ast.parse(open(${JSON.stringify(join(root,'scripts/cria-generate-env.py'))}).read())`],{encoding:'utf8'});
  assert.equal(py.status,0,py.stderr);
 });
});
