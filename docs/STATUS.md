# CR IA — Status real da entrega (v0.3.1)

> Atualizado em: **24/10/2026**. Rodada bloqueios-da-atualização: segredo
> HMAC na API (compose), assinatura minisign (`sign-release.mjs` + par
> `cr-ia-release` + ZIP assinado), preservação provada (.env/dados/backups
> intactos no apply e no rollback) e fluxo ponta a ponta testado de verdade
> (upload→aprovação→aplicação→reversão, 4/4). Provas:
> `RELATORIO-TESTES-v0.3.1.txt`; pendências: `PENDENCIAS-v0.3.1.md`.
> Primeira instalação: **via SSH** (bootstrap); depois, updates pelo painel.

# CR IA — Status real da entrega (v0.3.0) — histórico

> Atualizado em: **24/10/2026**. OpenRouter primário: catálogo dinâmico
> (sync manual + automático), chave no cofre com teste sem gasto, pagos
> bloqueados por padrão com ativação por modelo, Image API oficial
> (geração + edição + custo real), painel Provedores de IA, heartbeat do
> aplicador. Provas: `RELATORIO-TESTES-v0.3.0.txt`; pendências:
> `PENDENCIAS-v0.3.0.md` (instalação na VPS, chave/créditos reais e
> primeiras chamadas pagas — tudo listado com roteiro).
>
> 🔥 Sync AO VIVO (sem chave): 520 modelos · 63 imagem · 20 grátis · 1,0s.
> 4 modelos de imagem do escopo verificados no `/images/models` com edição.

# CR IA — Status real da entrega (v0.2.0) — histórico

> Atualizado em: **22/10/2026**. Regra da casa: ✅ = implementado **e**
> testado; 🧪 = teste automatizado; 🔥 = validado ao vivo; ⏳ = pendente.
> Detalhes desta versão: `RELATORIO-TESTES-v0.2.0.txt` (provas) e
> `PENDENCIAS-v0.2.0.md` (o que falta — leia antes do aceite).
>
> Resumo v0.2.0: builds 4/4 verdes; vitest 77 passed/10 skipped;
> Postgres 17 REAL 8 passed; ComfyUI stub-fiel 5/5; ai-local boot real;
> agente dev com git real local; catálogo 20 modelos com licenças;
> web com centro multimodelo + agente + edição de imagem + uso/admin.
> ⏳ Docker Compose, navegador, modelos reais do ai-local, GPU real,
> SMTP real e SearXNG real — tudo listado com roteiro nas pendências.
>
> Rodada Fase 2 (23/10/2026): +6 provedores por API com cofre AES-256,
> fallback avisado, preferência por usuário e estimativa de custo —
> 94 testes verdes, builds 4/4 verdes, zero chamadas pagas executadas.
>
> Rodada Fase 3 (23/10/2026): busca web real multi-provedor
> (searxng→brave→tavily→google-pse, chaves no cofre, CX no painel),
> leitura de páginas com anti-SSRF, histórico, memória por projeto
> (consultada pelo agente), código indexado (semântico/palavra-chave),
> busca automática no chat com aviso — 118 testes verdes (24 novos),
> builds 4/4 verdes, zero chamadas externas pagas executadas.

# CR IA — Status real da entrega (v0.1.1) — histórico

> Atualizado em: **22/10/2026**. Regra da casa: ✅ = implementado **e** testado;
> 🧪 = teste automatizado; 🔥 = validado ao vivo (Docker/Postgres/navegador —
> ver `RELATORIO-TESTES-v0.1.1.txt`); ⏳ = pendente (fase futura, sem simulação).

## 1. Bloqueios da auditoria — todos corrigidos

