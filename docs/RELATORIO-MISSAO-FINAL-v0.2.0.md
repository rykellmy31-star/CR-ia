# CR IA v0.2.0 — Relatório da MISSÃO FINAL (23/10/2026)

Evolução direta do projeto auditado (sem recriar, sem trocar infra).
Destino: VPS OVHcloud pronta (Ubuntu 26.04, 6 vCores, 12 GB RAM, Docker + UFW +
Fail2ban + chave SSH + túnel Cloudflare `ia.crjornada.com`). Nada neste ciclo
reinstala o servidor nem toca em SSH/UFW/Fail2ban/túnel/backups existentes.
Nenhuma credencial real foi colocada no código ou no ZIP.

## 1. O que foi corrigido/implementado (por § da missão)

### §2 Docker/Compose (revisão completa)
- `apps/api` e `worker`: `ENV *` passava ~30 variáveis — agora espalham **todo** o
  `env` (antes caíam `CREDENTIALS_SECRET`, `GROQ_API_KEY`, `OPENROUTER_*`, `UPDATES_*`…).
- `CREDENTIALS_SECRET` ausente = **abort de boot** (fail-closed), não cofre aberto.
- App na porta **3000** (era 8080); `docs/TUNEL-CLOUDFLARE.md` atualizado (túnel → 3000).
- Healthchecks em api/web/worker/searxng; `USER node` (não-root) + `npm ci` nos
  Dockerfiles; `searxng/settings.yml` com JSON habilitado; nginx com upload 300M/600s
  (necessário p/ ZIPs de atualização); `migrate.ts` e `update.sh` fail-hard.
- `npm audit --omit=dev`: 1 alta restante (`xlsx`, "No fix available") — risco aceito
  e registrado; nada secreto vaza em log (redação central em `lib/redact.ts`).

### §3 ZIP instalador
- `scripts/make-release-zip.mjs` (reproduzível: contagem + sha256 impressos, recusa
  sobrescrever sem `--force`, nunca embala `.env`/logs/node_modules/dist).
- `update.sh --zip` idempotente (guarda recibo de verificação; sem recibo = recusa).

### §4 Central de Atualizações v2 (upload de ZIP assinado)
- Pipeline real em `apps/api/src/services/update-upload.ts`: validação de
  tamanho/formato/integridade → assinatura **minisign obrigatória** (rejeita sem
  assinatura) → anti ZIP-slip/symlink → detecção de versão → staging isolado →
  checks → confirmação do admin → aplicação por **serviço separado**
  (`apps/updater/updater-service.mjs`, Dockerfile próprio, no compose) →
  migrations controladas → pós-healthchecks → histórico com redação → rollback.
- `updater-service.test.mjs`: 4/4 (apply aprovado, rollback auto em migrate-fail,
  rollback + dbWarning, recusa sem recibo). Docker/rsync são shims nos testes;
  os reais rodam só na VPS.
- `UpdateCenter.tsx` v2 (upload+assinatura, relatório, checks, teste em staging,
  aprovar, rollback, histórico). `npm run build` verde.
- 9/9 testes de upload com rota real + fixtures minisign geradas no teste.

### §5 Agente desenvolvedor real (4 repos, sem patch humano obrigatório)
- Autonomia LLM: plano (≤8 arquivos, denylist, sem `..`/absoluto) → conteúdos
  integrais (≤100 KB, NUL rejeitado) → aplica → testa → commita. 25/25 testes.
- **Gate fail-closed `agentRunnable`**: host exige flag explícita e é **proibido em
  produção**; docker/auto com sonda cacheada (60s); UI (`AgentView`) mostra banner
  "desativado + motivo" e desabilita Nova execução quando `runnable=false`.
- **Correção iterativa**: teste falhou (modo autônomo) → LLM corrotor → retesta, até
  `AGENT_FIX_ATTEMPTS` (padrão 2, máx 5); limite esgotado = falha honesta nomeada.
- Criação unificada `createAgentRunAndTask` (POST /runs + `/agente` no chat, admin):
  allowlist → comandos → gate de isolamento → branch (default real do GitHub) → run+tarefa+audit.
- Comando `/agente <repo> <tarefa…>` no chat (antes do resolveModel; não gasta LLM).
- BUG REAL corrigido: `githubListTree` ignorava branch explícito ("dev" virava o
  default) — agora só resolve o default quando o pedido é "main".
- Contrato HTTP do GitHub (URLs/métodos/auth Bearer/erros 401/403/404/422) provado
  com fetch stub; GitHub real só na VPS com token do dono.
- Push/PR/merge **sempre** exigem aprovação (sem flag para desligar); `/policy`
  expõe `runnable/engine/isolationDetail/disabledReason`.
- Testes novos: `agent-runnable` (9), `agent-fix` E2E com git+node reais (2),
  `agent-command` rotas+parser+gates (11), `github` contrato (6).

### §6 Seletor de IA + BLOCK_PAID
- `BLOCK_PAID_PROVIDERS` aplicado na execução (chat pago explícito = 403;
  modelo sem chave = 412 com "Configurar API", antes mascarado de 502).
- Catálogo com licenças verificadas (Apache-2.0 vs Community vs ToU custom;
  FLUX-dev e Qwen-Image-2.1 marcados não-comerciais); provedores sem chave mostram
  "Indisponível — Configurar API"; nunca se promete grátis ilimitado.

### §7 12 GB sem GPU
- Regra XOR de perfis no compose (documentada no cabeçalho); modelos quantizados
  um-por-vez; limites de concorrência; RAM validada por perfil (não sobe tudo junto).

