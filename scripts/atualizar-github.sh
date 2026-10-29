#!/usr/bin/env bash
# Atualiza a CR IA instalada pelo bootstrap. Não use em instalação sem .git.
set -Eeuo pipefail
set +x
umask 077
log() { printf '[CR IA UPDATE] %s\n' "$*"; }
fail() { echo "[CR IA UPDATE] ERRO: $*" >&2; exit 1; }
(( EUID == 0 )) || fail 'Execute com sudo: sudo bash scripts/atualizar-github.sh'
[[ -t 0 ]] || fail 'Execute interativamente para informar o token sem expô-lo.'
cd /opt/cr-ia/app || fail 'CR IA não encontrada.'
[[ -d .git && -f .env && -f docker-compose.yml ]] || fail 'Instalação GitHub ou configuração .env ausente.'
[[ -z "$(git status --porcelain)" ]] || fail 'Existem mudanças locais no código. Atualização recusada até revisão.'

BRANCH=${CRIA_REF:-main}
[[ "$BRANCH" =~ ^[a-zA-Z0-9._/-]+$ && "$BRANCH" != -* ]] || fail 'Branch inválida.'
TMP=$(mktemp -d /tmp/cria-update.XXXXXX)
chmod 700 "$TMP"
cleanup() {
 if [[ -d "${TMP:-}" ]]; then
  if [[ -f "$TMP/token" ]]; then
   command -v shred >/dev/null 2>&1 && shred -u "$TMP/token" 2>/dev/null || rm -f "$TMP/token"
  fi
  rm -rf "$TMP"
 fi
}
trap cleanup EXIT
cat > "$TMP/askpass" <<'EOS'
#!/bin/sh
case "${1:-}" in
 *Username*) printf 'x-access-token\n' ;;
 *Password*) cat "$CRIA_TOKEN_FILE" ;;
 *) exit 1 ;;
esac
EOS
chmod 700 "$TMP/askpass"

log 'Consultando versão do GitHub sem substituir arquivos.'
if ! GIT_TERMINAL_PROMPT=0 git -c credential.helper= fetch --quiet --depth=1 origin "$BRANCH"; then
  log 'GitHub exige credenciais (repositório privado ou acesso restrito).'
  read -r -s -p 'Token GitHub (Contents: Read, não será salvo): ' GH_TOKEN
  printf '\n'
  [[ ${#GH_TOKEN} -ge 20 ]] || fail 'Token ausente ou curto.'
  printf '%s' "$GH_TOKEN" > "$TMP/token"; unset GH_TOKEN; chmod 600 "$TMP/token"
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$TMP/askpass" CRIA_TOKEN_FILE="$TMP/token" \
    git -c credential.helper= fetch --quiet --depth=1 origin "$BRANCH" || fail 'Não foi possível consultar o repositório.'
fi
CURRENT=$(git rev-parse HEAD)
NEW=$(git rev-parse FETCH_HEAD)
if [[ "$CURRENT" == "$NEW" ]]; then log 'Já está na versão do GitHub.'; exit 0; fi

log "Atual: ${CURRENT:0:12} | Nova: ${NEW:0:12}"
git diff --check HEAD FETCH_HEAD || fail 'Nova versão contém whitespace/conflictos que devem ser revisados.'
read -r -p 'Deseja aplicar a nova versão após backup? Digite ATUALIZAR: ' answer
[[ "$answer" == 'ATUALIZAR' ]] || fail 'Cancelado sem alterações.'

log 'Backup completo obrigatório (banco + arquivos, se o script suportar).'
bash scripts/backup.sh || fail 'Backup falhou. Código não alterado.'
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p /opt/cr-ia/backups
chmod 700 /opt/cr-ia/backups

git archive --format=tar.gz -o "/opt/cr-ia/backups/fonte-$STAMP-$CURRENT.tar.gz" HEAD
chmod 600 "/opt/cr-ia/backups/fonte-$STAMP-$CURRENT.tar.gz"

log 'Atualizando somente código versionado (o .env e volumes não são versionados).'
git reset --hard FETCH_HEAD

log 'Validando Docker Compose e reconstruindo serviços.'
if ! docker compose config -q; then
  log 'Falhou antes da implantação, revertendo código.'
  git reset --hard "$CURRENT"
  fail 'Nova configuração inválida. Código antigo restaurado.'
fi
if ! docker compose up -d --build db api worker web; then
  log 'Falhou ao iniciar. Código antigo salvo, atenção: verificar contêineres.'
  fail "Veja logs: docker compose logs --tail=100. Cópia do código anterior em /opt/cr-ia/backups. Commit: $CURRENT"
fi
log 'Aplicando migração e seed sem sobrescrever usuários.'
bash scripts/migrate-seed.sh || fail 'Migração falhou. Não faça downgrade sem avaliar o banco; backup disponível.'

log 'Checando saúde local.'
for i in $(seq 1 36); do
 if curl -fsS --max-time 4 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
   log "Atualizado com sucesso: $NEW"
   docker compose ps
   exit 0
 fi
 sleep 5
done
fail 'O healthcheck não passou. Código antigo e backups preservados; faça diagnóstico antes de reversão.'
