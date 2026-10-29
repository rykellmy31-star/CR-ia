#!/usr/bin/env bash
# CR IA — menu de operação da VPS. Não lê nem exibe credenciais.
set -Eeuo pipefail
set +x
umask 077
APP='/opt/cr-ia/app'
INST='/opt/cr-ia/installer'

if (( EUID != 0 )); then
  exec sudo "$0" "$@"
fi
if [[ ! -d "$APP" ]]; then
  echo '[CR IA] Sistema não encontrado em /opt/cr-ia/app.' >&2
  exit 1
fi

pause() { printf '\nPressione Enter para voltar ao menu...'; read -r _ || true; }
show_status() {
  echo '=== VERSÃO INSTALADA ==='
  if [[ -d "$APP/.git" ]]; then
    git -C "$APP" log -1 --format='%h %cs %s' 2>/dev/null || true
  else
    echo 'Sem vínculo GitHub. Não é seguro atualizar antes da migração.'
  fi
  echo '=== SERVIÇOS ==='
  (cd "$APP" && docker compose ps) || true
}

while true; do
  printf '\n══════════ CR IA — MENU VPS ══════════\n'
  printf ' 1) Ver status da CR IA\n'
  printf ' 2) Atualizar sistema de IA (GitHub + backup)\n'
  printf ' 3) Atualizar script/instalador (GitHub)\n'
  printf ' 4) Fazer backup agora\n'
  printf ' 5) Consultar logs\n'
  printf ' 6) Ver versão e GitHub\n'
  printf ' 0) Sair\n'
  printf '═══════════════════════════════════════\n'
  read -r -p 'Digite uma opção: ' option || exit 0
  case "$option" in
    1) show_status; pause ;;
    2)
      if [[ ! -d "$APP/.git" ]]; then
        echo 'ATUALIZAÇÃO BLOQUEADA: a instalação atual não foi vinculada ao GitHub.'
        echo 'Primeiro faça a migração controlada sem alterar .env nem volumes.'
      elif [[ ! -f "$INST/atualizar-github.sh" ]]; then
        echo 'Instalador GitHub não configurado nesta VPS.'
      else
        bash "$INST/atualizar-github.sh" || echo 'Atualização falhou. Verifique logs e backups.'
      fi
      pause ;;
    3)
      if [[ ! -d "$APP/.git" ]]; then
        echo 'ATUALIZAÇÃO BLOQUEADA: primeiro vincule esta instalação ao GitHub.'
      elif [[ -f "$INST/atualizar-instalador.sh" ]]; then
        bash "$INST/atualizar-instalador.sh" || echo 'Falha ao atualizar instalador.'
      else
        echo 'Atualizador de scripts não instalado.'
      fi
      pause ;;
    4) (cd "$APP" && bash scripts/backup.sh) || echo 'Backup falhou!'; pause ;;
    5) (cd "$APP" && docker compose logs --tail=80 api web worker) || true; pause ;;
    6)
      (cd "$APP" && printf 'Código: ' && git rev-parse --short HEAD 2>/dev/null) || true
      (cd "$APP" && printf 'Origem: ' && git remote get-url origin 2>/dev/null) || true
      echo 'Chaves de API: gerenciadas no painel, nunca no GitHub.'
      pause ;;
    0) exit 0 ;;
    *) echo 'Opção inválida.' ;;
  esac
done
