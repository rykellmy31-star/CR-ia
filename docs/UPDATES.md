# CR IA — Central de Atualizações

Atualização assistida pela interface (Administração → 🔄 Atualizações), com
verificação criptográfica **antes** de aplicar qualquer coisa.

## Fluxo (sempre nesta ordem)

1. **Verificar** — a API busca o manifesto JSON (`UPDATES_MANIFEST_URL`) e
   compara com a versão instalada. O worker repete a verificação a cada ~1h
   (só verifica e registra no log; **nunca** baixa nem aplica).
2. **Baixar e conferir** — baixa o ZIP, confere `sha256` e a assinatura
   **minisign** com `UPDATE_SIGNING_PUBLIC_KEY`. Qualquer divergência =
   arquivo **recusado e apagado**. Se OK, extrai para staging e grava um
   recibo (`.cr-ia-receipt.json`).
3. **Aplicar (humano confirma)** — enfileira pedido assinado para o serviço `updater` (v2; o modo antigo `update.sh --zip <staging>` continua disponível via terminal),
   que faz **backup completo antes**, copia os arquivos preservando
   `.env*`, `data/`, `backups/`, `.git/`, `node_modules/`, reconstrói os
   containers e roda migrations.

Sem `UPDATES_MANIFEST_URL`, a Central mostra "não configurado" e nada acontece.
Sem `UPDATE_SIGNING_PUBLIC_KEY`, o download é recusado.

## Formato do manifesto

```json
{
  "version": "0.2.1",
  "notes": "Correções de segurança. Reinício breve dos containers.",
  "zipUrl": "https://exemplo.com/releases/cr-ia-v0.2.1.zip",
  "sha256": "<sha256 hex do ZIP>",
  "signature": "untrusted comment: ...\n<base64 assinatura>\ntrusted comment: ...\n<base64 assinatura global>"
}
```

## Publicando uma versão (maintainer)

As releases são assinadas com a **CLI oficial do Minisign** (`sudo apt-get install minisign`).
A API verifica as duas assinaturas (conteúdo e comentário confiável) com
`node:crypto`, sem precisar instalar o Minisign no contêiner de API.

A antiga implementação gerava `.minisig` INCOMPLETO de 2 linhas e chaves
secretas em um formato próprio: **essas chaves antigas não devem ser usadas**.
O novo formato exige quatro linhas e usa chave privada criptografada criada
pelo Minisign oficial.

```bash
# Gerar um par no ambiente sob seu controle. A privada NUNCA vai no ZIP.
node scripts/sign-release.mjs genkey --name cr-ia-release --out "$HOME/seguro"

# Criar ZIP (com make-release-zip.mjs)
node scripts/make-release-zip.mjs --out /tmp/cr-ia-v0.3.1-corrigida.zip

# Assinar ZIP com a chave que você guarda, digitando a senha localmente:
node scripts/sign-release.mjs sign --key "$HOME/seguro/cr-ia-release.key" \
  --file /tmp/cr-ia-v0.3.1-corrigida.zip

# Verificar com Minisign oficial:
node scripts/sign-release.mjs verify --pub "$HOME/seguro/cr-ia-release.pub" \
  --file /tmp/cr-ia-v0.3.1-corrigida.zip \
  --sig /tmp/cr-ia-v0.3.1-corrigida.zip.minisig
```

**Nunca copie a chave privada para a API, GitHub ou pasta de atualização.**
Quando gerar a chave na VPS por conveniência, faça uma cópia offline protegida
sob seu controle e remova a chave privada da VPS após a assinatura.

## Configurando a chave pública na VPS (uma vez)

No `.env` do servidor vai **só a 2ª linha** do `.pub` (base64 em linha
única — o verificador aceita exatamente isso):

```bash
# No .env (com a stack parada ou antes do primeiro up):
UPDATE_SIGNING_PUBLIC_KEY=<cole aqui a 2ª linha do cr-ia-release.pub>
# Exemplo de formato (NÃO use este valor — é só o formato):
# UPDATE_SIGNING_PUBLIC_KEY=RWSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
```

Depois de editar o `.env`: `docker compose up -d` (a API lê no boot).
Sem essa variável, **todo** upload é RECUSADO (“sem verificação de
origem”) — e a chave secreta (`.key`) nunca entra no servidor.

> Este ZIP corrigido **não vem pré-assinado**. A chave pública e a assinatura
> devem ser criadas com um par de chaves sob controle do dono. Não reutilize
> a chave pública v0.3.1 antiga cuja privada foi destruída.

## Atualização por upload (v2 — fluxo atual)

Na aba 🔄 Atualizações, o admin envia o ZIP + assinatura minisign:

1. **Upload** — valida tamanho/formato, barra ZIP-slip/symlinks/arquivos
   perigosos e exige assinatura minisign válida (`UPDATE_SIGNING_PUBLIC_KEY`).
   Sem assinatura = recusado.
2. **Staging + checks** — extração isolada, recibo (`.cr-ia-receipt.json`) e
   verificações estáticas (`.cr-ia-checks.json`); testes no staging opt-in
   (`UPDATE_RUN_TESTS=true`).
3. **Aprovação humana** — a API calcula o SHA256 da árvore do staging e
   enfileira um pedido **assinado com HMAC** (`UPDATER_QUEUE_SECRET`, mín.
   16 chars) em `<UPDATES_DIR>/queue/`. Sem o segredo, aprovar retorna erro
   e nada é enfileirado.
4. **Aplicação (serviço `updater`)** — DESATIVADO por padrão na homologação
   (sobe só com `docker compose --profile updates up -d`; sem ele, aprovações
   só acumulam na fila e o chat segue normal). O painel mostra o sinal de
   vida do aplicador (🟢 ativo / 🟡 parado + comando para ligar) — v0.3.0. Container separado, único com o socket
   Docker, sem portas, `cap_drop: ALL`, `no-new-privileges`, FS raiz
   só-leitura. Antes de qualquer docker/backup/cópia ele revalida: HMAC,
   confinamento do `stagedDir`, hash da árvore (anti troca pós-aprovação) e
   ausência de symlinks. Depois: backup → snapshot → rsync → rebuild →
   migrate → healthchecks → histórico. Falha = rollback automático dos
   arquivos; se o rollback falhar, grava `ALERT-*.txt` e pede intervenção.
5. **Interrupção** — se o serviço morrer no meio do apply, o pedido continua
   na fila com um marcador assinado; a próxima execução **restaura o snapshot
   da tentativa antes de tentar de novo** (retry idempotente).
6. **Rollback** — pedido assinado (`kind: rollback`) restaura uma release
   anterior (snapshot pré-rollback de segurança); migração de banco marcada
   `irreversibleDb` gera aviso de revisão manual.

A API pública **nunca** aplica arquivos e **nunca** tem o socket Docker.
O updater só executa comandos fixos (rsync/docker/migrate/health) — nenhum
byte do ZIP enviado é executado como código pelo serviço.

## Auditoria e rollback

- Cada verificação/preparação/aplicação é registrada em
  `<UPDATES_DIR>/history.jsonl` + trilha de auditoria do admin.
- Rollback de arquivos = aba Atualizações → reversão (fila assinada).
- Rollback de banco = `./scripts/restore.sh <STAMP>` (ver INSTALACAO §2.4),
  depois `docker compose up -d --build`.
