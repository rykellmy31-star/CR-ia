#!/usr/bin/env bash
# CR IA — reinstalacao LIMPA, SOMENTE deste projeto, na VPS atual.
# Nao use bootstrap-github.sh aqui: ele configura UFW/Caddy e nao suporta Ubuntu 26.
# --check: somente diagnostico. --apply: backup, reset de dados CR IA e clone do GitHub.
# Requer confirmacao humana. Mantem SSH, cloudflared, Docker, firewall e outros projetos.
set -Eeuo pipefail
set +x
umask 077
APP=/opt/cr-ia/app
ROOT=/opt/cr-ia
REMOTE=https://github.com/rykellmy31-star/CR-ia.git
MODE=${1:---check}
VOLUMES=(cr-ia_pgdata cr-ia_apidata cr-ia_agentwork cr-ia_ollama cr-ia_aimodels)

msg(){ printf '\n[CR IA - INSTALACAO LIMPA] %s\n' "$*"; }
fail(){ printf '\n[CR IA] ERRO: %s\n' "$*" >&2; exit 1; }
[[ "$EUID" == 0 ]] || fail 'Execute como root: sudo bash ...'
[[ "$MODE" == '--check' || "$MODE" == '--apply' ]] || fail 'Use --check ou --apply.'
[[ -f "$APP/docker-compose.yml" && -s "$APP/.env" ]] || fail 'Instalacao CR IA nao encontrada.'
for program in docker git curl python3 tar timeout; do
  command -v "$program" >/dev/null || fail "Ferramenta ausente: $program"
done
docker compose version >/dev/null || fail 'Docker Compose indisponivel.'
[[ -d "$APP/.git" ]] || fail 'Instalacao nao vinculada ao GitHub.'
[[ "$APP" == /opt/cr-ia/app && "$ROOT" == /opt/cr-ia ]] || fail 'Caminho inseguro.'
[[ $(df -Pk "$ROOT" | awk 'NR==2{print $4}') -ge 5000000 ]] ||
  fail 'Menos de 5 GB livres na VPS.'
log_status(){
  msg 'Containers da CR IA (nenhum outro projeto sera parado):'
  (cd "$APP" && docker compose ps) || fail 'Falha ao inspecionar Docker Compose.'
  msg 'Volumes conhecidos da CR IA:'
  for v in "${VOLUMES[@]}"; do
    if docker volume inspect "$v" >/dev/null 2>&1; then
      project=$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' "$v")
      [[ "$project" == cr-ia || "$project" == '<no value>' || "$project" == '<nil>' ]] ||
        fail "Volume $v pertence a outro projeto: $project"
      printf '%s (projeto=%s)\n' "$v" "$project"
    fi
  done
  msg 'Tunnel Cloudflare:'
  systemctl is-active cloudflared 2>/dev/null || true
}
log_status
if [[ "$MODE" == --check ]]; then
  msg 'DIAGNOSTICO OK: nenhuma modificacao realizada.'
  msg 'No --apply: seus usuarios, imagens, banco, chaves de API e modelos baixados SERAO ZERADOS.'
  msg 'A instalacao anterior e os backups serao preservados em /opt/cr-ia/backups.'
  exit 0
fi
[[ -t 0 ]] || fail 'Execute pelo Termius em sessao interativa.'
printf '\nATENCAO: a CR IA atual sera zerada e sera criado um NOVO Superadmin.\n'
printf 'O site ficara temporariamente indisponivel; outras aplicacoes nao serao alteradas.\n'
read -r -p 'Para confirmar, digite exatamente ZERAR CR IA: ' ACK
[[ "$ACK" == 'ZERAR CR IA' ]] || fail 'Cancelado. Nada alterado.'
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
STAGE="$ROOT/.nova-instalacao-$STAMP"
BACKUP="$ROOT/backups/reinstalacao-limpa-$STAMP"
[[ ! -e "$STAGE" && ! -e "$BACKUP" ]] || fail 'Caminho temporario ja existe.'
install -d -m 700 "$BACKUP"
msg 'Baixando codigo NOVO do GitHub em uma pasta temporaria (sem tocar no site).'
if ! GIT_TERMINAL_PROMPT=0 git -c credential.helper= clone --quiet --depth 1 --branch main "$REMOTE" "$STAGE"; then
  fail 'Clone do repositorio falhou. Instalacao atual permanece intacta. (Repositorio privado exige configuracao de acesso.)'
fi
[[ -f "$STAGE/.env.example" && -f "$STAGE/docker-compose.yml" &&
   -f "$STAGE/scripts/cria-generate-env.py" && -f "$STAGE/scripts/instalar-menu.sh" ]] ||
   fail 'Repositorio incompleto. Instalacao atual permanece intacta.'
(cd "$STAGE" && git remote get-url origin | grep -Fx "$REMOTE" >/dev/null) ||
  fail 'Repositorio GitHub inesperado.'
msg 'Criando credenciais NOVAS. Informe e-mail e senha do NOVO administrador.'
(cd "$STAGE" && CRIA_DOMAIN=ia.crjornada.com python3 scripts/cria-generate-env.py) ||
  fail 'Criacao das credenciais interrompida. Instalacao atual preservada.'
