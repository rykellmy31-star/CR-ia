# CR IA — Guia de instalação passo a passo

> Tempo estimado: **5 min** (local) · **30–60 min** (VPS) · **30 min** (Cloudflare).
> Idioma: português brasileiro. Testado com Node 20+, Docker 26, Postgres 16/17.
> Perfil de referência da VPS: **OVHcloud Ubuntu 26.04 · 6 vCores · 12 GB RAM · 100 GB SSD**.

---

## 0. Requisitos

| Cenário | Precisa de |
|---|---|
| Local (testar) | Node.js 20+, npm |
| VPS OVHcloud/Contabo/Hostinger | Ubuntu 24.04/26.04, Docker + Compose (via `install-vps.sh`), domínio, SSH |
| Cloudflare | Conta Cloudflare, `wrangler` (npm), domínio (opcional) |

---

## 1. Rodar no seu computador (desenvolvimento/teste)

```bash
cd cr-ia
cp .env.example .env
# Edite o .env: troque JWT_SECRET, ADMIN_PASSWORD e GUEST_PASSWORD!
npm install
npm run seed -w apps/api
```

Abra **dois terminais**:

```bash
# Terminal 1 — API (http://localhost:8787)
npm run dev:api

# Terminal 2 — site (http://localhost:5173)
npm run dev:web
```

Opcional — worker de tarefas (3º terminal), para executar a fila localmente:

```bash
npm run dev:worker
```

Acesse **http://localhost:5173** e entre com as contas do `.env`.

### 1.1 Ativar IA real local (Ollama — recomendado)

Sem Ollama, o chat usa o modelo local de demonstração e as imagens saem em SVG de teste.
Para respostas reais com modelos abertos:

```bash
# Instale o Ollama: https://ollama.com/download
ollama pull qwen3:4b        # rápido, ~2.5 GB (comece por este)
# ollama pull qwen3:8b      # melhor, ~5 GB (se tiver 8+ GB RAM)
# ollama pull gemma3:4b     # alternativo Google
```

No `.env`:

```env
CHAT_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_TEXT_MODELS=qwen3:4b
```

Reinicie a API. O painel **Administração → Sistema** mostra o Ollama como alcançável,
e o seletor de modelos libera os modelos instalados.

Requisitos aproximados de memória RAM (modelos quantizados):

| Modelo | RAM | Onde roda |
|---|---|---|
| qwen3:4b | ~2.5 GB | ✅ VPS 12 GB (padrão seguro) |
| qwen3:8b / gemma3:4b | ~5 GB | ✅ VPS 12 GB (cabe com folga) |
| qwen3:14b / gemma3:12b | ~9 GB | ⚠️ VPS 12 GB (apertado — prefira GPU externa) |
| qwen3:30b / gpt-oss:20b | 20–32 GB | ☁️ GPU externa sob demanda (docs/GPU-EXTERNA.md) |

---

## 2. VPS OVHcloud Ubuntu 26.04 em produção (6 vCores · 12 GB RAM · 100 GB SSD)

> Limites de recursos já configurados no Compose para 12 GB:
> banco 768 MB · API 1 GB · worker 1 GB · site 256 MB · Ollama 7 GB.
> Também funciona em Contabo/Hostinger com Ubuntu 24.04+.
> Fluxo validado de ponta a ponta com Docker real (ver RELATORIO-TESTES-v0.1.1.txt).

### 2.0 Bootstrap automático (recomendado)

Na VPS nova, como root:

```bash
# Baixe este script do seu repositório para a VPS e execute:
sudo bash install-vps.sh
# (instala Docker + Caddy + firewall UFW + swap + usuário 'cria')
```

O script está em `scripts/install-vps.sh` — leia-o antes de executar
(transparente, idempotente, sem credenciais embutidas).

### 2.1 Preparar a VPS (manual, se preferir)

1. Contrate a VPS (referência: **OVHcloud · Ubuntu 26.04 · 6 vCores · 12 GB RAM · 100 GB SSD**).
2. Aponte seu domínio na **Cloudflare**: registro **A** → IP da VPS
   (recomendado: proxy 🟠 ativado + SSL/TLS em modo **Full (strict)** —
   CDN, WAF básico e IP de origem oculto).
