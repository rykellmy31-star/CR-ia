#!/usr/bin/env bash
# Vincula CR IA existente em /opt/cr-ia/app ao GitHub sem limpar dados ou volumes.
# Executar na VPS: sudo bash scripts/migrar-vps-existente-github.sh --check|--apply
set -Eeuo pipefail
set +x
umask 077
APP=/opt/cr-ia/app
ROOT=/opt/cr-ia
REMOTE=https://github.com/rykellmy31-star/CR-ia.git
MODE=${1:---check}
log() { printf '[CR IA] %s\n' "$*"; }
fail() { printf '[CR IA] ERRO: %s\n' "$*" >&2; exit 1; }
[[ "$EUID" == 0 ]] || fail 'Execute com sudo.'
[[ "$MODE" == '--check' || "$MODE" == '--apply' ]] || fail 'Use --check ou --apply.'
[[ -f "$APP/docker-compose.yml" && -s "$APP/.env" ]] || fail 'CR IA atual ou .env nao encontrados.'
[[ ! -d "$APP/.git" ]] || fail 'A instalação já está vinculada a Git; use o menu.'
for command in git docker python3 tar timeout curl openssl; do
  command -v "$command" >/dev/null || fail "Ferramenta ausente: $command"
done
docker compose version >/dev/null 2>&1 || fail 'Docker Compose indisponivel.'
log "Projeto atual: $APP"
log "Repositorio: $REMOTE"
(cd "$APP" && docker compose ps) || fail 'Docker Compose da instalacao atual indisponivel.'
DBID=$(docker ps -q --filter label=com.docker.compose.project=cr-ia --filter label=com.docker.compose.service=db --filter status=running | head -n 1)
[[ -n "$DBID" ]] || fail 'Banco cr-ia nao esta em execucao.'
if [[ "$MODE" == '--check' ]]; then
  log 'DIAGNOSTICO OK. Nenhuma mudança aplicada.'
  exit 0
fi
[[ -t 0 ]] || fail 'Execute no CMD ou SSH interativo.'
read -r -p 'Substituir somente o codigo da CR IA nesta VPS? Digite MIGRAR: ' ANSWER
[[ "$ANSWER" == 'MIGRAR' ]] || fail 'Cancelado.'
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="$ROOT/backups/migracao-github-$STAMP"
STAGE="$ROOT/.git-migracao-$STAMP"
mkdir -p "$BACKUP"
chmod 700 "$BACKUP"
log 'Clonando codigo GitHub em staging; instalacao atual permanece ativa.'
GIT_TERMINAL_PROMPT=0 git -c credential.helper= clone --quiet --depth 1 --branch main "$REMOTE" "$STAGE" ||
  fail 'Clone falhou. Instalacao atual preservada.'
[[ -f "$STAGE/docker-compose.yml" && -f "$STAGE/scripts/cria-menu.sh" ]] || fail 'Codigo GitHub incompleto.'
[[ "$(git -C "$STAGE" remote get-url origin)" == "$REMOTE" ]] || fail 'Origem GitHub inesperada.'
cp -p "$APP/.env" "$STAGE/.env"
cp -p "$APP/.env" "$BACKUP/env-original"
chmod 600 "$STAGE/.env" "$BACKUP/env-original"
if ! grep -qE '^UPDATER_QUEUE_SECRET=.+$' "$STAGE/.env"; then
  printf '\nUPDATER_QUEUE_SECRET=%s\n' "$(openssl rand -hex 32)" >> "$STAGE/.env"
fi
(cd "$STAGE" && docker compose config -q) || fail 'Nova configuracao invalida. Instalacao atual intocada.'
log 'Criando e verificando backup do PostgreSQL.'
timeout 240 docker exec "$DBID" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BACKUP/postgres.dump" ||
  fail 'Backup falhou. Instalacao atual intocada.'
[[ -s "$BACKUP/postgres.dump" ]] || fail 'Backup vazio. Instalacao atual intocada.'
docker exec -i "$DBID" sh -c 'pg_restore -l > /dev/null' < "$BACKUP/postgres.dump" ||
  fail 'Backup do PostgreSQL invalido. Instalacao atual intocada.'
chmod 600 "$BACKUP/postgres.dump"
if docker volume inspect cr-ia_apidata >/dev/null 2>&1; then
  UPLOADS=$(docker volume inspect -f '{{.Mountpoint}}' cr-ia_apidata)
  [[ -d "$UPLOADS" ]] || fail 'Volume de uploads nao acessivel.'
  tar -czf "$BACKUP/uploads.tar.gz" -C "$UPLOADS" . || fail 'Backup de uploads falhou.'
  tar -tzf "$BACKUP/uploads.tar.gz" >/dev/null || fail 'Backup de uploads invalido.'
  chmod 600 "$BACKUP/uploads.tar.gz"
fi
log "Backup confirmado em: $BACKUP"
log 'Guardando diretório antigo; ativando checkout GitHub (sem apagar volumes).'
mv "$APP" "$BACKUP/app-anterior" || fail 'Nao consegui preservar app anterior.'
if ! mv "$STAGE" "$APP"; then
  mv "$BACKUP/app-anterior" "$APP" || true
  fail 'Falhou troca de pastas. Tentei restaurar app original.'
fi
cd "$APP"
log 'Reconstruindo somente servicos principais da CR IA.'
docker compose up -d --build db api worker web ||
  fail "Deploy falhou. Codigo antigo salvo em $BACKUP/app-anterior."
log 'Atualizando banco de forma aditiva e mantendo usuarios.'
bash scripts/migrate-seed.sh ||
  fail "Migracoes falharam. Não faca downgrade automatico; backup em $BACKUP."
log 'Ativando menu global.'
bash scripts/instalar-menu.sh || fail 'Aplicacao instalada, mas menu falhou.'
log 'Aguardando healthcheck local...'
OK=0
for i in $(seq 1 24); do
  if curl -fsS --max-time 4 'http://127.0.0.1:3000/api/health' >/dev/null 2>&1; then OK=1; break; fi
  sleep 5
done
[[ "$OK" == '1' ]] || fail "Aplicacao ainda nao passou no healthcheck. Consulte logs. Backup: $BACKUP"
log 'SUCESSO. A CR IA agora usa o repositório GitHub; execute: menu'
log "Codigo anterior e backups: $BACKUP"
