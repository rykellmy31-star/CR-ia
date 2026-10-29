#!/usr/bin/env bash
# =====================================================================
# CR IA v0.2.0 — instalador para VPS que JÁ ESTÁ CONFIGURADA
# (OVHcloud Ubuntu 26.04 com Docker, UFW, Fail2ban e Cloudflare Tunnel)
#
# Instalação DIRETA do ZIP extraído — SEM Git, SEM repositório, SEM clone.
# Fluxo: extraia o ZIP da release numa pasta, rode este script de dentro dela.
#
# Este script NÃO modifica: SSH, UFW, Fail2ban, Docker, Cloudflare Tunnel,
# portas ou serviços do sistema. Ele apenas:
#   1. Verifica pré-requisitos (--check ou início do --apply)
#   2. Copia os arquivos para APP_DIR (preserva .env existente — nunca apaga segredos)
#   3. Cria o .env sem sobrescrever segredos (gera JWT/CREDENTIALS/senhas faltantes)
#   4. Sobe a stack (db+api+worker+web, tudo em 127.0.0.1 — sem porta pública)
#   5. Aplica schema + seed seguro
#   6. Testa saúde local (porta 3000, a do Tunnel) e imprime instruções
#
# Uso (dentro da pasta extraída do ZIP):
#   ./scripts/deploy-vps-pronta.sh --check                 # só diagnostica
#   ./scripts/deploy-vps-pronta.sh --apply                 # instala/atualiza
#   APP_DIR=/opt/cr-ia/app DOMAIN=ia.crjornada.com ./scripts/deploy-vps-pronta.sh --apply
#
# Testes (ver scripts/deploy-install.test.mjs):
#   CRIA_SOURCE_DIR=<pasta>  usa outra origem em vez da pasta do script
#   CRIA_SKIP_DOCKER=1       para após o .env (valida cópia+segredos sem Docker)
# =====================================================================
set -euo pipefail

MODE="${1:---check}"
APP_DIR="${APP_DIR:-/opt/cr-ia/app}"
DOMAIN="${DOMAIN:-ia.crjornada.com}"
SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${CRIA_SOURCE_DIR:-$SCRIPT_ROOT}"
WEB_PORT_DEFAULT=3000

pass=0; fail=0; warn=0
ok()   { pass=$((pass+1)); echo "  ✅ $*"; }
bad()  { fail=$((fail+1)); echo "  ❌ $*"; }
info() { echo "  ℹ️  $*"; }
note() { warn=$((warn+1)); echo "  ⚠️  $*"; }

