import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(root, 'scripts', 'reinstalar-limpo-vps-atual.sh');
const script = readFileSync(path, 'utf8');

describe('Reinstalação limpa somente da CR IA', () => {
  it('tem sintaxe bash válida', () => {
    const p = spawnSync('bash', ['-n', path], { encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
  });
  it('separa diagnóstico de operação destrutiva e exige duas confirmações', () => {
    assert.match(script, /MODE=\$\{1:---check\}/);
    assert.match(script, /DIAGNOSTICO OK/);
    assert.match(script, /ZERAR CR IA/);
    assert.match(script, /EXCLUIR DADOS CR IA/);
    assert.match(script, /\[\[ -t 0 \]\]/);
  });
  it('mantém backups antes de remover volumes', () => {
    const backup = script.indexOf('pg_dump');
    const verify = script.indexOf('pg_restore -l');
    const cleanup = script.indexOf('docker volume rm');
    assert.ok(backup > 0 && verify > backup && cleanup > verify);
    assert.match(script, /\$BACKUP\/app-antigo/);
  });
  it('não usa limpeza global, não mexe no SSH, no firewall e nem no túnel', () => {
    assert.doesNotMatch(script, /docker\s+(system|image|volume)\s+prune/);
    assert.doesNotMatch(script, /docker\s+compose[^\n]*down\s+-v\b/);
    assert.doesNotMatch(script, /systemctl\s+(stop|restart|disable)\s+cloudflared/);
    assert.doesNotMatch(script, /ufw\s+(disable|reset|allow|deny)/);
    assert.doesNotMatch(script, /sshd_config/);
    assert.match(script, /VOLUMES=\(cr-ia_pgdata/);
  });
  it('clona o repositorio e recria as credenciais localmente', () => {
    assert.match(script, /github\.com\/rykellmy31-star\/CR-ia\.git/);
    assert.match(script, /cria-generate-env\.py/);
    assert.match(script, /instalar-menu\.sh/);
  });
});
