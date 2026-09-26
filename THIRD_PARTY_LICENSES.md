# Лицензии сторонних компонентов

Список того, что реально попадает в production-образы и стек GSI ONE, и под какой лицензией это распространяется. Составлено чтением `license` в `package.json` каждого пакета внутри собранных образов (`docker build --target build`) и `LICENSE`/образов для сервисов `docker-compose.prod.yml`. Это инвентаризация, а не юридическое заключение — компании перед релизом должен проверить список её юрист, особенно пункт про MinIO ниже.

Обновлять при каждом изменении `package.json` (любого workspace) или сервисов `docker-compose.prod.yml`.

---

## API (`apps/api`) — прямые зависимости выполнения

| Пакет | Версия | Лицензия |
|---|---|---|
| @aws-sdk/client-s3 | 3.1140.0 | Apache-2.0 |
| @aws-sdk/s3-request-presigner | 3.1140.0 | Apache-2.0 |
| archiver | 7.0.1 | MIT |
| bcryptjs | 2.4.3 | MIT |
| class-transformer | 0.5.1 | MIT |
| class-validator | 0.14.4 | MIT |
| exceljs | 4.4.0 | MIT |
| helmet | 7.2.0 | MIT |
| nodemailer | 6.10.1 | MIT-0 |
| pg | 8.23.0 | MIT |
| puppeteer-core | 23.11.1 | Apache-2.0 |
| qrcode | 1.5.4 | MIT |
| reflect-metadata | 0.2.2 | Apache-2.0 |
| rxjs | 7.8.2 | Apache-2.0 |
| sharp | 0.33.5 | Apache-2.0 |
| @nestjs/common, @nestjs/core, @nestjs/jwt, @nestjs/platform-express, @nestjs/schedule, @nestjs/throttler | 10.x / 4.x / 6.x | MIT |

`sharp` статически линкует `libvips` (LGPL-3.0 + частично Apache-2.0 компоненты) — сама LGPL допускает динамическую линковку в проприетарном ПО; `sharp`'s prebuilt-бинарники распространяют это соответствующим образом (см. `node_modules/sharp/LICENSE`).

`puppeteer-core` сам по себе не скачивает Chromium (`PUPPETEER_SKIP_DOWNLOAD=true` в `apps/api/Dockerfile`) — вместо этого используется системный пакет `chromium` из Debian (bookworm), лицензия которого — смесь BSD-3-Clause, LGPL-2.1 и MPL-2.0 в зависимости от компонента; `apt-get install chromium` соответствует условиям Debian-пакета, отдельного согласия не требует.

## Web (`apps/web`) — попадает в собранный бандл

| Пакет | Версия | Лицензия |
|---|---|---|
| react, react-dom | 18.3.1 | MIT |
| react-router-dom | 6.30.6 | MIT |
| @tanstack/react-query | 5.103.2 | MIT |
| i18next | 23.16.8 | MIT |
| react-i18next | 15.7.4 | MIT |

Все шесть — MIT; в собранный бандл (`apps/web/dist`) уходит только сам код, без обязательства публиковать что-либо ещё, кроме уведомления об авторских правах внутри самого бандла (сохраняется сборщиком).

## Базовые образы и сервисы (`docker-compose.prod.yml`, `Dockerfile`)

| Компонент | Лицензия | Примечание |
|---|---|---|
| `node:20-bookworm-slim` | Node.js — MIT; Debian-пакеты — смесь | Только среда выполнения, в продукт не встраивается |
| `nginx:1.27-alpine` | BSD-2-Clause (nginx), Alpine — MIT/BSD | Отдаёт статику `apps/web/dist` |
| `postgres:16-alpine` | PostgreSQL License (permissive, похожа на MIT/BSD) | СУБД, отдельный процесс — не связывается с кодом API |
| `caddy:2-alpine` | Apache-2.0 | Reverse proxy, отдельный процесс |
| `quay.io/minio/minio` | **GNU AGPLv3** | См. ниже — требует отдельного решения, не просто инвентаризации |

### MinIO — требует решения, не просто списка

MinIO Server с апреля 2021 распространяется по **GNU AGPLv3**, а не Apache-2.0 (клиентские SDK вроде `@aws-sdk/client-s3` — Apache-2.0, это не относится к самому серверу MinIO). AGPLv3 — copyleft-лицензия с сетевым условием: **если MinIO модифицируется и результат предоставляется пользователям по сети**, изменённый исходный код обязаны раскрыть. GSI ONE использует MinIO как есть, без форка и без изменений кода MinIO — это снижает риск, но:

- решение развернуть MinIO как часть production-стека (а не использовать управляемого провайдера S3) — юридическое решение компании, не техническое;
- `docker-compose.prod.yml` документирует альтернативу: указать `S3_ENDPOINT`/`S3_PUBLIC_ENDPOINT` на управляемое хранилище (AWS S3, Backblaze B2 и т. п.) и убрать сервис `minio` целиком — тогда AGPLv3 вопрос снимается полностью.

**Перед первым production-релизом с самостоятельно размещённым MinIO этот пункт должен подтвердить юрист GSI**, а не разработчик.

---

## Как список обновлялся

```bash
# API: версии и лицензии из собранного образа
docker build -t gsi-erp-api -f apps/api/Dockerfile .
docker run --rm gsi-erp-api node -e "
  const pkg = require('/repo/apps/api/package.json');
  for (const d of Object.keys(pkg.dependencies)) {
    const p = require(d + '/package.json');
    console.log(d, p.version, p.license);
  }"

# Web: та же идея, но из промежуточного этапа сборки (dependencies не попадают в финальный образ)
docker build --target build -f apps/web/Dockerfile -t gsi-erp-web-build .
docker run --rm gsi-erp-web-build node -e "... то же самое для apps/web/package.json"
```

Ничего из перечисленного не проверялось на патентные условия или судебные споры вокруг конкретных версий — только текст поля `license` пакета и то, копилефт это или нет.
