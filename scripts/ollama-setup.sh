#!/usr/bin/env bash
# =====================================================================
# CR IA v0.2.0 — baixa os modelos REAIS no Ollama da VPS + prova que geram.
# Uso:
#   docker compose --profile ollama up -d
#   ./scripts/ollama-setup.sh
# Lê OLLAMA_TEXT_MODELS do .env (padrão: qwen3:4b — seguro em 12 GB RAM).
#
# Orçamento de RAM (VPS 12 GB, Ollama limitado a 7 GB no compose):
#   qwen3:4b (~2.5 GB) padrão seguro | qwen3:8b (~5 GB) cabe
#   14B+ (~9 GB+) NÃO cabe — recusado, a menos que ALLOW_HEAVY_MODEL=1.
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

# Carrega .env se existir (sem executar nada perigoso: só VAR=valor simples)
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

MODELS="${OLLAMA_TEXT_MODELS:-qwen3:4b}"

if ! docker compose ps --status running --services 2>/dev/null | grep -qx "ollama"; then
  echo "[ollama-setup] Subindo serviço ollama..."
  docker compose --profile ollama up -d
fi

echo "[ollama-setup] Aguardando Ollama responder (até 3 min)..."
for i in $(seq 1 36); do
  if docker compose exec -T ollama ollama list >/dev/null 2>&1; then
    echo "[ollama-setup] Ollama pronto."
    break
  fi
  if [ "$i" -eq 36 ]; then
    echo "[ollama-setup] ERRO: Ollama não respondeu. Veja: docker compose logs ollama"
    exit 1
  fi
  sleep 5
done

IFS=',' read -ra LIST <<< "$MODELS"
# Trava de RAM ANTES de baixar qualquer coisa (fail-fast, sem desperdício).
for m in "${LIST[@]}"; do
  m="$(echo "$m" | xargs)"
  [ -z "$m" ] && continue
  if [[ "$m" =~ :([0-9]+)b(-|$) ]] && [ "${BASH_REMATCH[1]}" -ge 14 ] && [ "${ALLOW_HEAVY_MODEL:-0}" != "1" ]; then
    echo "[ollama-setup] ERRO: modelo '$m' (>=14B, ~9 GB+) excede o orçamento de 12 GB RAM." >&2
    echo "  Use qwen3:4b (padrão) ou qwen3:8b. Para forçar (risco de OOM): ALLOW_HEAVY_MODEL=1 $0" >&2
    exit 1
  fi
done
for m in "${LIST[@]}"; do
  m="$(echo "$m" | xargs)"
  [ -z "$m" ] && continue
  echo "[ollama-setup] Baixando modelo: $m (pode demorar vários minutos)..."
  docker compose exec -T ollama ollama pull "$m"
  echo "[ollama-setup] Teste de geração em $m (prova de funcionamento)..."
  if ! OUT="$(timeout 300 docker compose exec -T ollama ollama run "$m" "Responda apenas: OK" 2>&1)"; then
    echo "[ollama-setup] ERRO: o modelo $m não gerou resposta. Veja: docker compose logs ollama" >&2
    exit 1
  fi
  if [ -z "$(echo "$OUT" | tr -d '[:space:]')" ]; then
    echo "[ollama-setup] ERRO: o modelo $m respondeu vazio." >&2
    exit 1
  fi
  echo "[ollama-setup] $m respondeu: $(echo "$OUT" | head -c 120)"
done

echo "[ollama-setup] Modelos instalados:"
docker compose exec -T ollama ollama list
echo "[ollama-setup] Pronto. Confira no painel: Administração → Sistema."
