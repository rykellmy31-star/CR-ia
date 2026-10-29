#!/usr/bin/env bash
# =====================================================================
# CR IA v0.1.1 — migração do banco + criação SEGURA das contas iniciais.
# Usa os .js COMPILADOS (dist) — funciona na imagem Docker de produção,
# que não contém código-fonte .ts nem tsx.
#
# Uso (dentro da pasta do projeto, com .env preenchido):
#   ./scripts/migrate-seed.sh
#
# Segurança: o seed cria as contas uma vez e nunca sobrescreve existentes
# (a menos que UPDATE_EXISTING=true no .env). Em produção, senhas padrão
# são recusadas e o script aborta sem alterar nada.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

if ! docker compose ps --status running --services 2>/dev/null | grep -qx "api"; then
  echo "[migrate-seed] ERRO: serviço 'api' não está rodando (ou sem acesso ao Docker)."
  echo "Rode antes: docker compose up -d --build"
  echo "(Se 'permission denied', seu usuário precisa estar no grupo docker: sudo usermod -aG docker \$USER)"
  exit 1
fi

echo "[migrate-seed] Aplicando schema Postgres..."
docker compose exec -T api node apps/api/dist/migrate.js

echo "[migrate-seed] Criando contas (admin + convidada)..."
docker compose exec -T api node apps/api/dist/seed.js

echo "[migrate-seed] Pronto. Confira: docker compose logs --tail=30 api"
