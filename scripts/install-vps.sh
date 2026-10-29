#!/usr/bin/env bash
# =====================================================================
# CR IA v0.1.1 — bootstrap de VPS Ubuntu 24.04/26.04 (OVHcloud / Contabo / Hostinger)
# Executa UMA vez como root na VPS nova. Idempotente (pode rodar de novo).
#
# O que faz:
#  1. Atualiza o sistema e instala Docker + Compose + Caddy + UFW
#  2. Configura firewall (SSH + HTTP/HTTPS) e swap de emergência
#  3. Cria usuário de deploy + pastas do projeto
#  4. Agenda backup automático diário (cron) com retenção de 14 dias
#
# Uso:
#   curl -fsSL https://seu-repo/cr-ia/scripts/install-vps.sh -o install-vps.sh
#   sudo bash install-vps.sh 2>&1 | tee install.log
# =====================================================================
set -euo pipefail

CR_USER="${CR_USER:-cria}"
CR_DIR="${CR_DIR:-/opt/cr-ia}"
DOMAIN="${DOMAIN:-}"   # ex.: DOMAIN=cr-ia.seudominio.com.br sudo -E bash install-vps.sh

log() { echo "[install-vps] $*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Rode como root: sudo bash install-vps.sh" >&2
  exit 1
fi

log "Atualizando sistema..."
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq

log "Instalando dependências base..."
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ca-certificates curl gnupg lsb-release git ufw fail2ban unattended-upgrades openssl

# ---- Docker ----
if ! command -v docker >/dev/null 2>&1; then
  log "Instalando Docker..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  # Codename com fallback: usa a release atual; se o repositório Docker ainda
  # não a suportar (ex.: Ubuntu muito novo), cai para a LTS anterior (noble/24.04).
  CODENAME="$(lsb_release -cs)"
  if ! curl -fsSL "https://download.docker.com/linux/ubuntu/dists/${CODENAME}/stable/binary-$(dpkg --print-architecture)/Packages" -o /dev/null 2>&1; then
    log "Repositório Docker sem suporte a '${CODENAME}' — usando 'noble' como fallback."
    CODENAME="noble"
  fi
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
else
  log "Docker já instalado: $(docker --version)"
fi

# ---- Caddy (HTTPS automático) ----
if ! command -v caddy >/dev/null 2>&1; then
  log "Instalando Caddy..."
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy
  systemctl enable caddy
else
  log "Caddy já instalado."
fi

# ---- Firewall: só SSH/HTTP/HTTPS do mundo; resto só local ----
log "Configurando UFW..."
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status numbered | head -20

# ---- Swap de emergência (4 GB) — evita OOM em picos ----
if [ ! -f /swapfile ]; then
  log "Criando swap de 4 GB..."
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  log "Swap já existe."
fi

# ---- Usuário de deploy ----
if ! id "$CR_USER" >/dev/null 2>&1; then
  log "Criando usuário $CR_USER..."
  adduser --disabled-password --gecos "CR IA deploy" "$CR_USER"
  usermod -aG docker "$CR_USER"
  mkdir -p "/home/$CR_USER/.ssh"
  [ -f /root/.ssh/authorized_keys ] && cp /root/.ssh/authorized_keys "/home/$CR_USER/.ssh/" || true
  chown -R "$CR_USER:$CR_USER" "/home/$CR_USER/.ssh" || true
fi

mkdir -p "$CR_DIR" "$CR_DIR/backups"
chown -R "$CR_USER:$CR_USER" "$CR_DIR"

# ---- Caddyfile (se DOMAIN informado) ----
if [ -n "$DOMAIN" ]; then
  log "Configurando Caddy para $DOMAIN..."
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:3000
}
EOF
  systemctl reload caddy
  log "HTTPS será emitido automaticamente quando o DNS apontar para esta VPS."
else
  log "DOMAIN não informado — configure o Caddy depois (ver docs/INSTALACAO.md §2.3)."
fi

# ---- Backup automático diário (cron, 2h da manhã) ----
log "Agendando backup automático..."
CRON_LINE="0 2 * * * $CR_USER cd $CR_DIR/app && ./scripts/backup.sh >> $CR_DIR/backup.log 2>&1"
if [ -f "$CR_DIR/app/scripts/backup.sh" ]; then
  echo "$CRON_LINE" > /etc/cron.d/cr-ia-backup
  chmod 644 /etc/cron.d/cr-ia-backup
  log "Cron instalado: /etc/cron.d/cr-ia-backup"
else
  log "Projeto ainda não clonado — o cron será instalado quando o app existir."
  log "Depois do clone, rode: echo '$CRON_LINE' | sudo tee /etc/cron.d/cr-ia-backup"
fi

# ---- Atualizações automáticas de segurança ----
systemctl enable --now unattended-upgrades 2>/dev/null || true

log "---------------------------------------------------------------"
log "VPS pronta! Próximos passos como $CR_USER:"
log "  1. Aponte o DNS (registro A) para o IP desta VPS"
log "  2. Extraia o ZIP da release em $CR_DIR/app e rode ./scripts/deploy-vps-pronta.sh --apply (sem Git)"
log "  3. cp .env.example .env && nano .env   (preencha os segredos!)"
log "  4. docker compose up -d --build && ./scripts/migrate-seed.sh"
log "Detalhes: docs/INSTALACAO.md"