run_checks() {
echo "--- [1/6] Pré-requisitos (somente leitura, nada é alterado) ---"

# Origem: precisa ser uma pasta extraída do ZIP (com .env.example), NÃO um git.
if [ -f "$SOURCE_DIR/.env.example" ] && [ -f "$SOURCE_DIR/docker-compose.yml" ]; then
  ok "Origem válida: $SOURCE_DIR (ZIP extraído)."
else
  bad "Origem inválida ($SOURCE_DIR): faltam .env.example e/ou docker-compose.yml. Extraia o ZIP da release e rode de dentro dele."
fi
if [ -d "$SOURCE_DIR/.git" ]; then
  note "Há um .git na origem — ele será IGNORADO (instalação é por arquivos, sem Git)."
fi

# Docker + Compose
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ok "Docker funcionando: $(docker --version | head -1)"
else
  bad "Docker ausente ou sem permissão (usuário precisa estar no grupo docker)."
fi
if docker compose version >/dev/null 2>&1; then
  ok "Docker Compose: $(docker compose version --short)"
else
  bad "Plugin docker compose ausente."
fi

# Ferramentas auxiliares
for t in openssl curl tar; do
  command -v "$t" >/dev/null 2>&1 && ok "$t disponível." || bad "$t ausente (necessário)."
done

# UFW / Fail2ban (só verifica — NUNCA altera)
if command -v ufw >/dev/null 2>&1; then
  if ufw status 2>/dev/null | grep -q "Status: active"; then ok "UFW ativo (não será tocado).";
  else note "UFW instalado mas inativo — avaliado como OK para este deploy (não alteramos)."; fi
else
  note "UFW não encontrado — OK (não instalamos nada)."
fi
if systemctl is-active --quiet fail2ban 2>/dev/null; then ok "Fail2ban ativo (não será tocado).";
else note "Fail2ban inativo/ausente — OK (não instalamos nada)."; fi

# Cloudflared (só verifica)
if command -v cloudflared >/dev/null 2>&1; then
  ok "cloudflared instalado: $(cloudflared --version 2>/dev/null | head -1)"
  if pgrep -x cloudflared >/dev/null 2>&1 || systemctl is-active --quiet cloudflared 2>/dev/null; then
    ok "Tunnel cloudflared em execução."
  else
    note "cloudflared instalado mas sem processo ativo — confira o serviço 'CRIA OVH'."
  fi
else
  bad "cloudflared NÃO encontrado — a rota $DOMAIN precisa dele. Instale conforme docs/TUNEL-CLOUDFLARE.md."
fi

# Portas da CR IA (3000 site · 8787 api-debug · 5432 pg · 11434 ollama · 8001 ai-local · 8888 searxng)
# NENHUMA pode estar pública — todas só em 127.0.0.1.
if command -v ss >/dev/null 2>&1; then
  for p in 3000 8787 5432 11434 8001 8888; do
    if ss -tln 2>/dev/null | grep -qE "[: ]$p[ ]" ; then
      if ss -tln 2>/dev/null | grep -E "[: ]$p[ ]" | grep -qv "127.0.0.1:$p"; then
        bad "Porta $p exposta além de 127.0.0.1! Feche antes de continuar."
      fi
    fi
  done
  ok "Nenhuma porta da CR IA exposta publicamente (verificado via ss)."
else
  note "Comando 'ss' ausente — pulando verificação de portas."
fi

# Recursos
MEM_GB=$(free -g 2>/dev/null | awk '/^Mem:/{print $2}' || true)
[ "${MEM_GB:-0}" -ge 10 ] && ok "RAM: ${MEM_GB} GB." || note "RAM detectada: ${MEM_GB:-?} GB (recomendado 12 GB)."
DISK_GB=$(df -BG "$APP_DIR" 2>/dev/null | awk 'NR==2{print $4}' | tr -dc '0-9' || true)
if [ -n "${DISK_GB:-}" ] && [ "$DISK_GB" -ge 10 ]; then ok "Disco livre: ${DISK_GB} GB."; else note "Disco livre: ${DISK_GB:-?} GB em $APP_DIR (recomendado 10+ GB)."; fi
}

echo "=== CR IA — deploy em VPS pronta ($MODE, sem Git) ==="
run_checks
echo "--- Resultado: $pass ok, $warn avisos, $fail falhas ---"
if [ "$fail" -gt 0 ]; then
  echo "Corrija as falhas acima e rode de novo. Nada foi alterado."
  exit 1
fi
if [ "$MODE" = "--check" ]; then
  echo "Modo --check: diagnóstico concluído, nada foi alterado."
  exit 0
fi
if [ "$MODE" != "--apply" ]; then
  echo "Uso: $0 --check | --apply"
  exit 1
fi

if [ -z "$APP_DIR" ] || [ "$APP_DIR" = "/" ]; then
  echo "ERRO: APP_DIR inválido ('$APP_DIR')." >&2
  exit 1
fi

echo "--- [2/6] Código: $SOURCE_DIR → $APP_DIR (preserva .env) ---"
if [ "$SOURCE_DIR" = "$APP_DIR" ]; then
  info "Origem já é o APP_DIR — nenhuma cópia necessária."
else
  mkdir -p "$APP_DIR"
  # tar exclui .env (segredos do destino NUNCA são sobrescritos) e .git (ignorado).
  tar -cf - --exclude=.env --exclude=.git -C "$SOURCE_DIR" . | tar -xf - -C "$APP_DIR"
  info "Arquivos copiados (excluídos: .env do destino preservado, .git ignorado)."
