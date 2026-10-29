# CR IA v0.2.0 — Lista de pendências (o que falta provar/fazer)

> Atualizado em **22/10/2026**. Esta lista é o contrato do que NÃO foi
> executado ou validado até o fechamento do ZIP v0.2.0. Nada aqui está
> simulado: cada item diz exatamente o que falta e como concluir.
>
> ✅ Concluído após o ZIP v0.2.0 (rodada Fase 2, 23/10/2026): 6 provedores
> por API (OpenAI, Anthropic, Google, xAI, DeepSeek, Mistral) com cofre de
> chaves, status "Configurar API", fallback avisado, modelo padrão por
> usuário, estimativa de custo e teste real — 17/17 testes verdes, builds
> 4/4 verdes. Chamadas pagas reais continuam pendentes (exigem chaves do
> dono, item P1 novo abaixo).
>
> ✅ Concluído (rodada Fase 3, 23/10/2026): busca web real em 4 provedores
> (ordem grátis-primeiro, chaves no cofre, erro honesto sem provedor),
> leitura de páginas com bloqueio SSRF, histórico de pesquisas, memória
> por projeto com consulta automática pelo agente, índice de código com
> busca semântica/palavra-chave e busca automática no chat com aviso —
> suíte 118 passed/10 skipped (24 testes Fase 3 contra stubs fiéis),
> builds shared/api/web/worker verdes. PENDENTE (novos itens P1 abaixo):
> chamadas reais Brave/Tavily/Google-PSE (exigem chaves do dono),
> migração 0003 no Postgres da VPS e SearXNG real no Compose.

## P0 — Obrigatório antes do aceite na VPS pronta

| # | Item | O que falta | Como concluir (tempo aprox.) |
|---|---|---|---|
| 1 | `docker compose build` + `up -d` na VPS | Sem dockerd no sandbox da auditoria; imagens v0.2.0 (worker com git, api com workflows ComfyUI) nunca subiram em Compose | Na VPS pronta: `./scripts/deploy-vps-pronta.sh` (não reinstala Docker, não toca UFW/SSH) + `docker compose ps` (15 min) |
| 2 | Roteiro de fumaça no navegador | Chromium instalado, mas a validação foi interrompida antes de rodar | Servir `apps/web/dist` + API, abrir login, logar, chat, gerar imagem, admin (roteiro §2, 20 min) |
| 3 | ai-local com modelos reais | Boot real + 503 honesto provados; `faster-whisper small` e `BAAI/bge-m3` nunca baixados/carregados | Na VPS: `docker compose --profile ai up -d`, aguardar download, `POST /transcribe` com áudio real + `POST /embed` (30–60 min na 1ª vez) |
| 4 | Migrações 0001–0003 no Postgres | ✅ PROVADO localmente em PG 17.11 real: migrate aplica 0001+0002+0003, seed cria contas, API sobe em `postgres`, login+chat+restart+dump+restore idêntico (`scripts/e2e-real.test.mjs`) | Repetir `migrate-seed.sh` na VPS (banco da VPS ainda não existe) (10 min) |
| 5 | Aceite ponta a ponta no domínio | Fluxo completo nunca rodado na v0.2.0 | `https://ia.crjornada.com`: login 2 usuários, chat, imagem, agente (leitura), backup/restore (30 min) |

## P1 — Integrações reais opcionais (stub-provadas, falta o serviço real)

