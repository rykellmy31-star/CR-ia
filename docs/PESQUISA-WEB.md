# CR IA — Pesquisa web, memória e código (Fase 3)

Tudo aqui é **funcionalidade real, sem simulação**: sem provedor
configurado, o sistema responde "busca web desligada" — nunca inventa
resultados.

## 1. Provedores de busca

| Provedor | Tipo | Custo | Como configurar |
|---|---|---|---|
| SearXNG próprio | seu buscador no Compose | grátis | `docker compose --profile search up -d` + `SEARXNG_URL=http://searxng:8080` |
| Brave Search | API oficial | pago (por chamada) | chave em Administração → Pesquisa (ou `BRAVE_API_KEY`) |
| Tavily | API oficial | pago (por chamada) | chave em Administração → Pesquisa (ou `TAVILY_API_KEY`) |
| Google PSE | API oficial | pago (por chamada) | chave (ou `GOOGLE_PSE_KEY`) **+ CX** do mecanismo |

Ordem automática: **SearXNG → Brave → Tavily → Google PSE**
(grátis primeiro). O admin pode forçar um provedor no painel
(`search.provider`) ou por conversa na aba Pesquisar.

Chaves do painel ficam **cifradas no banco** (cofre AES-256-GCM,
`CREDENTIALS_SECRET` no `.env`); variáveis do `.env` têm precedência.
A tela mostra só máscara (`BSA...x9z`) + origem (`.env`/`cofre`).

Documentação oficial de cada API está linkada no próprio painel
(botão "documentar-modelos ↗"); os clientes seguem os contratos:

- Brave: `GET {base}/res/v1/web/search` + `X-Subscription-Token`
- Tavily: `POST {base}/search` (`api_key`, `query`, `max_results`)
- Google PSE: `GET {base}/customsearch/v1` (`key`, `cx`, `q`, `num≤10`)

## 2. Onde a busca aparece

- **Chat (botão 🌐):** pesquisa antes de responder e cita fontes `[1]`,
  `[2]`… com data da fonte quando o provedor informa.
- **Busca automática:** perguntas sobre fatos recentes ("preço hoje",
  "quem ganhou", "últimas notícias"…) disparam pesquisa sozinha; a
  resposta vem com o aviso 🌐 + provedor. O admin liga/desliga
  (`search.auto`). Falha de busca **nunca** quebra o chat.
- **Aba Pesquisar:** busca manual, histórico próprio e botão
  **📖 Ler página** (texto legível de páginas públicas).
- **Administração → Pesquisa:** status dos 4 provedores, provedor
  preferido, CX do Google, busca automática e pesquisas de todos.

Regra de citação (valendo no chat): fatos da web **devem** citar `[n]`
com data; o que não veio da busca é conhecimento interno — e a IA
diz isso claramente.

## 3. Leitura de páginas (anti-SSRF)

`POST /api/ai/read-url` lê páginas **públicas** e devolve título +
texto (12 mil caracteres). Bloqueios testados:

- host literal privado (127.x, 10.x, 192.168.x, ::1…) — rejeitado;
- DNS que resolve para IP privado — rejeitado (re-resolve cada etapa);
- redirecionamentos manuais (máx. 5), só http/https;
- limite de 1,5 MB + timeout de 20 s.

## 4. Memória por projeto

Aba **🧠 Memória**: decisões, correções e notas por projeto, **só
visíveis para o dono**. O agente desenvolvedor consulta
automaticamente as decisões/correções do repositório antes de
analisar uma tarefa (use em "Projeto" o mesmo nome do repo).

## 5. Código indexado

Aba **💻 Código** (ou botão no detalhe do run): indexa o código do
clone isolado de um run do agente e permite buscar nele. Com
voz/embeddings ativos (perfil `ai`), a busca é **semântica** ("onde
fica o login?"); sem eles, por **palavra-chave** — o modo é sempre
informado. Limites: 200 arquivos, 60 KB/arquivo, 400 trechos.

## 6. Tabelas e custos

- `searches` (histórico), `memory_items`, `code_chunks` — migração
  `0003` (Postgres + D1; JSON automático).
- Uso registrado como `web-search` (modelo `search:<provedor>`);
  `costFlag` aceso para Brave/Tavily/PSE (pagos), apagado p/ SearXNG.
- Estimativa ≈$ no admin cobre IAs por API; custo de busca aparece
  no painel do próprio provedor (Brave/Tavily/Google Cloud).

## 7. Status honesto (23/10/2026)

- ✅ 24 testes automatizados contra stubs fiéis (17 arquivos,
  118 passed/10 skipped no total) — `tests/search-memory.test.ts`.
- ⏳ Chamadas reais Brave/Tavily/PSE: **nunca executadas** (exigem
  chaves do dono — ver PENDENCIAS item 11).
- ⏳ SearXNG real no Compose: perfil pronto, nunca subido (item 7).
- ⏳ Migração 0003 no Postgres da VPS (item 4).
