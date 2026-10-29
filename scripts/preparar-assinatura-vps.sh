#!/usr/bin/env bash
# Execute somente na VPS que VOCÊ controla, após copiar o ZIP corrigido.
# Cria par de chaves com Minisign oficial, assina e verifica sem tocar na CR IA.
set -euo pipefail
umask 077
ZIP="${1:-}"
if [[ -z "$ZIP" || ! -f "$ZIP" || "$ZIP" != *.zip ]]; then
  echo 'Uso: bash preparar-assinatura-vps.sh /caminho/cr-ia-v0.3.1-corrigida.zip' >&2
  exit 2
fi
if ! command -v minisign >/dev/null 2>&1; then
  echo 'ERRO: minisign ausente. Rode: sudo apt-get install minisign' >&2
  exit 1
fi
ZIP="$(realpath "$ZIP")"
KEYDIR="$HOME/cria-assinaturas"
PUB="$KEYDIR/cr-ia-release-nova.pub"
PRIV="$KEYDIR/cr-ia-release-nova.key"
SIG="$ZIP.minisig"
mkdir -p "$KEYDIR"
chmod 700 "$KEYDIR"
if [[ -e "$PUB" || -e "$PRIV" || -e "$SIG" ]]; then
  echo 'ERRO: arquivo de chave/assinatura já existe. Nada foi sobrescrito.' >&2
  exit 1
fi
echo '=== GERANDO CHAVES MINISIGN OFICIAIS ==='
echo 'Uma senha será solicitada para proteger sua chave PRIVADA.'
minisign -G -p "$PUB" -s "$PRIV"
chmod 600 "$PRIV"
echo '=== ASSINANDO O ZIP ==='
minisign -S -m "$ZIP" -s "$PRIV" -x "$SIG"
echo '=== VERIFICANDO ASSINATURA COMPLETA ==='
minisign -Vm "$ZIP" -p "$PUB" -x "$SIG"
echo '=== SHA256 DO ZIP ==='
sha256sum "$ZIP"
echo '=== ARQUIVOS PRONTOS ==='
printf 'ZIP: %s\nASSINATURA: %s\nPUBLICA: %s\n' "$ZIP" "$SIG" "$PUB"
echo 'IMPORTANTE: configure UPDATE_SIGNING_PUBLIC_KEY no .env com a segunda linha do .pub.'
echo 'ATENCAO: faça backup OFFLINE e REMOVA da VPS a chave .key antes de habilitar atualizações remotas.'
