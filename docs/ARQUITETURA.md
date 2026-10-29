# CR IA — Arquitetura

## 1. Princípios

1. **Um código, dois destinos:** o backend é Hono puro (sem APIs exclusivas de Node
   no caminho quente), então o mesmo `createApp()` roda no Node (VPS) e no
   Cloudflare Workers. O que muda é só a **entrada** (`server-node.ts` vs `worker.ts`)
   e os **adaptadores** (via variáveis/bindings).
2. **Tudo atrás de adaptadores:** banco, arquivos e modelos de IA têm interfaces
   próprias (`adapters/*`). Trocar Postgres→D1, disco→R2 ou Ollama→Workers AI
   não toca nas rotas nem no frontend.
3. **Nada decorativo:** todo botão da interface chama uma rota real com teste.
   O que é fase futura está escrito como pendente em `STATUS.md`, não simulado.
4. **Segurança por padrão:** JWT, bcrypt, isolamento por usuário, allowlist de
   repositórios, bloqueio de modelos pagos e aprovação humana para escrita.

## 2. Mapa do sistema

```
┌──────────────┐   HTTPS   ┌───────────────────────────────┐
│  apps/web    │ ────────▶ │  apps/api (Hono)              │
│  React+Vite  │  /api/*   │  rotas: auth/chat/models/     │
└──────────────┘           │  images/files/tasks/admin     │
                           └───┬──────────┬──────────┬─────┘
                               │          │          │
                    ┌──────────▼──┐ ┌─────▼────┐ ┌───▼──────────┐
                    │ DbAdapter   │ │ Storage  │ │ ModelRegistry│
                    │ json|pg|d1  │ │ local|r2 │ │ mock|ollama  │
                    └─────────────┘ └──────────┘ │ |workers-ai  │
                                                └──────────────┘
┌──────────────┐   polling   ┌───────────────────────────────┐
│ apps/worker  │ ◀───────── │  tasks (pending→running→      │
│ (VPS)        │  ou Queues  │  awaiting→done/failed)        │
└──────────────┘  (CF)       └───────────────────────────────┘
```

### Perfis de deploy

| Perfil | API | Banco | Arquivos | IA texto | IA imagem | Fila |
|---|---|---|---|---|---|---|
| Local/dev | Node | JSON | disco | mock/Ollama | SVG/CF* | worker local |
| VPS | Node (Docker) | Postgres | disco (volume) | Ollama | SVG local | worker Docker |
| Cloudflare | Workers | D1 | R2 | Workers AI | FLUX.1 | Queues |
| Híbrido | Workers | D1 | R2 | Ollama via túnel | FLUX.1 | Queues |

\*CF fora do Workers exigiria API token; mantido bloqueado por padrão.

## 3. Central multimodelo (`ModelRegistry`)

- Descoberta: cada adaptador declara `models()` + `ping()` real.
- Catálogo: `GET /api/models` retorna disponibilidade **medida na hora**
  (🟢/🔴 de verdade, não chute).
- Seleção: manual (seletor no chat/estúdio) ou automática (`autoSelectText/Image` —
  prefere Ollama alcançável → Workers AI liberado → mock; código prefere `*coder*`).
- Política: `BLOCK_PAID_PROVIDERS` (padrão `true`) veta `@cf/*` e afins até o
  admin liberar; `models.disabled` veta por id; tudo auditado.
- Medição: toda chamada grava `usage_events` (modelo, tipo, tokens, flag de custo)
  e alimenta limites diários (`DAILY_LIMIT_CHAT/IMAGES`) + painel de consumo.

### Modelos mapeados (v0.1.1)

| Família pedida | Onde entra | Estado |
|---|---|---|
| Qwen3 4B/8B | Ollama (`OLLAMA_TEXT_MODELS`, `./scripts/ollama-setup.sh`) | ✅ pronto + testado (`POST /models/test`) |
| Gemma 3 | Ollama ou `@cf/google/gemma-3-12b-it` | ✅ pronto |
| GPT-OSS 20B | Ollama (`gpt-oss:20b`, exige GPU externa em VPS 12 GB) | ✅ pronto (ver GPU-EXTERNA.md) |
| Qwen3-Coder 30B | Ollama, auto-preferido p/ código | ✅ pronto (GPU externa) |
| FLUX.1 Schnell | Workers AI `@cf/black-forest-labs/flux-1-schnell` | ✅ pronto (deploy CF) |
| FLUX real (CPU) | Pollinations (`pollinations-flux`, externo gratuito c/ consentimento) | ✅ pronto + testado |
| Qwen-Image/Edit | GPU dedicada / ComfyUI | ⏳ fase 2 (adaptador dedicado) |
| Whisper | Workers AI `@cf/openai/whisper` | ⏳ fase 2 |
| Embeddings/RAG | pgvector (VPS) / Vectorize (CF) | ⏳ fase 3 |

