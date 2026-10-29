# Relatório — Rodada de correções da auditoria (v0.2.0, 23/10/2026)

Evolução do projeto existente, sem recomeço e sem remover nada. Tudo abaixo
está implementado no código do ZIP e coberto pelos testes citados (nada é
demonstração).

## A. Modelos 100% gratuitos (Groq + OpenRouter)

- `FREE_PROVIDER_DEFAULTS`: Groq (`openai/gpt-oss-20b`, `openai/gpt-oss-120b`)
  e OpenRouter (`:free` rotativo), com limites reais (RPM/RPD/TPM/TPD) no catálogo.
- Novo status `limited` (⏳ "grátis, limitado"): selecionável no chat, com
  badge e linha de cotas em Modelos, testável (🧪).
- Vault (cifrado) guarda `groq`/`openrouter`; Admin → Credenciais ganhou a
  seção "Chaves GRATUITAS".
- `BLOCK_PAID_PROVIDERS=true` agora cobre **busca paga** (Brave/Tavily/PSE
  explícitos → 503 honesto; modo auto cai para SearXNG/DuckDB).
- Pollinations: ressalva de que uso comercial NÃO é confirmado nos ToS.
- Ordem de auto-seleção: local → grátis → pago → demo; `isPaidModel` nunca
  classifica grátis como pago.
- Provas: `free-providers.test.ts` (11), `paid-block.test.ts` (7),
  `catalog.test.ts`, `search-memory.test.ts` — 17/17 + 31/31 nos focos.

## B. Agente autônomo (item 2)

- Sem patch humano, o agente agora: pede um **plano ao LLM** (≤8 arquivos,
  só `create`/`modify`), gera o conteúdo de cada arquivo, grava no clone,
  testa, commita. Tudo registrado no log (auditoria).
- Trava de segurança: caminhos fora do clone, `.env`, chaves, segredos,
  `.git/` e `node_modules/` são **recusados**; arquivos ≤100 KB, só texto.
- Sem LLM útil, cai para análise/testes **sem alterar nada** (log avisa).
- Push/PR/merge continuam exigindo aprovação humana (intacto).
- Provas: `agent-autonomy.test.ts` (6) — E2E real (git+teste+commit de
  verdade, LLM stubbed): cria `hello.txt`, edita `app.js`, testa e commita.

## C. Sandbox de testes (item 3)

- Novo `services/sandbox.ts`: `AGENT_RUNNER=auto|docker|host`.
- Docker (padrão): `docker run --rm` descartável, **1 volume** (só o clone),
  sem segredos (`-e` só `CI/HOME`), tetos (2 GB, 1.5 CPU, 256 pids),
  `--cap-drop ALL`, `no-new-privileges`, usuário não-root, rede configurável.
- Sem docker e sem permissão de host: **skipped honesto** (exit 125, nada executa).
- `docker.sock` no compose segue **comentado** (montar = root; só com decisão
  explícita do dono).
- Provas: `sandbox.test.ts` (8) — args de isolamento, motores, allowlist.

## D. Central de Atualizações (item 4)

- `services/updates.ts`: verificar (manifesto) → baixar → conferir
  (**sha256 + assinatura minisign** autocontida, sem CLI) → staging com
  recibo → aplicar **só com confirmação humana**.
- ZIP adulterado/sem assinatura/sem chave = **recusado e apagado**.
- Rotas admin (`/api/admin/updates/*`, 4), worker verifica 1x/hora (nunca
  aplica), UI em Administração → 🔄 Atualizações (verificar/baixar/aplicar).
- `scripts/update.sh --zip`: exige recibo, faz **backup antes**, preserva
  `.env*/data/backups/.git/node_modules`, rebuild + migrations.
- Provas: `updates.test.ts` (14, ed25519+zip reais) + `updates-routes.test.ts`
  (3) + guardas do `update.sh` (3). Operação em `docs/UPDATES.md`.

## E. Backup R2 (item 5)

- Corrigido o **ReferenceError** (destructuring para variáveis não declaradas).
- Nova `scripts/r2-lib.mjs` usada pelos dois scripts: trava entre execuções
  (lockdir+pid, re-colhe órfã), retenção diária/semanal, AES-256-GCM,
  nomes de chave. `restore-r2.mjs` (que já existia) usa a lib.
- Provas: `scripts/r2-lib.test.mjs` (11) + `update-sh.test.mjs` (3) via
  `npm run test:scripts` (16/16 com o item F).

## F. ZIP de release oficial (item 6)

- Novo `scripts/make-release-zip.mjs`: reproduzível, **nunca** embala
  `.git/node_modules/dist/build/coverage/backups/data/.env*/logs`, recusa
  sobrescrever sem `--force`, imprime contagem + sha256.
- Este próprio ZIP foi gerado por ele (dogfooding).
- Provas: `scripts/make-release-zip.test.mjs` (2).

## G. Compose/RAM (item 11) e credenciais

- `CREDENTIALS_SECRET` **obrigatório** (`${...:?}`); env da Central na API e
  no worker; `AGENT_RUNNER/ALLOW_HOST/SANDBOX_NETWORK` documentados.
- Cabeçalho do compose com a tabela de RAM: base ~3 GB; perfis `ollama`
  (+7 GB) e `ai` (+3 GB) são **ALTERNATIVAS** (tudo junto ≈ 14 GB > 12 GB).

## H. Docs (item 13)

- Novo `docs/UPDATES.md` (operador + maintainer); `docs/STATUS.md` §6;
  `docs/PENDENCIAS-v0.2.0.md` (5 itens de homologação); este relatório.

## I. Suite + builds (item 14)

- `npm test`: **24 arquivos, 172 passed, 12 skipped, 0 falha**.
- `npm run test:scripts`: **16/16**.
- `npm run build`: verde (shared, api, web, worker).

## Pendências REAIS (não homologado nesta rodada)

1. Central de Atualizações com manifesto+chave reais; `apply` nunca rodou em produção.
2. Clicar a aba 🔄 Atualizações no navegador da VPS (backend coberto por testes de rota).
3. Primeiro `restore-r2.mjs --test` mensal (falta o R2 real do dono).
4. 1 run autônomo com LLM real (Groq grátis) em repo de teste não-produção.
5. `update.sh --zip` happy-path (rsync+docker; guardas testados, feliz só na VPS).
6. Heranças da Fase 3: chaves pagas do dono p/ live pago (P1-11), SearXNG real
   no compose na VPS (P1-7), migration 0003 no Postgres da VPS (P0-4).
