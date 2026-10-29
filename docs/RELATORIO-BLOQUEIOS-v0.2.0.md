# CR IA v0.2.0 — Correção final de bloqueios (23/10/2026)

Auditoria do usuário sobre o ZIP `v0.2.0-final` apontou 3 bloqueios.
Todos corrigidos no projeto existente (nada recomeçado) + testes locais verdes.
Nada aqui toca em SSH/UFW/Fail2ban/Cloudflare Tunnel/Restic-R2 da VPS.

## Bloqueio 1 — ZIP excluía `.env.example` (CORRIGIDO)

- Causa: `EXCLUDE_FILES = [/^\.env(\..*)?$/]` casava `.env.example`.
- Correção (`scripts/make-release-zip.mjs`): regra explícita —
  `.env` nunca entra; `.env.example` sempre entra; `.env.*` (local,
  production…) nunca entra.
- Teste: `make-release-zip.test.mjs` gera o ZIP **real da raiz** e abre com
  `unzip -Z1`, exigindo 20 arquivos de instalação (`.env.example`,
  `docker-compose.yml`, instaladores, backups, Dockerfiles, updater, docs) e
  proibindo `.env`, `node_modules/`, `.git/`, `dist/`, `data/`, `backups/`,
  `*.log`. 3/3 verde.

## Bloqueio 2 — instalador exigia Git e usava 8080 (CORRIGIDO)

- `scripts/deploy-vps-pronta.sh` reescrito: instala do **ZIP extraído** (cópia
  por `tar`, excluindo `.env` do destino e ignorando `.git`), sem Git/REPO_URL.
- Porta **3000** em tudo do app (check de exposição, healthchecks, instruções
  do Tunnel); `WEB_PORT` respeitado do `.env`. SearXNG mantém 8080 **interno**
  do container (padrão do serviço, publicado só em 127.0.0.1:8888).
- Segredos: gera `JWT_SECRET`, `CREDENTIALS_SECRET` (NOVO — faltava),
  `POSTGRES_PASSWORD`, `UPDATER_QUEUE_SECRET` via `openssl rand`, sem
  sobrescrever existentes e **sem imprimir valores**; recusa `ADMIN/GUEST`
  padrão antes de qualquer Docker.
- Teste: `deploy-install.test.mjs` (8/8) executa o script real num diretório
  temporário **sem `.git`**: `--check` ok/falhas honestas, `--apply`
  (para após o `.env` com `CRIA_SKIP_DOCKER=1`) validando cópia, formato dos
  segredos, preservação em re-execução, `.env` do dono intocado, recusa de
  senha padrão e ausência de `git clone`/`REPO_URL`/`8080` no script.
- Docs/scripts varridos: Caddy → 3000 (`install-vps.sh`, INSTALACAO §2.3),
  INSTALACAO §2.2 com fluxo ZIP pronto, fumaça PENDENCIAS → 3000.

## Bloqueio 3 — segurança do updater/socket Docker (CORRIGIDO + AUDITADO)

- **Autenticação da fila**: aprovações/rollbacks levam HMAC-SHA256
  (`UPDATER_QUEUE_SECRET`, mín. 16; fail-closed nos dois lados) + SHA256 da
  árvore do staging. Updater revalida HMAC (timing-safe), confinamento de
  `stagedDir`/`target` (anti `..`), hash idêntico ao aprovado e ausência de
  symlinks — tudo **antes** de qualquer docker/backup/cópia.
- **Privilégios mínimos**: compose com `cap_drop: ALL`,
  `no-new-privileges`, FS raiz só-leitura (+`/tmp` tmpfs); sem `ports`; socket
  só no updater (API nunca). Comandos executados são fixos (rsync/docker/
  migrate/health) — nenhum byte do ZIP é executado.
- **Bug real achado e corrigido pelo teste de interrupção**: retry após morte
  no meio do apply falhava (`scripts/backup.sh` sumia do APP_DIR por causa do
  `--delete`). Agora o updater grava marcador de crash assinado após o
  snapshot e a próxima execução **restaura o snapshot antes de tentar de
  novo** (rollback tem o mesmo tratamento).
- Testes `updater-service.test.mjs` (12/12): legítimo, migração-falha→rollback
  auto, rollback+dbWarning, sem-recibo, **adulteração pós-aprovação, HMAC
  ausente/errado, traversal ×6, symlink, boot sem segredo, trava ocupada,
  SIGKILL→recuperação, marcador forjado**. Recusas provam `docker.log`
  inexistente (zero chamadas ao Docker).
- API: `updates-upload.test.ts` 12/12 (HMAC+SHA no pedido, bloqueio sem
  segredo, hash determinístico/symlink).

## Resultados verificáveis (este ambiente, Node v20.20.2)

| Comando | Resultado |
|---|---|
| `npx tsc --noEmit` (apps/api) | limpo |
| `npm run build` (apps/web) | verde |
| `npx vitest run` (apps/api) | **217 passed / 12 skipped / 0 failed** (229) |
| `npm run test:scripts` | **53/53** (backup 8, compose 8, deploy 8, zip 3, r2-lib 11, update-sh 3, updater 12) |
| `bash -n` em todos os `.sh` alterados | OK |

Skips do vitest (12): integrações que exigem serviço real — cada teste diz o
motivo (PG da VPS, SearXNG daemon, SMTP, R2, chaves pagas, dockerd).

## O que SÓ pode ser homologado na VPS (não executado aqui)

1. `docker compose build/up` + `deploy-vps-pronta.sh --apply` completo
   (aqui: até o `.env`, com shims; dockerd inexistente no sandbox).
2. `docker compose config` (aqui: parse YAML + 8 regras estruturais).
3. Clique real no navegador (login→chat→imagem→admin→updates→agente).
4. Modelos locais, SearXNG daemon, SMTP, R2, migração 0003 no PG, token
   GitHub, 1º restore v0.2.0, rota do túnel → 3000, apply real do updater
   (aqui: shims + health HTTP real).

## Entrega

Novo ZIP `cr-ia-v0.2.0-homolog.zip` (sha256 impresso na geração), pronto para
homologação na VPS de 12 GB seguindo `docs/INSTALACAO.md` §2.2.
