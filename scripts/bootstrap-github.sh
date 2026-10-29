#!/usr/bin/env bash
# CR IA - instalador para VPS Ubuntu NOVA, de repositório GitHub PÚBLICO ou PRIVADO.
# Em repositório privado pede token FINE-GRAINED (Contents: Read).
# NUNCA execute sobre uma VPS com a CR IA existente!
set -Eeuo pipefail
set +x
umask 077

say() { printf '\n[CR IA] %s\n' "$*"; }
fail() { echo "[CR IA] ERRO: $*" >&2; exit 1; }
if (( EUID != 0 )); then fail 'Execute com sudo: sudo bash bootstrap-github.sh'; fi
source /etc/os-release
[[ "${ID:-}" == 'ubuntu' ]] || fail 'Este instalador suporta apenas Ubuntu.'
case "${VERSION_ID:-}" in 22.04|24.04) ;; *) fail 'Ubuntu suportado: 22.04 ou 24.04 LTS. Não testado nesta versão.' ;; esac
[[ -t 0 ]] || fail 'Execute de forma interativa para proteger seu token e senha.'

APP_DIR='/opt/cr-ia/app'
[[ ! -e "$APP_DIR" ]] || fail "Já existe $APP_DIR. Instalação recusada para preservar dados."
if command -v docker >/dev/null 2>&1; then
  if docker volume ls --format '{{.Name}}' 2>/dev/null | grep -Eq '^cr-ia_(pgdata|apidata|ollama|agentwork)$'; then
    fail 'Volumes CR IA encontrados. Para atualizar use procedimento de atualização, não bootstrap.'
  fi
fi

if [[ -r /proc/meminfo ]]; then
  memkb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
  (( memkb >= 3500000 )) || fail 'VPS com menos de ~4 GB RAM. Recomendamos 8 GB ou mais.'
fi
free_gb=$(df -Pk /opt | awk 'NR==2 {printf "%d", $4/1024/1024}')
(( free_gb >= 15 )) || fail 'São necessários pelo menos 15 GiB livres para construir a aplicação.'

REPO="${CRIA_REPO:-rykellmy31-star/CR-IA}"
REF="${CRIA_REF:-main}"
DOMAIN="${CRIA_DOMAIN:-ia.crjornada.com}"
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail 'CRIA_REPO inválido (use dono/repositorio).'
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ && "$REF" != -* ]] || fail 'CRIA_REF inválido.'
[[ "$DOMAIN" =~ ^[a-zA-Z0-9.-]+$ && "$DOMAIN" == *.* ]] || fail 'CRIA_DOMAIN inválido.'

printf 'Repositório: %s (ref: %s)\nDomínio: %s\n' "$REPO" "$REF" "$DOMAIN"
read -r -p 'É uma VPS NOVA, sem dados da CR IA? Digite INSTALAR: ' ack
[[ "$ack" == 'INSTALAR' ]] || fail 'Cancelado sem alterações.'
SECRET_DIR=$(mktemp -d /tmp/cria-auth.XXXXXX)
chmod 700 "$SECRET_DIR"
cleanup() {
  if [[ -n "${SECRET_DIR:-}" && -d "$SECRET_DIR" ]]; then
    if [[ -f "$SECRET_DIR/token" ]]; then
      command -v shred >/dev/null 2>&1 && shred -u "$SECRET_DIR/token" 2>/dev/null || rm -f "$SECRET_DIR/token"
    fi
    rm -rf "$SECRET_DIR"
  fi
}
trap cleanup EXIT
cat > "$SECRET_DIR/askpass" <<'EOS'
#!/bin/sh
case "${1:-}" in
  *Username*) printf 'x-access-token\n' ;;
  *Password*) cat "$CRIA_TOKEN_FILE" ;;
  *) exit 1 ;;
esac
EOS
chmod 700 "$SECRET_DIR/askpass"

say 'Atualizando Ubuntu e instalando ferramentas básicas (nenhum reboot automático).'
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq ca-certificates curl gnupg git python3 openssl ufw fail2ban caddy rsync tar unzip

say 'Configurando Docker pelo repositório oficial.'
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$SECRET_DIR/docker.gpg.asc"
  gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg "$SECRET_DIR/docker.gpg.asc"
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

git config --global --add safe.directory "$APP_DIR" >/dev/null
say "Obtendo o projeto do GitHub: $REPO. O token não será armazenado no Git."
mkdir -p /opt/cr-ia
[[ ! -e "$APP_DIR" ]] || fail "Diretório $APP_DIR apareceu durante a instalação."
if GIT_TERMINAL_PROMPT=0 git -c credential.helper= clone --quiet --depth 1 --branch "$REF" \
  "https://github.com/$REPO.git" "$APP_DIR"; then
  say 'Repositório público acessado sem token GitHub.'
