#!/usr/bin/env bash
# =====================================================================
# CR IA v0.2.0 — backup (Postgres + arquivos) DENTRO da rotina Restic.
#
# Destino padrão: /opt/cr-ia/data/cr-ia-dumps (subdiretório NOVO dentro da
# árvore que o Restic já observa na VPS). O script NUNCA toca no repositório
# Restic em si (sem init/prune/forget/delete de snapshots): só deposita dumps.
#
# Garantias: pg_dump consistente (transação única) — nunca cópia de arquivos
# do Postgres vivo; escrita atômica em staging + manifest com SHA256 publicado
# POR ÚLTIMO (anti-parcial); verificação de integridade antes de publicar;
# retenção não-destrutiva (só apaga conjuntos antigos completos, nunca deixa
# menos de 2; nunca apaga nada fora dos nossos padrões de nome).
#
# Uso manual: ./scripts/backup.sh
# Automático: cron diário (ver scripts/install-vps.sh).
# Restauração: ./scripts/restore.sh <STAMP>
# =====================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-/opt/cr-ia/data/cr-ia-dumps}"
RETENTION_SETS="${RETENTION_SETS:-14}"
MIN_KEEP_SETS=2
STAMP="$(date +%F_%H%M%S)"

# --- guardas fail-closed (antes de qualquer docker) ---
if [ -z "$BACKUP_DIR" ] || [ "$BACKUP_DIR" = "/" ]; then
  echo "[backup] ERRO: BACKUP_DIR inválido ('$BACKUP_DIR')." >&2
  exit 1
fi
if ! mkdir -p "$BACKUP_DIR" 2>/dev/null; then
  echo "[backup] ERRO: não consigo criar $BACKUP_DIR (permissão?). Rode como o usuário do app." >&2
  exit 1
fi
if ! docker compose ps --status running --services 2>/dev/null | grep -qx "db"; then
  echo "[backup] ERRO: serviço 'db' não está rodando (ou sem acesso ao Docker)." >&2
  exit 1
fi

TMP="$BACKUP_DIR/.tmp.$STAMP.$$"
mkdir -p "$TMP"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
echo "[backup] $STAMP — iniciando (staging: $TMP)..."

APP_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo '?')"
PG_VERSION="$(docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SHOW server_version;"' 2>/dev/null | tr -d '[:space:]' || echo '?')"

# --- 1. banco (dump transacional consistente) ---
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists' \
  | gzip > "$TMP/db-$STAMP.sql.gz"
# --- 2. roles/globals (necessários p/ recuperação completa) ---
docker compose exec -T db sh -c 'pg_dumpall -U "$POSTGRES_USER" --globals-only' \
  | gzip > "$TMP/globals-$STAMP.sql.gz"
# --- 3. arquivos (volume somente-leitura) ---
docker run --rm -v cr-ia_apidata:/data:ro -v "$TMP:/b" alpine \
  tar czf "/b/arquivos-$STAMP.tar.gz" /data

# --- 4. verificação ANTES de publicar (anti-parcial) ---
for f in "db-$STAMP.sql.gz" "globals-$STAMP.sql.gz"; do
  gzip -t "$TMP/$f" || { echo "[backup] ERRO: $f corrompido. Nada foi publicado." >&2; exit 1; }
done
tar tzf "$TMP/arquivos-$STAMP.tar.gz" >/dev/null \
  || { echo "[backup] ERRO: arquivos-$STAMP.tar.gz corrompido. Nada foi publicado." >&2; exit 1; }
for f in "db-$STAMP.sql.gz" "globals-$STAMP.sql.gz" "arquivos-$STAMP.tar.gz"; do
  [ -s "$TMP/$f" ] || { echo "[backup] ERRO: $f vazio. Nada foi publicado." >&2; exit 1; }
done
echo "[backup] integridade: OK (gzip + tar + não-vazios)"

