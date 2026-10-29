#!/usr/bin/env bash
# =====================================================================
# CR IA — atualização segura (com backup antes).
# Uso: ./scripts/update.sh
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

# Modo ZIP (Central de Atualizações): ./scripts/update.sh --zip <staging-dir>
# O staging já foi verificado (sha256 + assinatura minisign) pela API antes;
# aqui exigimos o recibo e fazemos backup ANTES de tocar em qualquer arquivo.
if [[ "${1:-}" == "--zip" ]]; then
  STAGING="${2:-}"
  [[ -n "$STAGING" && -d "$STAGING" ]] || { echo "[update] ERRO: informe o diretório staging: $0 --zip <dir>"; exit 1; }
  [[ -f "$STAGING/.cr-ia-receipt.json" ]] || { echo "[update] ERRO: staging sem recibo de verificação — recuso aplicar."; exit 1; }
  command -v rsync >/dev/null || { echo "[update] ERRO: rsync não instalado (rode: sudo apt install rsync)."; exit 1; }
  SRC="$STAGING"
  if [[ ! -f "$STAGING/package.json" ]]; then
    for d in "$STAGING"/*/; do
      if [[ -f "${d}package.json" ]]; then SRC="$d"; break; fi
    done
  fi
  echo "[update] Origem verificada: $SRC"
  bash ./scripts/backup.sh
  echo "[update] Aplicando arquivos (preserva .env, data/, backups/)..."
  rsync -a --delete \
    --exclude='.env' --exclude='.env.*' --exclude='.git/' \
    --exclude='data/' --exclude='backups/' --exclude='node_modules/' \
    --exclude='.cr-ia-receipt.json' \
    "$SRC" ./
  echo "[update] Ajustando dono dos volumes p/ usuário sem-root (best-effort)..."
  docker run --rm -v cr-ia_apidata:/d -v cr-ia_agentwork:/w alpine sh -c "chown -R 1000:1000 /d /w" 2>/dev/null || echo "[update] aviso: não foi possível ajustar dono dos volumes."
  echo "[update] Reconstruindo containers..."
  docker compose up -d --build
  echo "[update] Aplicando migrations (se houver)..."
  docker compose exec -T api node apps/api/dist/migrate.js  # sem '|| true': migração que falha ABORTA o update
  echo "[update] Status:"
  docker compose ps
  exit 0
fi

bash ./scripts/backup.sh
echo "[update] Baixando nova versão..."
git pull
echo "[update] Reconstruindo containers..."
docker compose up -d --build
echo "[update] Aplicando migrations (se houver)..."
docker compose exec -T api node apps/api/dist/migrate.js  # sem '|| true': migração que falha ABORTA o update
echo "[update] Status:"
docker compose ps
