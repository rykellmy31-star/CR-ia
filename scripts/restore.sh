#!/usr/bin/env bash
# =====================================================================
# CR IA v0.2.0 — RESTAURAÇÃO a partir de um conjunto verificado.
# Uso:
#   ./scripts/restore.sh                 # lista conjuntos disponíveis
#   ./scripts/restore.sh <STAMP>         # ex.: 2026-10-22_020000
#
# Segurança: só restaura conjunto com manifest verified:true + SHA256
# conferido (anti-parcial); faz backup de segurança do estado atual ANTES;
# pede confirmação digitada. Restauração SUBSTITUI os dados atuais.
# Recuperação isolada (teste sem tocar na produção): ver docs/INSTALACAO.md.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-/opt/cr-ia/data/cr-ia-dumps}"
WANT="${1:-}"

if [ -z "$WANT" ]; then
  echo "Uso: ./scripts/restore.sh <STAMP>"
  echo "Conjuntos disponíveis em $BACKUP_DIR:"
  ls -1 "$BACKUP_DIR"/manifest-*.json 2>/dev/null || echo "  (nenhum conjunto publicado)"
  exit 1
fi

MANIFEST="$BACKUP_DIR/manifest-$WANT.json"
DB="$BACKUP_DIR/db-$WANT.sql.gz"
GLOBALS="$BACKUP_DIR/globals-$WANT.sql.gz"
FILES="$BACKUP_DIR/arquivos-$WANT.tar.gz"

[ -f "$MANIFEST" ] || { echo "ERRO: conjunto incompleto — sem manifest: $MANIFEST" >&2; exit 1; }
grep -q '"verified": true' "$MANIFEST" || { echo "ERRO: manifest não-verificado (conjunto parcial). Abortando." >&2; exit 1; }

echo "!!! ATENÇÃO: isto SUBSTITUI o banco atual pelo conjunto: $WANT"
echo "!!! E substitui os arquivos (uploads) pelos do mesmo conjunto."
read -r -p 'Digite RESTAURAR para confirmar: ' CONFIRM
[ "$CONFIRM" = "RESTAURAR" ] || { echo "Cancelado. Nada foi alterado."; exit 0; }

# Verificação criptográfica + integridade ANTES de qualquer docker destrutivo
echo "[restore] Conferindo SHA256 do manifest..."
for f in "db-$WANT.sql.gz" "globals-$WANT.sql.gz" "arquivos-$WANT.tar.gz"; do
  [ -f "$BACKUP_DIR/$f" ] || { echo "ERRO: conjunto parcial — falta $f. Abortando." >&2; exit 1; }
  WANT_SHA="$(grep -o "\"name\": \"$f\", \"bytes\": [0-9]*, \"sha256\": \"[0-9a-f]*\"" "$MANIFEST" | grep -o '[0-9a-f]\{64\}' || true)"
  GOT_SHA="$(sha256sum "$BACKUP_DIR/$f" | cut -d' ' -f1)"
  if [ -z "$WANT_SHA" ] || [ "$WANT_SHA" != "$GOT_SHA" ]; then
    echo "ERRO: SHA256 de $f NÃO confere (corrompido?). Abortando." >&2
    exit 1
  fi
done
gzip -t "$DB" && gzip -t "$GLOBALS" && tar tzf "$FILES" >/dev/null \
  || { echo "ERRO: integridade falhou. Abortando." >&2; exit 1; }
echo "[restore] SHA256 + integridade: OK"

if ! docker compose ps --status running --services 2>/dev/null | grep -qx "db"; then
  echo "[restore] ERRO: serviço 'db' não está rodando." >&2
  exit 1
fi

STAMP="antes-restore-$(date +%F_%H%M%S)"
echo "[restore] Backup de segurança do estado atual ($STAMP)..."
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  | gzip > "$BACKUP_DIR/db-$STAMP.sql.gz"

echo "[restore] Restaurando roles + banco (pode demorar)..."
gunzip -c "$GLOBALS" | docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d postgres -q -v ON_ERROR_STOP=0'  || true
gunzip -c "$DB" | docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q -v ON_ERROR_STOP=1' 

echo "[restore] Restaurando arquivos..."
docker run --rm -v cr-ia_apidata:/data -v "$BACKUP_DIR:/b:ro" alpine \
  sh -c "rm -rf /data/* && tar xzf /b/arquivos-$WANT.tar.gz -C /"

echo "[restore] Concluído. Reiniciando api/worker para recarregar estado..."
docker compose up -d api worker
docker compose ps