| # | Bloqueio | Correção | Evidência |
|---|---|---|---|
| 1 | Seed inseguro/quebrado no Docker | `dist/seed.js` no script; cria-sem-sobrescrever; **recusa senha padrão em produção** (exit 1) | 🧪 `seed.test.ts` + 🔥 migrate-seed no Compose |
| 2 | Worker fora do Postgres/fila | Worker com `DATABASE_URL`, mesmos provedores de IA e volume `apidata` compartilhado | 🔥 tarefa `pending → done` no Compose |
| 3 | API quebrada no domínio/celular | `VITE_API_URL=""` (mesma origem via Nginx); uploads usam base configurável; `client_max_body_size 30M`; limpeza de código morto | 🔥 navegador 6/6 pelo proxy |
| 4 | Variáveis ausentes/inúteis | Compose passa **todas** as vars usadas pelo código; removido `WORKER_TOKEN` fantasma; `.env.example` sincronizado | 🔥 stack sobe só com `.env` |
| 5 | Respostas simuladas | Ollama `qwen3:4b` padrão no Compose + `ollama-setup.sh` + endpoint `POST /models/test` (prova inferência real) + botão 🧪 no admin | 🧪 + 🔥 teste real executado |
| 6 | Imagens simuladas | Provedor `pollinations-flux` (FLUX real, gratuito, com consentimento do admin) + selo 🌐 + fallback SVG | 🔥 JPEG real gerado e conferido visualmente |
| 7 | Sessões/recuperação frágeis | JWT versionado + revogação global, rate limit no auth, cabeçalhos de segurança, troca/reset derrubam sessões | 🧪 `security.test.ts` + fluxo revoke |
| 8 | Estouro em 12 GB RAM | Limites por serviço (banco 768M·API 1G·worker 1G·site 256M·Ollama 7G) + Ollama `NUM_PARALLEL=1` + `qwen3:4b` padrão | Compose validado |
| 9 | Backup sem restore provado | `restore.sh` com confirmação + backup de segurança; `--clean --if-exists`; cron no `install-vps.sh`; integridade verificada | 🔥 ciclo 2→1→2 usuários restaurado |
| + | GitHub (evolução) | Leitura de arquivo, lista de PRs e **sugestão de patch gerada por IA** (ainda 100% somente-leitura) | Endpoints + UI em Tarefas |

Bugs extras encontrados pelos testes reais e corrigidos: `@cr-ia/*` com versão
fixa quebrava `docker build` (→ `*`); `c.env` indefinido no middleware de
segurança; seed executando ao ser importado nos testes; cabeçalhos duplicados
Nginx/API; `restore.sh`/`ollama-setup.sh` sem bit de execução.

## 2. MVP — onde estamos

| Requisito | Estado | Evidência |
|---|---|---|
| Chat funcional PT-BR | ✅🧪🔥 | SSE + histórico; suíte + navegador |
| 2 usuários (admin + convidada) | ✅🧪🔥 | seed seguro; papéis; bloqueios |
| Histórico + busca | ✅🧪 | busca, cascata, isolamento |
| Escolha de modelos | ✅🧪🔥 | catálogo real + teste de inferência |
| Criação de imagens | ✅🧪🔥 | FLUX real + SVG fallback + 4 formatos |
| Frontend+backend+banco | ✅🧪🔥 | React + Hono + json/pg reais + D1 pronta |
| Auth + recuperação | ✅🧪 | JWT versionado, rate limit, token 1h/uso único |
| Upload de arquivos | ✅🧪🔥 | validação + leitura + proxy 30M |
| Fila de tarefas | ✅🧪🔥 | 5 estados, retry, worker no Postgres |
| Agente GitHub (leitura+) | ✅🔥 | inspect, read, pulls, patch sugerido; escrita travada |
| Painel admin | ✅🧪 | modelos, teste, usuários, sessões, uso, logs |
| Docker Compose (VPS 12 GB) | ✅🔥 | 3 imagens buildadas; stack testada de ponta a ponta |
| Scripts VPS Ubuntu 24/26 | ✅🔥 | install, migrate-seed, ollama-setup, backup, restore, update |
| GPU externa sob demanda | ✅ | `docs/GPU-EXTERNA.md`; fallback automático |
| Arquivos Cloudflare | ✅ | `wrangler.toml` + D1/R2/AI/Queues |
| `.env.example` | ✅ | sincronizado, sem segredos |
| Docs de instalação | ✅ | OVHcloud Ubuntu 26.04 passo a passo |
| Testes + relatório | ✅🧪🔥 | 49 automatizados + Docker + navegador (ver §4) |

## 3. Pendente (próximas fases — NÃO simulado)

