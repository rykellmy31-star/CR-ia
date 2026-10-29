# CR IA — API (Node 20, produção)
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN npm ci --no-audit --no-fund

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN npm run build -w packages/shared && npm run build -w apps/api

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
COPY package.json ./
RUN mkdir -p /app/data/uploads /app/data/updates && chown -R node:node /app
# Não roda como root (volumes nomeados herdam o dono na 1ª criação;
# volumes antigos de root são corrigidos pelo instalador/atualizador).
USER node
EXPOSE 8787
CMD ["node", "apps/api/dist/server-node.js"]