3. Acesse via SSH e instale o Docker (ou use o `install-vps.sh` da §2.0):

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker
```

### 2.2 Subir a plataforma (VPS pronta: instalação pelo ZIP, sem Git)

Na VPS OVHcloud que já tem Docker + Tunnel, como o usuário do app:

```bash
# 1. Envie o ZIP da release e extraia (ex.: via scp do seu computador):
#    scp cr-ia-v0.3.1-pronta.zip cria@<IP-DA-VPS>:/tmp/
command -v unzip >/dev/null || sudo apt-get install -y unzip
mkdir -p /opt/cr-ia/app && unzip -o -q /tmp/cr-ia-v0.3.1-pronta.zip -d /opt/cr-ia/app
cd /opt/cr-ia/app
# 2. Senhas do dono (obrigatório ANTES do --apply):
cp .env.example .env
nano .env   # PREENCHA: ADMIN_PASSWORD e GUEST_PASSWORD (fortes! gere com: openssl rand -base64 18)
# 3. Diagnóstico (só leitura) e instalação:
./scripts/deploy-vps-pronta.sh --check
./scripts/deploy-vps-pronta.sh --apply
```

O instalador gera sozinho `JWT_SECRET`, `CREDENTIALS_SECRET`, `POSTGRES_PASSWORD` e
`UPDATER_QUEUE_SECRET` (sem nunca imprimi-los), sobe a stack em `127.0.0.1:3000`,
aplica schema + contas e testa a saúde. Detalhe da rota do Tunnel: `docs/TUNEL-CLOUDFLARE.md`.

> **Atualizando de uma versão anterior?** Faça backup (`./scripts/backup.sh`),
> extraia o novo ZIP **por cima** do `/opt/cr-ia/app` (o `.env` e `data/` são
> preservados — nunca apague o diretório), rode `./scripts/deploy-vps-pronta.sh
> --apply` (rebuild + migrações aditivas, incluindo a `0004` de custos) e
> confira `/api/health` (deve mostrar `"version": "0.3.1"`).
> **Chave de atualização (uma vez):** cole no `.env` a linha
> `UPDATE_SIGNING_PUBLIC_KEY=` com a 2ª linha do arquivo `cr-ia-release.pub`
> entregue junto com o ZIP (antes do `--apply`, junto com as senhas). Sem
> ela, futuros uploads de atualização pelo painel serão recusados. Rollback = restaurar
> o backup (ver `docs/UPDATES.md` § rollback). Depois: `docs/OPENROUTER.md`
> (chave, sync do catálogo e ativação de modelos pagos — tudo pelo painel).

Fluxo manual equivalente (sem o instalador):

```bash
cp .env.example .env
nano .env   # PREENCHA: segredos acima + ADMIN/GUEST_PASSWORD, CORS_ORIGINS, PUBLIC_API_URL
docker compose up -d --build
./scripts/migrate-seed.sh   # schema + contas (seguro: recusa senha padrão em prod)
docker compose ps
curl -s http://127.0.0.1:3000/api/health
```

> O Compose já inclui Postgres, API, worker e site (Nginx com proxy `/api`).
> **IA real local:** `docker compose --profile ollama up -d` e depois
> `./scripts/ollama-setup.sh` (baixa o `qwen3:4b` do `.env`).
> Confira em **Administração → Sistema** e teste em **Modelos → 🧪 Testar**.

### 2.3 HTTPS (obrigatório)

Na frente do Docker, use um proxy com HTTPS. Opção simples com Caddy:

```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile <<'EOF'
cr-ia.seudominio.com.br {
    reverse_proxy 127.0.0.1:3000
}
EOF
sudo systemctl reload caddy
```

O Caddy emite o certificado Let's Encrypt automaticamente.

### 2.4 Backups automáticos + restauração (VPS)

O `install-vps.sh` agenda backup diário às 2h (cron). Cada execução publica um
**conjunto** em `/opt/cr-ia/data/cr-ia-dumps` (subdiretório novo dentro da árvore
que o Restic da VPS já observa — o script nunca toca no repo Restic em si):

- `db-<STAMP>.sql.gz` — dump transacional do Postgres (`--clean --if-exists`)
- `globals-<STAMP>.sql.gz` — roles (`pg_dumpall --globals-only`)
- `arquivos-<STAMP>.tar.gz` — volume de uploads (montado somente-leitura)
- `manifest-<STAMP>.json` — SHA256 de cada arquivo; publicado **por último** e só
  depois de `gzip -t` + `tar -tz` + não-vazio (conjunto sem manifest válido = parcial,
  nunca restaurado nem apagado pela retenção)

Retenção: mantém os **14 conjuntos mais novos** (`RETENTION_SETS`), com **piso de 2**
e apagando só `db/globals/arquivos/manifest` dos nossos padrões de nome.

```bash
./scripts/backup.sh                 # banco + arquivos + manifest verificado
ls -lh /opt/cr-ia/data/cr-ia-dumps/ # confere os conjuntos publicados
```

Restauração por STAMP (confere SHA256, pede `RESTAURAR` digitado e faz backup de
segurança do estado atual antes de substituir):

```bash
./scripts/restore.sh                # lista os conjuntos disponíveis
./scripts/restore.sh 2026-10-22_020000
```

**Recuperação isolada (teste sem tocar na produção):** suba um Postgres temporário
e despeje o conjunto nele — nada do procedimento abaixo toca no `db` do compose:

```bash
STAMP=2026-10-22_020000
D=/opt/cr-ia/data/cr-ia-dumps
docker run -d --name pg-teste -e POSTGRES_PASSWORD=t -p 127.0.0.1:55433:5432 postgres:16-alpine
gunzip -c $D/globals-$STAMP.sql.gz | docker exec -i pg-teste psql -U postgres -d postgres -q
gunzip -c $D/db-$STAMP.sql.gz | docker exec -i pg-teste psql -U postgres -d cr_ia -q
docker exec -i pg-teste psql -U postgres -d cr_ia -tAc "SELECT count(*) FROM users;"
docker rm -f pg-teste  # descarta o banco de teste
```

> Ciclo backup → excluir dado → restaurar → dado de volta foi **testado de verdade**
> em Docker na v0.1.1 (ver RELATORIO-TESTES-v0.1.1.txt §6); o formato v0.2.0 (manifest +
> SHA256 + STAMP) tem guardas automatizados em `npm run test:scripts`, e o ciclo real
> com o novo formato precisa ser rodado uma vez na VPS (§PENDENCIAS item 10).
> Guarde cópia externa dos dumps (o Restic já replica para o R2) — disco único não é backup.

### 2.6 Ativar IA real — Ollama + Qwen3 4B (obrigatório p/ chat real)

Recém-instalado, o chat responde em **modo demonstração** (`CR Local
(demonstração)` — ele próprio avisa que não é IA real). Para respostas reais
com modelo aberto, gratuito e comercialmente liberado (Apache-2.0):

```bash
cd /opt/cr-ia/app
docker compose --profile ollama up -d   # sobe o Ollama (limite 7 GB de RAM)
./scripts/ollama-setup.sh               # baixa qwen3:4b (~2.5 GB) + testa geração
```

Saída esperada (trechos):

```text
[ollama-setup] Baixando modelo: qwen3:4b (pode demorar vários minutos)...
[ollama-setup] Teste de geração em qwen3:4b (prova de funcionamento)...
[ollama-setup] qwen3:4b respondeu: OK
```

Verificação (sem ela, não considere ativo):

1. `docker compose exec -T ollama ollama list` mostra `qwen3:4b`.
2. No site: **Administração → Modelos** — o modelo Ollama aparece 🟢;
   botão 🧪 Testar responde.
3. No chat (modelo `auto`), pergunte qualquer coisa: a resposta vem com o
   nome do modelo real no cabeçalho, sem aviso de demonstração.

Notas de 12 GB: nenhuma outra configuração é necessária (o chat detecta o
Ollama sozinho). `qwen3:8b` (~5 GB) também cabe — ponha
`OLLAMA_TEXT_MODELS=qwen3:4b,qwen3:8b` no `.env` e rode o script de novo.
Modelos ≥14B são **recusados** pelo script (não cabem nos 12 GB).

### 2.5 Atualizar

```bash
./scripts/update.sh   # backup de segurança + git pull + rebuild + migrations
```

---

## 3. Cloudflare (serverless)

```bash
npm install -g wrangler
wrangler login