### §8 Busca web grátis real
- SearXNG local validado de verdade (37 resultados; `live-searxng.test.ts`
  2 passed/1 skipped); JSON habilitado no settings; SSRF guard + timeouts mantidos;
  Brave/Tavily/Google opcionais e honestos (stub-provados, zero chamadas sem chave).

### §9 Estúdio de imagem sem GPU
- Pollinations LIVE (~5,8 s por imagem); ToS registrado (Pollen horário acabou em
  2026-07-10; Classic best-effort 1 req/15 s; `commercial_ok` DESCONHECIDO —
  não se afirma autorização comercial); histórico/ver/download/choice/limites.

### §10 Backups (reescrito neste ciclo)
- `backup.sh`/`restore.sh` v0.2.0: dumps em `/opt/cr-ia/data/cr-ia-dumps` (subdir
  NOVO dentro da árvore do Restic — rotina existente os replica; **nenhum**
  comando toca no repo Restic/snapshots); `pg_dump --clean --if-exists` +
  `pg_dumpall --globals-only` (consistente; nunca cópia de PG vivo); staging
  atômico + `manifest-<STAMP>.json` com SHA256 publicado **por último**
  (anti-parcial); retenção por conjuntos (14, piso 2, só padrões próprios);
  restore por STAMP com SHA conferido + confirmação digitada + backup de segurança.
- 8 guardas novos em `npm run test:scripts` (28/28 verde); recuperação isolada
  documentada (INSTALACAO §2.4). `.env.example` limpo (vars mortas removidas).

### §11 Segurança
- Auditoria aplicada: auth/sessões/admin/cofre/uploads/cmd-injection/prompt-injection/
  acesso/update/agente/limites/logs/SSRF; `CREDENTIALS_SECRET` obrigatório;
  segredos redigidos nos históricos (`lib/redact.ts`); nenhum segredo em saída de teste.

### §12–13 Testes e gates
- API: **214 passed / 12 skipped / 0 failed** (31 arquivos). Skips = integrações que
  exigem serviço real (PG da VPS, SearXNG daemon, SMTP, R2, chaves pagas) — cada skip
  diz o motivo no teste. `tsc --noEmit` limpo; web build verde.
- Scripts (`node --test`): **28/28** (updater 4, backup/restore 8, update.sh, r2-lib,
  make-release-zip).
- Gates 1–14: compile ✓, compose válido ✓, instalador ZIP ✓ (happy-path com
  docker/rsync roda só na VPS), DB+migrations ✓ (0003 pendente no PG da VPS),
  login ✓, chat+1 modelo ✓ (mock; modelos reais na VPS), seletor ✓, permissões ✓,
  persistência ✓, backups testados ✓ (guardas; ciclo real na VPS), sem falhas
  críticas ✓ (1 alta aceita: `xlsx`), RAM 12 GB ✓ (XOR), domínio/portas
  documentados ✓, opcionais incompletos desabilitados com honestidade ✓.

## 2. Arquivos principais tocados/criados (neste ciclo final)
- `apps/api/src/services/agent.ts` — gate, fix iterativo, parser, criação unificada
- `apps/api/src/services/github.ts` — fix do branch explícito
- `apps/api/src/services/update-upload.ts` + `routes/admin.ts` — Central v2
- `apps/api/src/routes/agent.ts`, `routes/chat.ts` (`/agente`, status 403/412)
- `apps/api/src/lib/redact.ts` — redação central
- `apps/updater/*` — serviço separado de aplicação
- `apps/web/src/components/UpdateCenter.tsx`, `AgentView.tsx`
- `scripts/backup.sh`, `scripts/restore.sh`, `scripts/backup-sh.test.mjs`
- `docker-compose.yml`, Dockerfiles, `nginx`, `searxng/settings.yml`
- `.env.example`, `docs/INSTALACAO.md`, `docs/PENDENCIAS-v0.2.0.md`

## 3. Não testado aqui (depende da VPS / do dono)
1. `docker compose build/up` e `deploy-vps-pronta.sh` (sem dockerd no sandbox).
2. Clique real no navegador (login→chat→imagem→admin→updates→agente).
3. Modelos locais (whisper/bge-m3), ComfyUI/GPU, SearXNG daemon, SMTP, R2.
4. Migração 0003 no Postgres da VPS; `pg-real.test.ts` contra a VPS.
5. GitHub real (token do dono), 1 run autônomo com LLM real (Groq grátis).
6. Ciclo backup→restore v0.2.0 real; `update.sh --zip` happy-path; apply do updater.
7. Domínio `https://ia.crjornada.com` (túnel existe; rota precisa apontar p/ 3000).

## 4. Riscos e prontidão
- Risco baixo: código+testes verdes; rollback existe (updater + restore).
- Risco médio: primeira subida do compose e primeiro restore v0.2.0 nunca rodaram
  (procedimentos documentados; `deploy-vps-pronta.sh` não reinstala nada).
- `xlsx` (alta, sem correção upstream) — aceito; não processa planilha de terceiros
  sem validação.
- Pronto para instalar na VPS seguindo §5 abaixo e cumprir PENDENCIAS P0 na ordem.

## 5. Instalação na VPS (resumo; detalhe em docs/INSTALACAO.md)
```bash
# 1. enviar o ZIP e descompactar em /opt/cr-ia/app
# 2. configurar .env a partir do .env.example (segredos do dono)
./scripts/deploy-vps-pronta.sh
docker compose ps
./scripts/backup.sh   # primeiro conjunto v0.2.0
```
