> **Prévia NVIDIA (29/10/2026):** chat NVIDIA NIM, geração de imagens com Cosmos3 Nano (Free Endpoint de prototipagem), e testes administrativos de embeddings/reranking Nemotron. Ativação exclusivamente pelo Superadmin; não há execução automática nem uso comercial habilitado. Consulte [docs/NVIDIA_NIM_FREE_ENDPOINTS.md](docs/NVIDIA_NIM_FREE_ENDPOINTS.md).

> **Instalador de VPS nova pelo GitHub (público agora ou privado depois):** consulte [docs/GITHUB-INSTALADOR-VPS.md](docs/GITHUB-INSTALADOR-VPS.md) e [docs/MENU-VPS.md](docs/MENU-VPS.md). Este pacote reúne a prévia NVIDIA NIM e correções de assinatura da v0.3.1; exige homologação antes de produção.

# CR IA — Inteligência Artificial Particular 🇧🇷

Plataforma própria, multimodelo e profissional: chat, estúdio de imagens/marketing,
tarefas automatizadas, agente desenvolvedor (GitHub) e painel administrativo —
com deploy na **Cloudflare** (serverless) ou **Hostinger VPS** (Docker), sem reescrever nada.

> **Versão 0.1.1 — MVP funcional + auditoria corrigida.** Validada com Docker,
> PostgreSQL, navegador real e geração real de imagens.
> Status honesto do que funciona, do que foi testado e do que é próxima fase:
> ver [`docs/STATUS.md`](docs/STATUS.md) e [`docs/RELATORIO-TESTES-v0.1.1.txt`](docs/RELATORIO-TESTES-v0.1.1.txt).

## Começo rápido (5 minutos, no seu computador)

```bash
cd cr-ia
cp .env.example .env
npm install
npm run seed -w apps/api        # cria admin + convidada (troque as senhas no .env!)
npm run dev:api &               # API em http://localhost:8787
npm run dev:web                 # site em http://localhost:5173
```

Login inicial (conforme `.env`): `admin@cr-ia.local` / `Trocar123!`
e `convidada@cr-ia.local` / `Trocar123!` — **troque antes de expor na internet.**

## Estrutura

```
cr-ia/
├── apps/api/        # backend Hono (Node + Cloudflare Workers, mesmo código)
│   ├── src/adapters/# db (json/postgres/d1) · storage (local/r2) · ai (mock/ollama/workers-ai)
│   ├── src/routes/  # auth · chat · models · images · files · tasks · admin
│   ├── src/services/# runner de tarefas · github (somente leitura na fase 1)
│   ├── migrations/  # SQL postgres + D1
│   └── tests/       # vitest (unitários + integração HTTP)
├── apps/web/        # frontend React + Vite + Tailwind (PT-BR, claro/escuro, responsivo)
├── apps/worker/     # worker de fila para a VPS
├── packages/shared/ # tipos/contratos compartilhados
├── docs/            # INSTALACAO · ARQUITETURA · STATUS · GPU-EXTERNA · RELATÓRIO-TESTES
├── scripts/         # install-vps · migrate-seed · ollama-setup · backup · restore · update
├── docker-compose.yml  # VPS Ubuntu (api + web + postgres + worker + ollama opcional)
└── wrangler.toml       # Cloudflare (Workers + D1 + R2 + Workers AI + Queues)
```

## Documentação

| Documento | Conteúdo |
|---|---|
| [`docs/INSTALACAO.md`](docs/INSTALACAO.md) | passo a passo: local, Hostinger VPS, Cloudflare e híbrido |
| [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) | decisões técnicas, adaptadores, segurança, custos |
| [`docs/STATUS.md`](docs/STATUS.md) | ✅ implementado · 🧪 testado · ⏳ pendente (a verdade, sem enfeite) |

## Comandos úteis

```bash
npm test --workspace apps/api        # testes automatizados
npm run migrate -w apps/api          # schema postgres (VPS)
npm run build -w apps/web            # build do site
docker compose up -d --build         # produção na VPS
wrangler deploy                      # produção na Cloudflare
```

## Comandos de produção (VPS)

```bash
./scripts/migrate-seed.sh     # banco + contas (seguro: nunca sobrescreve)
./scripts/ollama-setup.sh     # baixa os modelos reais de IA
./scripts/backup.sh           # backup banco + arquivos (também no cron diário)
./scripts/restore.sh <arq>    # restauração com confirmação
./scripts/update.sh           # atualiza com backup antes
```

## Segurança em 10 segundos

- Senhas com bcrypt, sessões JWT versionadas (revogação global), rate limiting,
  contas bloqueáveis, histórico isolado por usuário.
- Segredos **sempre** em `.env` / secrets do provedor — nunca no código.
- `BLOCK_PAID_PROVIDERS=true` por padrão: nada pago roda sem autorização do admin.
- Imagens reais: provedor externo gratuito **opcional** (admin consente no `.env`).
- GitHub: somente repositórios autorizados, escrita exige aprovação explícita.
