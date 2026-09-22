# Build context: repository root (see docker-compose.yml)
FROM node:20-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/ui-kit/package.json packages/ui-kit/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm install --workspace @gsi/web --workspace @gsi/ui-kit --workspace @gsi/shared-types --include-workspace-root --no-audit --no-fund

COPY packages/shared-types packages/shared-types
COPY packages/ui-kit packages/ui-kit
COPY apps/web apps/web
RUN npm run build -w @gsi/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