| Item | Fase | Observação |
|---|---|---|
| Escrita no GitHub (branch/commit/PR) | 2 | sandbox + diff revisável; hoje para em `awaiting_approval` com patch sugerido |
| GitHub Actions: logs de falha detalhados | 2 | lista runs hoje; log textual na fase 2 |
| OpenHands/OpenCode acoplado | 2 | via container isolado; contrato já prevê |
| Qwen-Image/Edit com GPU | 2 | adaptador ComfyUI/SD-WebUI na VPS GPU |
| Whisper (transcrição) | 2 | adaptador Workers AI/local |
| PDF/DOCX: leitura e resumo | 2 | hoje: armazena e informa o limite |
| SMTP de recuperação | 2 | hoje: token via log/painel + rate limit (documentado) |
| Busca web (Tavily/Brave) | 3 | chave opcional do admin |
| Embeddings/RAG em documentos | 3 | pgvector/Vectorize |
| Multi-idioma da interface | 3 | hoje: PT-BR fixo |
| CAPTCHA no login | 2 | hoje: rate limit por IP + JWT |
| D1 (Cloudflare) em produção | 1 | código pronto; falta deploy real na CF (fora do escopo VPS) |

## 4. Como reproduzir os testes

```bash
cd cr-ia
npm install
npm test --workspace apps/api                                   # 49 testes (mock+segurança)
TEST_DATABASE_URL=postgres://... npm test --workspace apps/api  # + Postgres real
LIVE_EXTERNAL=1 npm test --workspace apps/api                   # + imagem real externa
```

Mais Docker + navegador + Ollama-stub: `docs/RELATORIO-TESTES-v0.1.1.txt`
(roteiro completo com os comandos executados nesta auditoria).

Esperado (v0.1.1): **9 arquivos, 49 testes passando, 1 pulado** (placeholder
que se inverte no modo live) + builds api/worker/web OK + 3 imagens Docker
buildadas + stack Compose validada + navegador 6/6.

## 5. Roteiro de aceite na OVH (20 min, após instalar §2 do INSTALACAO.md)

1. `https://seu-dominio` → login admin e convidada; trocar senha da convidada. ☐
2. Chat com modelo `qwen3:4b` (Ollama): perguntar, anexar `.txt`, regenerar. ☐
3. Administração → Modelos → 🧪 Testar cada 🟢 (texto e imagem). ☐
4. Estúdio: gerar 9:16 real, baixar, criar legenda. ☐
5. Tarefas: `image-batch` até `done`; `github-inspect` num repo autorizado. ☐
6. `./scripts/backup.sh` + simular `restore.sh` (confirma `RESTAURAR`). ☐
7. Revogar sessões no admin → todos relogam. ☐

## 6. Rodada de correções da auditoria (v0.2.0, 23/10/2026)

Itens corrigidos e testados (detalhes em `docs/RELATORIO-AUDITORIA-v0.2.0.md`):

- **Gratuitos**: Groq + OpenRouter (`:free`) com status `limited`, cotas no
  catálogo, vault para chaves grátis, `BLOCK_PAID` agora cobre busca paga; UI
  marca ⏳ "grátis, limitado".
- **Agente**: modo autônomo real (LLM planeja → edita → testa → commita;
  aprovações humanas para push/PR/merge intactas) + sandbox Docker para testes
  (host só com permissão explícita; sem docker+sem host = skipped honesto).
- **Central de Atualizações**: manifesto + sha256 + minisign, staging com
  recibo, aplicação com backup antes (admin → 🔄 Atualizações). Ver
  `docs/UPDATES.md`.
- **Backup R2**: ReferenceError corrigido, lib compartilhada testada (trava,
  retenção, AES-256-GCM), `restore-r2.mjs` usa a lib.
- **Release**: `scripts/make-release-zip.mjs` oficial (nunca embala
  `.env`/builds/deps) + testes.
- **Compose**: `CREDENTIALS_SECRET` obrigatório, RAM documentada
  (perfis `ollama` e `ai` são alternativas — nunca juntos), env da Central.

Suíte antes do ZIP: `npm test` (API, vitest) + `npm run test:scripts`
(node --test) + `npm run build` — tudo verde.
