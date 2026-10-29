# CR IA — Web (build Vite + Nginx)
FROM node:20-alpine AS build
WORKDIR /app
# "" = mesma origem (Nginx proxia /api/*). Funciona no domínio e no celular.
# Informe URL absoluta SOMENTE se a API estiver em outro domínio.
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN npm run build -w packages/shared && npm run build -w apps/web

FROM nginx:alpine AS run
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