else
  [[ ! -e "$APP_DIR" ]] || fail 'Clone público não concluído e deixou arquivos parciais. Revisar antes de repetir.'
  say 'GitHub exige autenticação. Use um token com Contents: Read somente para o CR-IA.'
  read -r -s -p 'Token GitHub (não será armazenado): ' TOKEN
  printf '\n'
  [[ ${#TOKEN} -ge 20 ]] || fail 'Token ausente ou muito curto.'
  printf '%s' "$TOKEN" > "$SECRET_DIR/token"; unset TOKEN; chmod 600 "$SECRET_DIR/token"
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$SECRET_DIR/askpass" CRIA_TOKEN_FILE="$SECRET_DIR/token" \
    git -c credential.helper= clone --quiet --depth 1 --branch "$REF" \
    "https://github.com/$REPO.git" "$APP_DIR" \
    || fail 'Falha ao baixar repositório. Verifique nome e permissão Contents: Read.'
fi
chmod 700 /opt/cr-ia
cd "$APP_DIR"
[[ -f package-lock.json && -f docker-compose.yml && -f scripts/cria-generate-env.py ]] || fail 'Repositório incompleto: arquivos essenciais ausentes.'
cleanup
SECRET_DIR=''

say 'Preparando credenciais novas de banco, Superadmin e serviços.'
CRIA_DOMAIN="$DOMAIN" python3 scripts/cria-generate-env.py
chmod 600 .env

say 'Validando Docker Compose.'
docker compose config -q || fail 'Docker Compose inválido; instalação interrompida.'

say 'Compilando e iniciando API, Web, Worker e PostgreSQL.'
docker compose up -d --build db api worker web

say 'Aguardando API responder localmente.'
READY=0
for i in $(seq 1 48); do
  if curl -fsS --max-time 4 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then READY=1; break; fi
  sleep 5
done
(( READY == 1 )) || fail 'API não respondeu após instalação. Veja: docker compose logs --tail=100 api web'

say 'Aplicando migrações e criando Superadmin.'
bash scripts/migrate-seed.sh || fail 'Migração/seed falhou. Não publique antes de corrigir.'

say 'Ativando Ollama e modelo local (opcional, requer RAM).'
if (( memkb >= 8500000 )); then
  read -r -p 'Instalar Ollama e baixar qwen3:4b (~3 GB)? [S/n]: ' do_ollama
  if [[ ! "$do_ollama" =~ ^[nN]$ ]]; then
    docker compose --profile ollama up -d ollama
    bash scripts/ollama-setup.sh || say 'AVISO: Ollama não concluiu; site e API permanecem instalados. Verifique logs.'
  else
    say 'Ollama não instalado. Configure uma API externa no painel antes de usar chat real.'
  fi
else
  say 'RAM abaixo de ~8 GB; Ollama não instalado automaticamente. Configure provedor externo no painel.'
fi

say 'Protegendo SSH e habilitando HTTP/HTTPS (não altera autenticação SSH).'
SSH_PORT=$(sshd -T 2>/dev/null | awk '$1=="port" {print $2; exit}')
SSH_PORT=${SSH_PORT:-22}
ufw allow "${SSH_PORT}/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
systemctl enable --now fail2ban >/dev/null || true

say "Configurando HTTPS automático para $DOMAIN. O DNS deve apontar para esta VPS."
printf '%s {\n    encode zstd gzip\n    reverse_proxy 127.0.0.1:3000\n}\n' "$DOMAIN" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile >/dev/null
systemctl enable --now caddy
systemctl reload caddy

mkdir -p /opt/cr-ia/data/cr-ia-dumps
chmod 700 /opt/cr-ia/data /opt/cr-ia/data/cr-ia-dumps
cat > /etc/cron.d/cr-ia-backup <<'EOS'
# Executa como root, pois Docker não é exposto a usuários não privilegiados.
0 2 * * * root cd /opt/cr-ia/app && /usr/bin/flock -n /run/lock/cr-ia-backup.lock bash scripts/backup.sh >> /var/log/cr-ia-backup.log 2>&1
EOS
chmod 644 /etc/cron.d/cr-ia-backup

say 'Instalação concluída: confira a URL, o DNS e o certificado HTTPS.'
echo "Site: https://$DOMAIN"
echo 'Saúde local: curl -fsS http://127.0.0.1:3000/api/health'
echo 'Status: cd /opt/cr-ia/app && sudo docker compose ps'
echo 'Segredos: /opt/cr-ia/app/.env (NÃO enviar ao GitHub)'
say 'Ativando o menu de administração da CR IA.'
bash scripts/instalar-menu.sh || fail 'Falha ao instalar menu.'
echo 'Abra o menu pelo SSH: menu'
echo 'Atualização GitHub: menu > 2'
if [[ -e /var/run/reboot-required ]]; then echo 'Ubuntu solicita reinicialização (planeje, não reinicie sem avaliar).'; fi