# --- 5. manifest + publicação (manifest POR ÚLTIMO) ---
sha() { sha256sum "$TMP/$1" | cut -d' ' -f1; }
bytes() { stat -c%s "$TMP/$1"; }
{
  echo "{"
  echo "  \"stamp\": \"$STAMP\","
  echo "  \"app_version\": \"$APP_VERSION\","
  echo "  \"pg_version\": \"$PG_VERSION\","
  echo "  \"verified\": true,"
  echo "  \"files\": ["
  echo "    {\"name\": \"db-$STAMP.sql.gz\", \"bytes\": $(bytes "db-$STAMP.sql.gz"), \"sha256\": \"$(sha "db-$STAMP.sql.gz")\"},"
  echo "    {\"name\": \"globals-$STAMP.sql.gz\", \"bytes\": $(bytes "globals-$STAMP.sql.gz"), \"sha256\": \"$(sha "globals-$STAMP.sql.gz")\"},"
  echo "    {\"name\": \"arquivos-$STAMP.tar.gz\", \"bytes\": $(bytes "arquivos-$STAMP.tar.gz"), \"sha256\": \"$(sha "arquivos-$STAMP.tar.gz")\"}"
  echo "  ]"
  echo "}"
} > "$TMP/manifest-$STAMP.json"
mv "$TMP/db-$STAMP.sql.gz" "$TMP/globals-$STAMP.sql.gz" "$TMP/arquivos-$STAMP.tar.gz" "$BACKUP_DIR/"
mv "$TMP/manifest-$STAMP.json" "$BACKUP_DIR/"
echo "[backup] publicado: $STAMP (manifest verificado)"

# --- 6. retenção não-destrutiva (só conjuntos completos; piso de 2) ---
mapfile -t SETS < <(ls "$BACKUP_DIR"/manifest-*.json 2>/dev/null | sort || true)
TOTAL="${#SETS[@]}"
if [ "$TOTAL" -gt "$RETENTION_SETS" ]; then
  DELETE_COUNT=$((TOTAL - RETENTION_SETS))
  # piso: nunca deixar menos de MIN_KEEP_SETS conjuntos
  MAX_DELETE=$((TOTAL - MIN_KEEP_SETS))
  if [ "$DELETE_COUNT" -gt "$MAX_DELETE" ]; then
    DELETE_COUNT="$MAX_DELETE"
  fi
  if [ "$DELETE_COUNT" -gt 0 ]; then
    for ((i = 0; i < DELETE_COUNT; i++)); do
      OLD_MANIFEST="${SETS[$i]}"
      OLD_STAMP="$(basename "$OLD_MANIFEST" .json)"
      OLD_STAMP="${OLD_STAMP#manifest-}"
      # verified:true obrigatório — conjunto incompleto NUNCA é apagado aqui
      if ! grep -q '"verified": true' "$OLD_MANIFEST" 2>/dev/null; then
        echo "[backup] retenção: pulando $OLD_STAMP (manifest não-verificado)."
        continue
      fi
      echo "[backup] retenção: removendo conjunto $OLD_STAMP"
      rm -f "$BACKUP_DIR/db-$OLD_STAMP.sql.gz" "$BACKUP_DIR/globals-$OLD_STAMP.sql.gz" \
        "$BACKUP_DIR/arquivos-$OLD_STAMP.tar.gz" "$OLD_MANIFEST"
    done
  else
    echo "[backup] retenção: piso de $MIN_KEEP_SETS conjuntos — nada removido."
  fi
fi
# limpa stagings abandonados (+24h) — nunca toca em conjuntos publicados
find "$BACKUP_DIR" -maxdepth 1 -name '.tmp.*' -mmin +1440 -exec rm -rf {} + 2>/dev/null || true

echo "[backup] concluído. Conjuntos guardados (máx $RETENTION_SETS, piso $MIN_KEEP_SETS):"
ls "$BACKUP_DIR"/manifest-*.json 2>/dev/null | tail -5 || true