## 4. Dados

Tabelas (mesmo modelo lógico no Postgres, D1 e JSON):
`users · conversations · messages · files · images · tasks · usage_events · audit_log · settings`.

- Senhas: bcrypt (cost 10). Recuperação: token opaco 1h, anti-enumeração.
- Isolamento: toda consulta filtra `user_id`; admin vê agregado sem ler conteúdo
  alheio além do necessário (auditoria registra acessos).
- Retenção: excluir conversa/imagem/arquivo apaga do banco **e** do storage;
  excluir usuário remove em cascata. Política formal: docs futuros (LGPD).

## 5. Tarefas e agentes

Máquina de estados persistente: `pending → running → done | failed`,
com desvio `awaiting_approval` para ações sensíveis. Retentativas com
`attempts/maxAttempts`; retomada pós-queda (`recoverOrphans` no worker).

Tipos v0.1: `echo · chat · image-batch · github-inspect · github-fix-proposal`.
O executor (`services/runner.ts`) é compartilhado entre o worker VPS e o
consumer das Queues CF — mesma semântica nos dois mundos.

### GitHub (v0.1.1: leitura + análise + sugestão de patch)

- Guardrails: `GITHUB_ALLOWED_REPOS` (recusa resto), token só-leitura,
  `GITHUB_REQUIRE_APPROVAL=true`, timeouts, teto de arquivos/linhas.
- `github-inspect`: metadados + árvore + ações + arquivos-chave (package.json etc.).
- `github/read` + `github/pulls`: leitura de arquivo e PRs recentes (UI em Tarefas).
- `github-fix-proposal`: ranqueia candidatos, lê os 3 melhores e usa o modelo de
  código para gerar **causa provável + diff sugerido + como testar** — tudo em
  `awaiting_approval`, ainda 100% somente-leitura.
- Roteiro p/ escrita autorizada (fase 2): aprovar proposta → agente cria branch
  `cr-ia/<tarefa>` a partir da default → aplica patch em sandbox → roda testes
  do repo → abre PR com resumo + logs → humano revisa e faz merge. Nenhum push
  direto na default, nenhum merge automático, tudo auditado.

## 6. Segurança e privacidade

- HTTPS obrigatório em produção (Caddy/Cloudflare); `CORS_ORIGINS` restrito;
  HSTS + cabeçalhos anti-clickjacking/MIME em API e Nginx.
- Sessões JWT **versionadas**: troca/reset de senha e botão do admin revogam
  todos os logins (`auth.tokenVersion`); expiração 12h padrão.
- Rate limiting no auth (20/min) e na recuperação (5/h por IP); em multirréplica,
  complementar com o WAF da Cloudflare.
- Uploads: allowlist de MIME, teto de tamanho (API + Nginx 30M), nomes
  sanitizados, chaves com escopo de usuário, downloads autenticados.
- Seed seguro: cria-sem-sobrescrever, recusa senha padrão em produção.
- Segredos: `.env`/secrets do provedor; painel mostra só “configurado/não”.
- Auditoria: logins, aprovações, erros de IA, uploads, testes e ações admin.
- Privacidade: conversas não saem do seu servidor exceto para o provedor de IA
  **que você escolheu** (Ollama local = nada sai; 🌐 externo = só com
  consentimento do admin); nada é usado para treinar terceiros pela CR IA.

## 7. Custos (estimativa honesta, 2026)

| Item | VPS Hostinger | Cloudflare |
|---|---|---|
| Hospedagem | VPS KVM (~R$ 30–120/mês conforme plano) | Workers+D1+R2: grátis p/ uso leve–médio |
| IA texto | R$ 0 (Ollama próprio; paga-se a VPS) | Cota grátis + pago por uso além dela |
| IA imagem | R$ 0 (SVG local) | FLUX por uso (ver pricing Workers AI) |
| Domínio/HTTPS | já incluso em geral | grátis (proxy + certificado) |

Regra de ouro: comece no **híbrido** — CF servindo tudo + Ollama na VPS para o
pesado. Escale GPU (RunPod/Vast/VPS GPU) só quando o uso justificar.

## 8. Testes

`apps/api/tests`: vitest com 5 suítes — crypto/JWT, adapters mock, JsonFileAdapter
(CRUD/isolamento/fila), registry/políticas e **integração HTTP ponta a ponta**
(login→chat→imagens→tarefas→upload→admin). Relatório: `npm test --workspace apps/api`.
Frontend: validação por build TypeScript + uso manual guiado (roteiro no STATUS.md).