# Banco D1
wrangler d1 create cr-ia-db
# → copie o database_id para o wrangler.toml
wrangler d1 execute cr-ia-db --file=apps/api/migrations/0001_init_d1.sql

# Arquivos R2
wrangler r2 bucket create cr-ia-arquivos

# Fila de tarefas
wrangler queues create cr-ia-tasks

# Segredos (nunca no código!)
wrangler secret put JWT_SECRET
wrangler secret put GITHUB_TOKEN     # opcional

# Build + deploy (site + API juntos)
npm install
npm run build -w packages/shared
npm run build -w apps/web
npx wrangler deploy
```

### 3.1 Criar as contas iniciais na Cloudflare

O seed local não alcança o D1. Opção A (recomendada): endpoint temporário —
execute **uma vez** com `wrangler dev`? Não: o caminho oficial é inserir via SQL com
hash bcrypt gerado localmente:

```bash
node -e "import('bcryptjs').then(async m => console.log(await m.hash('SUA-SENHA-FORTE', 10)))"
wrangler d1 execute cr-ia-db --command "INSERT INTO users (id,email,name,role,blocked,password_hash,created_at,updated_at) VALUES ('usr_admin','admin@seu.dominio','Administrador','admin',0,'HASH_AQUI',datetime('now'),datetime('now'))"
# repita para a convidada
```

Opção B: suba a API temporariamente com `JWT_SECRET` de dev, use a rota
`POST /api/admin/users`… (exige admin existente — por isso a Opção A é o bootstrap).

### 3.2 Modelos na Cloudflare

Com o deploy feito, o **Workers AI** já responde (binding `AI`):
- Chat: Llama 3.1 8B, Qwen3 8B, Gemma 3 12B (e outros `@cf/*`).
- Imagens: **FLUX.1 Schnell** — fotorrealistas de verdade.

⚠️ **Custos:** o Workers AI tem cota gratuita e excedente pago conforme o plano.
A CR IA vem com `BLOCK_PAID_PROVIDERS=true`: o admin libera em
**Administração → Modelos** quando quiser. Monitore em **Sistema → Uso**.

### 3.3 Domínio personalizado

Cloudflare Dashboard → Workers → `cr-ia` → Settings → Domains & Routes →
Add Custom Domain → `cr-ia.seudominio.com.br` (HTTPS automático).

---

## 4. Arquitetura híbrida (recomendada para começar)

- **Site + API leve na Cloudflare** (rápido, barato, HTTPS grátis).
- **Ollama pesado na VPS** (modelos grandes sem custo por chamada).

Passos:

1. Faça o deploy da seção 3 (Cloudflare).
2. Na VPS, rode só o Ollama: `docker compose --profile ollama up -d ollama`
   (+ `ollama pull qwen3:8b` etc.).
3. Exponha o Ollama com segurança (Túnel Cloudflare ou IP restrito + token).
4. Na Cloudflare, defina a variável `OLLAMA_URL` (wrangler vars) apontando para o túnel
   e `CHAT_PROVIDER=ollama`. O `ModelRegistry` passa a preferir o Ollama.

> Nota técnica: o Workers faz `fetch` ao Ollama via HTTPS pública. Nunca exponha
> o Ollama sem autenticação na internet aberta — use Cloudflare Tunnel + Access.

---

## 5. GitHub (agente desenvolvedor)

1. Crie um token fino (Settings → Developer settings → Personal access tokens →
   **Fine-grained**): acesso **somente leitura** (`Contents: read`, `Actions: read`)
   nos 4 repositórios listados no `.env`.
2. Defina `GITHUB_TOKEN=` no `.env` (VPS) ou `wrangler secret put GITHUB_TOKEN` (CF).
3. Confira `GITHUB_ALLOWED_REPOS` — o agente **recusa** qualquer outro repo.
4. Teste em **Tarefas → Inspecionar repositório**.

🔒 Fase 1 = **somente leitura**. Propostas de correção param em
“Aguardando aprovação” e nada é escrito sem você aprovar. A escrita real
(branch/commit/PR) chega na fase 2 (ver `STATUS.md`).

---

## 6. Recuperação de acesso sem SMTP

Na v0.1 não há envio de e-mail (sem custo/dependência). O fluxo:

1. Usuária clica **“Esqueci minha senha”** → token gerado.
2. O token aparece no **log do servidor** (`docker compose logs api | grep Recuperação`)
   e no **painel admin → Logs** (`auth.recover.requested`).
3. O admin informa o token pelo WhatsApp; ela conclui em **“Já tenho o token”**.

SMTP (Resend/SMTP da Hostinger) está previsto na fase 2.

---

## 7. Problemas comuns

| Sintoma | Causa provável | Solução |
|---|---|---|
| `JWT_SECRET ausente` | `.env` não criado | `cp .env.example .env` e preencha |
| Chat responde “modo demonstração” | Ollama/CF não configurados | Seção 1.1 ou 3.2 |
| Modelo 🔴 indisponível | provedor fora do ar | Admin → Sistema mostra o ping real |
| `401` em tudo | token expirado | faça login de novo (12h padrão) |
| Upload recusado (415) | tipo fora da lista | ajuste `ALLOWED_UPLOAD_MIME` |
| D1 `no such table` | migration não aplicada | rode o `d1 execute` da seção 3 |
| Imagens só em SVG | `IMAGE_PROVIDER=mock-svg` | na CF use `workers-ai` |

Suporte: abra os logs (`docker compose logs -f api worker`) ou
**Administração → Logs** antes de pedir ajuda — eles dizem a causa exata.