(cd "$STAGE" && docker compose config -q) ||
  fail 'Novo docker-compose invalido. Instalacao atual preservada.'
msg 'Gerando backup independente do banco, uploads e configuracao ANTES da limpeza.'
cp -a "$APP/.env" "$BACKUP/.env-antigo"
chmod 600 "$BACKUP/.env-antigo"
DBID=$(docker ps -q --filter label=com.docker.compose.project=cr-ia --filter label=com.docker.compose.service=db --filter status=running | head -n 1)
[[ -n "$DBID" ]] || fail 'PostgreSQL antigo nao esta rodando. Nenhuma exclusao feita.'
timeout 240 docker exec "$DBID" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BACKUP/postgres.dump" ||
  fail 'Falha no backup do banco. Nenhuma exclusao feita.'
[[ -s "$BACKUP/postgres.dump" ]] || fail 'Backup do banco vazio. Nenhuma exclusao feita.'
docker exec -i "$DBID" sh -c 'pg_restore -l >/dev/null' < "$BACKUP/postgres.dump" ||
  fail 'Backup invalido. Nenhuma exclusao feita.'
chmod 600 "$BACKUP/postgres.dump"
if docker volume inspect cr-ia_apidata >/dev/null 2>&1; then
  MP=$(docker volume inspect -f '{{.Mountpoint}}' cr-ia_apidata)
  [[ -d "$MP" ]] || fail 'Volume de uploads inacessivel. Nenhuma exclusao feita.'
  tar -czf "$BACKUP/uploads.tar.gz" -C "$MP" . ||
    fail 'Falha no backup dos uploads. Nenhuma exclusao feita.'
  tar -tzf "$BACKUP/uploads.tar.gz" >/dev/null ||
    fail 'Backup de uploads invalido. Nenhuma exclusao feita.'
  chmod 600 "$BACKUP/uploads.tar.gz"
fi
msg "BACKUPS VERIFICADOS em $BACKUP"
read -r -p 'Ultima confirmacao. Digite EXCLUIR DADOS CR IA para iniciar a limpeza: ' FINAL_ACK
[[ "$FINAL_ACK" == 'EXCLUIR DADOS CR IA' ]] || fail 'Cancelado antes da exclusao.'
msg 'Parando apenas os containers pertencentes ao projeto cr-ia.'
(cd "$APP" && docker compose --profile ollama --profile ai --profile search --profile updates down --remove-orphans) ||
  fail 'Nao foi possivel parar a CR IA. Volumes preservados.'
REMAIN=$(docker ps -aq --filter label=com.docker.compose.project=cr-ia)
[[ -z "$REMAIN" ]] || fail "Ainda ha containers CR IA ativos/parados: $REMAIN. Volumes preservados."
msg 'Removendo SOMENTE os cinco volumes nomeados da CR IA; backups continuam guardados.'
for v in "${VOLUMES[@]}"; do
  if docker volume inspect "$v" >/dev/null 2>&1; then
    docker volume rm "$v" || fail "Nao consegui remover volume $v. Backup: $BACKUP"
  fi
done
msg 'Arquivando a pasta antiga inteira (inclui .env antigo).'
mv "$APP" "$BACKUP/app-antigo" || fail 'Erro ao preservar app antigo.'
if ! mv "$STAGE" "$APP"; then
  mv "$BACKUP/app-antigo" "$APP" || true
  fail 'Nao foi possivel posicionar a nova instalacao.'
fi
cd "$APP"
msg 'Construindo API, site e worker a partir de codigo NOVO do GitHub.'
docker compose build --no-cache api web worker ||
  fail "Falha na compilacao. Backup preservado: $BACKUP"
docker compose up -d db api worker web ||
  fail "Falha no start dos servicos. Backup preservado: $BACKUP"
msg 'Criando novo banco e contas novas.'
bash scripts/migrate-seed.sh ||
  fail "Migração/seed falhou. Consulte logs; backup: $BACKUP"
msg 'Inicializando Ollama (modelo local sera baixado novamente).'
if docker compose --profile ollama up -d ollama; then
  if ! timeout 1800 docker compose exec -T ollama ollama pull qwen3:4b; then
    msg 'AVISO: Ollama ainda sem modelo. Depois rode: sudo docker compose exec -T ollama ollama pull qwen3:4b'
  fi
else
  msg 'AVISO: Ollama ainda nao iniciado. O site e a API podem funcionar com provedor externo.'
fi
msg 'Instalando comando menu com permissao correta.'
bash scripts/instalar-menu.sh ||
  fail "Falha ao instalar menu. O site pode estar funcionando. Backup: $BACKUP"
msg 'Verificando saude do site local sem mudar o Cloudflare Tunnel.'
OK=0
for i in $(seq 1 30); do
  if curl -fsS --max-time 4 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    OK=1; break
  fi
  sleep 5
done
[[ "$OK" == 1 ]] || fail "Servicos ainda nao saudaveis. Veja: docker compose logs --tail=80. Backup: $BACKUP"
msg 'INSTALACAO LIMPA CONCLUIDA.'
msg "GitHub: $(git rev-parse --short HEAD) | Backup anterior: $BACKUP"
msg 'Acesse https://ia.crjornada.com, entre com o NOVO Superadmin e configure APIs no painel.'
msg 'Para gerir a VPS: menu'