fi
cd "$APP_DIR"
# Scripts sempre executáveis (o ZIP já grava +x; isto cobre extrações manuais).
chmod +x scripts/*.sh 2>/dev/null || true
[ -x scripts/migrate-seed.sh ] || { echo "ERRO: scripts/*.sh sem permissão de execução."; exit 1; }

echo "--- [3/6] .env (gera faltantes, NUNCA mostra nem sobrescreve segredos) ---"
[ -f .env.example ] || { echo "ERRO: .env.example não encontrado em $APP_DIR."; exit 1; }
[ -f .env ] || { cp .env.example .env; info ".env criado a partir do exemplo."; }
fill_missing() { # fill_missing VAR "valor-gerado" — imprime só o NOME da var
  local var="$1" val="$2"
  if ! grep -qE "^${var}=.+" .env; then
    if grep -qE "^${var}=" .env; then
      sed -i "s|^${var}=.*|${var}=${val}|" .env
    else
      printf '%s=%s\n' "$var" "$val" >> .env
    fi
    info "$var definido automaticamente."
  fi
}
fill_missing NODE_ENV "production"
fill_missing JWT_SECRET "$(openssl rand -hex 32)"
fill_missing CREDENTIALS_SECRET "$(openssl rand -hex 32)"
fill_missing POSTGRES_PASSWORD "$(openssl rand -hex 24)"
fill_missing PUBLIC_API_URL "https://$DOMAIN/api"
fill_missing CORS_ORIGINS "https://$DOMAIN"
if grep -qE "^ADMIN_PASSWORD=Trocar123!" .env; then
  echo "ERRO: ADMIN_PASSWORD ainda é o padrão. Edite .env com senhas fortes e rode de novo."
  echo "  Gere: openssl rand -base64 18"
  exit 1
fi
if grep -qE "^GUEST_PASSWORD=Trocar123!" .env; then
  echo "ERRO: GUEST_PASSWORD ainda é o padrão. Edite .env com senhas fortes e rode de novo."
  echo "  Gere: openssl rand -base64 18"
  exit 1
fi
# UPDATER_QUEUE_SECRET (HMAC API↔updater): gera se ausente (instalação nova).
fill_missing UPDATER_QUEUE_SECRET "$(openssl rand -hex 32)"
ok ".env pronto (segredos existentes preservados; valores nunca impressos)."

if [ "${CRIA_SKIP_DOCKER:-0}" = "1" ]; then
  echo "CRIA_SKIP_DOCKER=1 (modo teste): parei após o .env. Cópia + segredos validados."
  exit 0
fi

echo "--- [4/6] Subindo stack (db+api+worker+web em 127.0.0.1) ---"
docker compose up -d --build
docker compose ps

echo "--- [5/6] Schema + contas ---"
./scripts/migrate-seed.sh

echo "--- [6/6] Saúde local (porta do Tunnel) ---"
WEB_PORT="$(grep -E '^WEB_PORT=[0-9]+' .env 2>/dev/null | tail -1 | cut -d= -f2)"
WEB_PORT="${WEB_PORT:-$WEB_PORT_DEFAULT}"
sleep 3
if curl -fsS "http://127.0.0.1:$WEB_PORT/api/health" | grep -q '"status":"ok"'; then
  ok "API respondendo via http://127.0.0.1:$WEB_PORT/api/health"
else
  bad "API não respondeu. Veja: docker compose logs api"
  exit 1
fi
if curl -fsS "http://127.0.0.1:$WEB_PORT/" | grep -q "<title>CR IA"; then
  ok "Site respondendo via http://127.0.0.1:$WEB_PORT/"
else
  bad "Site não respondeu. Veja: docker compose logs web"
  exit 1
fi

echo
echo "================================================================"
echo " ✅ Deploy concluído SEM tocar em SSH/UFW/Fail2ban/Tunnel/Docker."
echo
echo " Próximo passo (uma vez, no Cloudflare):"
echo "  A rota existente do Tunnel 'CRIA OVH' para $DOMAIN"
echo "  deve apontar para:  http://127.0.0.1:$WEB_PORT"
echo "  Detalhes: docs/TUNEL-CLOUDFLARE.md"
echo
echo " Depois, no navegador em https://$DOMAIN (via Cloudflare Access):"
echo "  1. Login admin -> Administração -> Modelos -> 🧪 Testar"
echo "  2. IA REAL (obrigatório p/ chat real): docker compose --profile ollama up -d && ./scripts/ollama-setup.sh  (ver docs/INSTALACAO.md §2.6)"
echo "  3. Voz/busca-docs: docker compose --profile ai up -d   (serviço ai-local)"
echo "  4. Backup: ./scripts/backup.sh (dumps p/ a árvore do Restic; ver docs/INSTALACAO.md §2.4)"
echo "================================================================"
