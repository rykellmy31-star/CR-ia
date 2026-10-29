#!/usr/bin/env bash
# Registra o comando global `menu` na VPS com CR IA já implantada.
# NÃO vincula a instalação existente ao GitHub automaticamente.
set -Eeuo pipefail
(( EUID == 0 )) || { echo 'Execute com sudo.' >&2; exit 1; }
APP=/opt/cr-ia/app
INST=/opt/cr-ia/installer
[[ -f "$APP/scripts/cria-menu.sh" && -f "$APP/scripts/atualizar-github.sh" && -f "$APP/scripts/atualizar-instalador.sh" ]] || {
 echo 'Arquivos do menu ausentes em /opt/cr-ia/app/scripts.' >&2; exit 1;
}
mkdir -p "$INST"
chmod 750 "$INST"
for script in cria-menu.sh atualizar-github.sh atualizar-instalador.sh; do
  bash -n "$APP/scripts/$script"
  install -m 750 "$APP/scripts/$script" "$INST/$script"
done
ln -sfn "$INST/cria-menu.sh" /usr/local/bin/menu
printf 'Menu instalado. No SSH, digite: menu\n'
if [[ ! -d "$APP/.git" ]]; then
  printf 'AVISO: atualização GitHub bloqueada até migração controlada da VPS existente.\n'
fi
