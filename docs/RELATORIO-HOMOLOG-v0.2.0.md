# CR IA v0.2.0 — Últimos bloqueios de homologação (23/10/2026)

Continuação do `cr-ia-v0.2.0-homolog.zip` (nada recomeçado; nenhuma feature
nova — só funcionamento e segurança). Escopo: os 7 itens pedidos.

## 1. Permissões dos scripts no ZIP (CORRIGIDO)

- Causa: `scripts/*.sh` estavam `644` no repo e no ZIP → `./scripts/*.sh`
  dava `Permission denied` após extrair no Linux (reproduzido aqui).
- Correção em 3 camadas: (a) `chmod +x` no repo; (b) `make-release-zip.mjs`
  zipa de uma cópia em staging com `chmod 755 scripts/*.sh` garantido
  (funciona mesmo vindo de checkout sem bit exec); (c) o instalador roda
  `chmod +x scripts/*.sh` após copiar e aborta se `migrate-seed.sh` não
  estiver executável.
- Testes: ZIP real é extraído e cada `.sh` tem o modo conferido + 
  `migrate-seed.sh` executado direto (chega ao guard do docker, sem erro de
  permissão); instalador testado com origem `644` (3/3 zip, 8/8 deploy).

## 2. Chat com modelo disponível + Ollama/Qwen3 4B (PRONTO + DOCUMENTADO)

- Recém-instalado, o chat funciona em modo demonstração **honesto**
  (`CR Local (demonstração)` — avisa que não é IA real; fallback visível).
- `ollama-setup.sh` endurecido: trava de RAM (recusa modelos ≥14B antes de
  baixar, salvo `ALLOW_HEAVY_MODEL=1`), teste de geração após cada pull
  (prova que o modelo responde). Testes com shims: 5/5.
- `INSTALACAO.md` §2.6 nova: comandos exatos, saída esperada, 3 verificações
  obrigatórias, tabela de RAM (4b padrão ~2,5 GB; 8b ~5 GB cabe; 14B+ não).
  Nenhuma config extra é necessária (o chat detecta o Ollama sozinho).

## 3. Updater desativado por padrão (CORRIGIDO)

- Serviço `updater` atrás de `profiles: [updates]`: `deploy --apply` e
  `compose up` padrão **não** o sobem; aprovações só acumulam na fila e o
  chat/API funcionam normalmente. Ativação explícita documentada
  (`--profile updates` + `docs/UPDATES.md`).
- Endurecimento anterior mantido (HMAC, hash da árvore, cap_drop ALL,
  no-new-privileges, FS só-leitura, crash recovery — 12/12 testes).
- `docs/OPCIONAIS.md` NOVO: tabela clara de tudo que nasce desligado + como
  ligar cada item.

## 4. Fluxo completo em ambiente real (EXECUTADO — sem Docker)

Sem `dockerd` neste sandbox, executei o fluxo máximo possível com
componentes 100% reais (PostgreSQL 17.11 via apt + API compilada + HTTP):

- `migrate` aplicou **0001+0002+0003** no PG real; `seed` (produção, senhas
  fortes) criou admin+convidada.
- API `dist/` subiu em `DB_DRIVER=postgres`; `/api/health` ok; login real
  (JWT 269 chars); `POST /api/chat/completions` real (conversa persistida).
- `kill -9` + reboot: mesma conversa e 2 mensagens lidas via HTTP.
- Tudo automatizado em `scripts/e2e-real.test.mjs` (roda com `PG_E2E_URL`;
  sem ele, declara SKIP honesto). Verificado manualmente E pelo teste.
- NÃO executado aqui (exige a VPS): containers/compose, túnel, navegador.

## 5. Backup/restore consistente (EXECUTADO localmente)

- `pg_dump --clean --if-exists | gzip` → `gzip -t` + sha256 → restore em banco
  novo com `ON_ERROR_STOP=1` → **contagens e md5 do conteúdo idênticos**
  (users=2, convs=1, msgs=2) entre origem e restaurado. Dentro do e2e-real.
- Restic v3 da VPS intacto: teste-invariante prova que nenhum script do app
  invoca `restic` (só deposita dumps na árvore observada). Aqui, nenhum
  comando tocou em nada fora do PG local de teste.

## 6. Testes automatizados (separados como pedido)

| Grupo | Aprovados | Ignorados | Não executados |
|---|---|---|---|
| `tsc --noEmit` (api) | limpo | — | — |
| `npm run build` (web) | verde | — | — |
| `vitest` (api) | **217** | 12 (motivo em cada teste: PG-VPS, SearXNG daemon, SMTP, R2, chaves pagas, dockerd) | 0 |
| `test:scripts` (com `PG_E2E_URL`) | **61** (backup 9, compose 9, deploy 8, e2e-real 1, zip 3, ollama 5, r2-lib 11, update-sh 3, updater 12) | 0 | 0 |

Não executados fora das suítes (impossível neste sandbox, sem acesso à OVH):
containers/compose reais, túnel Cloudflare, navegador real, Ollama real +
download Qwen3, SearXNG daemon, SMTP, R2, chaves pagas/GitHub, apply real do
updater, restore via `backup.sh`/`restore.sh` (wrappers docker; lógica de
dump/restore provada + guardas 9/9).
**Nenhuma homologação da OVH é declarada** — só o que rodou acima.

## 7. Entrega

ZIP único `cr-ia-v0.2.0-pronta.zip` (sha256 impresso na geração): scripts
executáveis, docs atualizadas (INSTALACAO §2.2/§2.6, UPDATES, OPCIONAIS,
PENDENCIAS itens 4 e 10 rebaixados), opcionais desligados por padrão.
Instalação: extrair em `/opt/cr-ia/app` → `.env` (senhas do dono) →
`deploy-vps-pronta.sh --check/--apply` → Ollama (§2.6).
