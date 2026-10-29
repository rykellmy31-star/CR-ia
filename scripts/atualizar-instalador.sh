#!/usr/bin/env bash
# Atualiza SOMENTE menu e scripts de instalação, sem atualizar API/site.
set -Eeuo pipefail
set +x
umask 077
say(){ printf '[CR IA MENU] %s\n' "$*"; }
fail(){ say "ERRO: $*" >&2; exit 1; }
(( EUID == 0 )) || fail 'Use sudo.'
[[ -t 0 ]] || fail 'Use terminal interativo.'
APP=/opt/cr-ia/app
INST=/opt/cr-ia/installer
BRANCH=${CRIA_REF:-main}
[[ "$BRANCH" =~ ^[a-zA-Z0-9._/-]+$ && "$BRANCH" != -* ]] || fail 'Branch inválida.'
[[ -d "$APP/.git" ]] || fail 'Esta VPS não tem repositório GitHub vinculado.'
[[ -d "$INST" ]] || fail 'Instalador não encontrado.'
TMP=$(mktemp -d /tmp/cria-menu-update.XXXXXXXX)
chmod 700 "$TMP"
cleanup(){
  if [[ -d "${TMP:-}" ]]; then
    [[ ! -e "$TMP/token" ]] || { shred -u "$TMP/token" 2>/dev/null || rm -f "$TMP/token"; }
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
fetch_public(){
 GIT_TERMINAL_PROMPT=0 git -C "$APP" -c credential.helper= fetch --quiet --depth=1 origin "$BRANCH"
}
if ! fetch_public; then
 say 'Repositório não acessível sem autenticação. Se virou privado, use token GitHub Contents: Read.'
 read -r -s -p 'Token GitHub (não será salvo): ' GH_TOKEN
 printf '\n'
 [[ ${#GH_TOKEN} -ge 20 ]] || fail 'Token inválido.'
 printf '%s' "$GH_TOKEN" > "$TMP/token"; unset GH_TOKEN; chmod 600 "$TMP/token"
 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$TMP/askpass" CRIA_TOKEN_FILE="$TMP/token" \
  git -C "$APP" -c credential.helper= fetch --quiet --depth=1 origin "$BRANCH" || fail 'Não foi possível consultar GitHub.'
fi
NEW=$(git -C "$APP" rev-parse FETCH_HEAD)
FILES=(cria-menu.sh atualizar-github.sh atualizar-instalador.sh)
for f in "${FILES[@]}"; do
 git -C "$APP" show "$NEW:scripts/$f" > "$TMP/$f" || fail "Arquivo não encontrado no GitHub: $f"
 bash -n "$TMP/$f" || fail "Falha na sintaxe de: $f"
done
say "Commit remoto: ${NEW:0:12}"
say 'Scripts validados. Não serão alterados nem código nem contêineres da CR IA.'
read -r -p 'Atualizar scripts do menu? Digite ATUALIZAR: ' ans
[[ "$ans" == 'ATUALIZAR' ]] || { say 'Cancelado.'; exit 0; }
BACKUP="$INST/anteriores/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP"
chmod 700 "$BACKUP"
for f in "${FILES[@]}"; do
 [[ ! -f "$INST/$f" ]] || cp -a "$INST/$f" "$BACKUP/$f"
 install -m 750 "$TMP/$f" "$INST/$f"
done
ln -sfn "$INST/cria-menu.sh" /usr/local/bin/menu
say "Instalador atualizado. Backup anterior: $BACKUP"
