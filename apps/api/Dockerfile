# Build context: repository root (see docker-compose.yml)
FROM node:20-bookworm-slim

# Chromium for HTML→PDF (puppeteer-core) + fonts with full Turkish / Cyrillic coverage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-dejavu-core fonts-liberation2 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /repo

# Install workspace deps first for better layer caching.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/ui-kit/package.json packages/ui-kit/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm install --workspace @gsi/api --workspace @gsi/shared-types --workspace @gsi/ui-kit --include-workspace-root --no-audit --no-fund

COPY packages/shared-types packages/shared-types
COPY packages/ui-kit packages/ui-kit
COPY apps/api apps/api
# White-label (PHASE 13.5): config/clients/<profile>/brand.json, read by bootstrap-admin.mjs
# when it is bind-mounted in at deploy time (docs/DEPLOYMENT.md, docs/WHITE_LABEL.md).
COPY config config
RUN npm run build -w @gsi/shared-types -w @gsi/ui-kit -w @gsi/api

ENV NODE_ENV=production
WORKDIR /repo/apps/api
EXPOSE 3000
USER node
CMD ["node", "dist/main.js"]
