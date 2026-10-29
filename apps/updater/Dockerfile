# CR IA — Updater (serviço separado de aplicação de updates).
# Único com socket Docker (restrito a ele; NUNCA na API pública).
# Sem portas: age só pela fila em /app/data/updates/queue.
# Roda como root porque precisa aplicar arquivos na árvore do host (dono cria)
# e falar com o socket; o compose remove todo o resto (cap_drop ALL,
# no-new-privileges, FS raiz só-leitura) e o serviço só executa comandos
# FIXOS (rsync/docker/migrate/health) sobre pedidos com HMAC válido.
FROM node:22-alpine
RUN apk add --no-cache docker-cli docker-cli-compose rsync bash
WORKDIR /app
CMD ["node", "apps/updater/updater-service.mjs"]
