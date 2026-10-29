import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(ROOT, 'scripts', name), 'utf8');

describe('Menu SSH da CR IA (offline)', () => {
  it('comando global menu é criado por instalador e bootstrap', () => {
    assert.match(read('instalar-menu.sh'), /\/usr\/local\/bin\/menu/);
    assert.match(read('bootstrap-github.sh'), /scripts\/instalar-menu\.sh/);
  });
  it('menu tem as duas atualizações separadas e opções de segurança', () => {
    const s=read('cria-menu.sh');
    assert.match(s, /Atualizar sistema de IA/);
    assert.match(s, /Atualizar script\/instalador/);
    assert.match(s, /Fazer backup agora/);
    assert.match(s, /logs --tail/);
    assert.match(s, /\! -d "\$APP\/\.git"/);
    assert.doesNotMatch(s, /cat\s+.*\.env/);
  });
  it('atualização de scripts não sobrescreve fonte da aplicação', () => {
    const s=read('atualizar-instalador.sh');
    assert.match(s, /git -C "\$APP" show/);
    assert.match(s, /bash -n "\$TMP\/\$f"/);
    assert.match(s, /anteriores/);
    assert.doesNotMatch(s, /git\s+reset/);
    assert.doesNotMatch(s, /docker compose up/);
  });
  it('GitHub público funciona sem token, privado solicita token sem eco', () => {
    for (const filename of ['bootstrap-github.sh', 'atualizar-github.sh','atualizar-instalador.sh']) {
      const s=read(filename);
      assert.match(s, /GIT_TERMINAL_PROMPT=0/);
      assert.match(s, /read -r -s -p 'Token GitHub/);
      assert.match(s, /credential\.helper=/);
    }
  });
  it('backup usa credenciais do container e não usuário fixo', () => {
    const s=read('backup.sh');
    assert.match(s, /\$POSTGRES_USER/);
    assert.match(s, /\$POSTGRES_DB/);
    assert.doesNotMatch(s, /-U cr_ia/);
  });
  it('scripts bash passam análise de sintaxe', () => {
    const names=['cria-menu.sh','instalar-menu.sh','atualizar-instalador.sh','atualizar-github.sh','bootstrap-github.sh','backup.sh','restore.sh'];
    const r=spawnSync('bash',['-n',...names.map(n=>join(ROOT,'scripts',n))],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
  });
});
