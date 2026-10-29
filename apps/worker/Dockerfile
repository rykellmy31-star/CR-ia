# CR IA — Worker de tarefas (Node 20, produção)
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
COPY apps/worker ./apps/worker
RUN npm run build -w packages/shared && npm run build -w apps/api && npm run build -w apps/worker

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
# O agente desenvolvedor executa git clone/commit/push no diretório isolado.
RUN apk add --no-cache git && mkdir -p /agentwork && chown node:node /agentwork
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/
COPY package.json ./
RUN chown -R node:node /app
# Agente/sandbox sem root; o socket Docker (se montado) segue restrito
# e documentado no compose (só com decisão explícita do dono).
USER node
CMD ["node", "apps/worker/dist/index.js"]