| # | Item | Estado atual | Para concluir |
|---|---|---|---|
| 6 | ComfyUI / GPU externa real | Cliente + 3 workflows + adaptador t2i/i2i provados contra stub fiel ao `/history` real | Apontar `EXTERNAL_GPU_URL`/`COMFY_*` para a GPU, gerar t2i + edit real via `/images` e `/images/edit` |
| 7 | SearXNG real | Stub HTTP provado (`/api/ai/search`, 5 testes Fase 3); perfil `search` existe no Compose | `docker compose --profile search up -d` + `SEARXNG_URL=http://searxng:8080` + busca real no chat (🌐) e na aba Pesquisar |
| 8 | SMTP real de recuperação | Código + anti-enumeração + token 1h/uso único testados; envio nunca executado | Preencher `SMTP_*` no `.env` da VPS e rodar "esqueci a senha" de verdade |
| 9 | Pollinations live nesta versão | Throttle 60s + `Retry-After` + fallback implementados; sem chamada live na v0.2.0 | Gerar 1 imagem com o provedor (respeitar 1/45s por IP) |
| 10 | Backup local v0.2.0 + R2 + restore | Ciclo dump→restore ✅ PROVADO localmente em PG 17.11 real (contagens + md5 idênticos; `e2e-real.test.mjs`); guardas 9/9; `backup-r2.mjs`/`restore-r2.mjs` com `node --check` OK | Na VPS: rodar `./scripts/backup.sh` + `./scripts/restore.sh <STAMP>` num banco de teste (ver INSTALACAO §2.4); depois R2 idem |
| 11 | Brave/Tavily/Google-PSE reais | Cliente de cada API + chaves no cofre + CX provados contra stubs fiéis aos contratos oficiais; **zero chamadas externas executadas** (sem chaves, por regra) | Dono cadastra 1 chave em Administração → Pesquisa (ou `.env`) e roda 1 busca real na aba Pesquisar; conferir provedor, datas e custo no painel do provedor |

## P2 — Fases futuras (não iniciados, sem simulação)

- Agente dev: `merge`/`push` automáticos continuam exigindo aprovação humana
  (por regra); execução remota real (Actions) ainda retorna `skipped` honesto.
- OpenHands/OpenCode acoplado via container isolado.
- D1/R2/Cloudflare em produção (código pronto; fora do escopo VPS).
- CAPTCHA no login; multi-idioma da interface.
- Modelos pagos continuam bloqueados (regra `BLOCK_PAID_PROVIDERS`): qualquer
  ativação exige autorização explícita do dono.

## §2 — Roteiro de fumaça no navegador (item #2, detalhado)

Pré-requisitos: Chromium/Chrome + Node 20. Na máquina de teste:

```bash
cd cr-ia && npm install && npm run build
# 1) API real (banco JSON efêmero):
mkdir -p /tmp/crdata
DB_DRIVER=json DATA_DIR=/tmp/crdata JWT_SECRET='<segredo-local-32+>' PORT=8787 \
  node apps/api/dist/index.js &
# 2) Servir o frontend buildado na porta 3000 com proxy /api -> 8787
#    (qualquer estático com proxy; na VPS é o nginx do compose)
# 3) No navegador, sem erro no console:
#    - abrir http://127.0.0.1:3000 -> tela de login renderiza
#    - registrar admin -> login OK -> chat abre
#    - enviar mensagem no modelo "echo"/local -> resposta aparece
#    - Estúdio -> gerar (fallback) -> imagem na biblioteca
#    - Administração -> Modelos -> 🧪 num modelo 🟢
```

Critério de aceite: zero erros `error TS`, zero exceções não tratadas no
console, todos os cliques acima com comportamento visível.

## Homologação da rodada de auditoria (VPS, após deploy)

- [ ] Central de Atualizações com manifesto + chave minisign reais (staging
      testado; `apply` ainda não rodado em produção).
- [ ] Aba 🔄 Atualizações clicada no navegador em deploy (backend coberto por
      testes de rota; falta o clique real).
- [ ] Primeiro `node scripts/restore-r2.mjs --test` mensal anotado (script
      pronto; falta o R2 real do dono).
- [ ] 1 run autônomo do agente com LLM real (Groq grátis) em repo de teste
      não-produção (comportamento provado com stub + git/teste reais).
- [ ] `update.sh --zip` happy-path (com rsync+docker) — guardas testados; o
      caminho feliz roda só na VPS.
