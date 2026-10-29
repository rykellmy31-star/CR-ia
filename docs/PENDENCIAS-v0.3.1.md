# CR IA v0.3.1 — Lista de pendências (o que falta provar/fazer)

> Atualizado em **24/10/2026**. Rodada bloqueios-da-atualização. Herdado da
> v0.3.0 (`PENDENCIAS-v0.3.0.md` continua válido para o restante).

## ✅ Resolvido nesta rodada

- **Segredo HMAC na API**: `UPDATER_QUEUE_SECRET` adicionado ao serviço
  `api` no compose (antes só o `updater` tinha → aprovar retornava erro).
  Teste de regressão no `compose-check`.
- **Assinatura minisign**: `scripts/sign-release.mjs` (genkey/sign/verify,
  3/3 testes), par `cr-ia-release` gerado, ZIP v0.3.1 assinado
  (`.minisig` entregue junto), instruções em `docs/UPDATES.md` + `.env.example`.
- **Preservação provada**: `.env`, `data/`, `backups/`, `node_modules`
  byte-idênticos após apply E rollback (teste ponta a ponta). PostgreSQL
  (volume `pgdata`), usuários (seed preserva), imagens (`apidata`, excluído
  do rsync) e settings (migrações aditivas) não são tocados pelo updater,
  que só roda `up -d --build` (nunca `down -v`) + migrate + health.
- **Fluxo completo testado**: upload assinado → checks → aprovação HMAC →
  aplicação → rollback (4/4 em `update-flow.test.ts`, com updater real
  spawnado, fila HMAC recomputada e health HTTP real).

## P0 — Exige a VPS / chaves do dono (não executável pelo agente)

- [ ] **P0.1 — Primeira instalação via SSH** com `cr-ia-v0.3.1-pronta.zip`
  (`docs/INSTALACAO.md` §2.2) + `UPDATE_SIGNING_PUBLIC_KEY` no `.env`
  (2ª linha do `cr-ia-release.pub`). Confirmar `/api/health` = `0.3.1`.
- [ ] **P0.2 — Ligar o aplicador (1 comando SSH)**: perfil `updates`
  (`docker compose --profile updates up -d`). Depois disso, atualizações
  futuras são 100% pelo painel (upload do ZIP + `.minisig` → aprovar).
  O painel mostra 🟢/🟡 do aplicador.
- [ ] **P0.3 — Primeira atualização REAL pelo painel** (quando houver v0.3.2+):
  vai exercitar Postgres/migrate de verdade. O caminho foi testado com
  shims; docker/rsync/health reais só existem na VPS.
- [ ] **P0.4 — Custódia do `cr-ia-release.key`**: está entregue junto com
  o ZIP. Guarde OFFLINE (fora do servidor, fora do git). Quem tem o `.key`
  assina releases no seu nome. Se vazar, gere outro par e troque a pública
  no `.env` (1 SSH) — ZIPs antigos assinados continuam válidos só até a troca.
- [ ] P0.1–P0.4 da v0.3.0 (OpenRouter: chave real, sync, primeiras chamadas
  pagas) — sem mudança.

## P1 — Melhorias futuras (não bloqueiam)

- P1.1–P1.2 da v0.3.0 (preço por endpoint de imagem; totalizador de custo).
- P1.3 da v0.3.0 resolvido (era este: chaves + assinatura).
