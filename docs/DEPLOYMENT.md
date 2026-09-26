# DEPLOYMENT — развёртывание GSI ONE в production

Пошаговый ввод в эксплуатацию: с чистого сервера до работающего, защищённого HTTPS стенда с первым администратором. Резервное копирование — отдельно в [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md), повседневная эксплуатация — в [`OPERATIONS.md`](OPERATIONS.md), модель угроз и то, что уже защищено — в [`SECURITY.md`](SECURITY.md).

---

## 1. Архитектура production-стека

```
                     ┌─────────────┐
   Интернет ── 80/443 ─►   Caddy   │  TLS-терминация, HTTP→HTTPS редирект,
                     └──────┬──────┘  автоматический сертификат (Let's Encrypt)
                            │
                     ┌──────▼──────┐
                     │     web     │  nginx, статика apps/web/dist,
                     │  (nginx)    │  проксирует /api/* → api:3000
                     └──────┬──────┘
                            │
                     ┌──────▼──────┐      ┌─────────────┐
                     │     api     │──────►     db       │  PostgreSQL 16,
                     │  (NestJS)   │      │ (postgres)  │  порт не публикуется
                     └──────┬──────┘      └─────────────┘
                            │
                     ┌──────▼──────┐
                     │    minio    │  S3-совместимое хранилище (опционально —
                     │  (опция)    │  можно заменить на управляемый S3),
                     └─────────────┘  порт не публикуется, доступ через Caddy
                                       только если MinIO выбран и его нужно
                                       отдавать presigned URL наружу
```

`docker-compose.prod.yml` — единственный источник правды по составу стека; `Caddyfile` — по правилам проксирования. Ни один сервис, кроме `caddy`, не публикует порт на хост.

## 2. Предварительные условия

- Домен (`app.example.com`), A/AAAA-запись указывает на IP сервера, порты 80 и 443 открыты в фаерволе — Caddy получает сертификат через ACME HTTP-01, для чего нужен именно 80-й порт снаружи.
- Docker Engine + Docker Compose v2 на сервере.
- Если MinIO размещается самостоятельно и presigned URL должны быть публично доступны — второй домен (`storage.example.com`) с той же настройкой DNS; иначе — управляемый S3-провайдер и `S3_ENDPOINT`, указывающий на него (см. `.env.production.example`).
- Секреты сгенерированы заранее (раздел 4) и нигде не закоммичены.

## 3. Первый запуск

```bash
git clone <репозиторий> gsi-erp && cd gsi-erp
cp .env.production.example .env.production
# заполнить все значения в .env.production — секцию 4 читать перед этим шагом
chmod 600 .env.production

docker compose -f docker-compose.prod.yml --env-file .env.production config   # проверка: падает на первой незаполненной переменной
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
```

`MIGRATE_ON_START=true` (задано в `docker-compose.prod.yml`) применяет миграции при каждом старте `api` — они аддитивны и идемпотентны (`AI_EXECUTION_RULES.md` #5), повторный прогон ничего не ломает. `SEED_ON_START`/`SEED_DEMO` по умолчанию выключены — в production демо-данные не создаются никогда, `seed()` (`apps/api/src/db/seed.ts`) сам отказывается сеять демо-данные при `NODE_ENV=production`, если явно не передан `SEED_DEMO=true`.

Проверить:

```bash
curl https://app.example.com/api/health/ready
```

## 4. Секреты и переменные окружения

`.env.production` — единственное место с реальными секретами, и оно **не коммитится** (`.gitignore`). `.env.production.example` — шаблон с описанием каждой переменной; ниже — как сгенерировать значения:

| Переменная | Как сгенерировать |
|---|---|
| `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | `openssl rand -base64 24` |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | `openssl rand -hex 48` |

**Fail-fast:** `apps/api/src/config.ts#assertProductionSafe()` при `NODE_ENV=production` (задан в образе, `apps/api/Dockerfile`) проверяет, что ни один из этих секретов не остался равен своему dev-значению (`gsi_app`, `minioadmin`, ...), что `PUBLIC_WEB_URL` начинается с `https://`, и что `CORS_ORIGINS` не содержит `localhost`. Контейнер `api` отказывается стартовать и печатает точный список нарушений, если что-то из этого не выполнено — это проверено (см. `docs/CHANGELOG.md`, PHASE 13): попытка поднять `docker-compose.prod.yml` без заполненного `.env.production` завершается этим же логом, а не тихим стартом с небезопасными значениями.

**Ротация.** JWT-секреты: смена обоих значений в `.env.production` и `docker compose ... up -d api` инвалидирует все текущие access- и refresh-токены разом — это ожидаемо, все пользователи re-login. Пароль БД: сменить у роли в PostgreSQL (`ALTER ROLE gsi_app WITH PASSWORD '...'`) и `APP_DB_PASSWORD` в `.env.production` одновременно, затем пересоздать `api`; `POSTGRES_PASSWORD` — то же для владельца схемы. S3-ключи: обновить у провайдера (или `MINIO_ROOT_PASSWORD` у самостоятельно размещённого MinIO) и в `.env.production`. Ни один секрет не хранится нигде, кроме `.env.production` на сервере — если нужен внешний секрет-менеджер (Vault, SOPS, облачный Secrets Manager), он должен рендерить этот файл перед `docker compose up`, а не заменять его: сама конфигурация (`docker-compose.prod.yml`) читает только переменные окружения и ничего не знает о менеджере секретов.

**Разделение dev / staging / production**: три независимых `.env`-файла (`.env.example`, `.env.staging.example`, `.env.production.example`) и два compose-файла (`docker-compose.yml` для разработки, `docker-compose.prod.yml` для staging и production — staging использует его же с другим `.env`, см. `.env.staging.example`). Секреты никогда не переиспользуются между окружениями — утечка staging-секрета не должна быть production-инцидентом.

## 5. HTTPS, домен, reverse proxy

Caddy (`Caddyfile`) — единственный сервис с портами наружу. Автоматический HTTPS и HTTP→HTTPS редирект — поведение Caddy по умолчанию для любого блока с реальным доменом, в конфиге ничего для этого не пишется отдельно. `ACME_EMAIL` — обязателен: на него приходят уведомления о продлении/проблемах сертификата.

- `PUBLIC_WEB_URL` — должен совпадать со схемой и доменом Caddy (`https://app.example.com`) — используется в QR-коде верификации отчётов и в проверке `assertProductionSafe`.
- `CORS_ORIGINS` в `docker-compose.prod.yml` берёт значение `PUBLIC_WEB_URL` — веб и API живут под одним доменом (через прокси nginx `apps/web/nginx.conf`), отдельного CORS-исключения для API-домена не требуется.
- Cookie `gsi_rt` (refresh-токен): `apps/api/src/auth/refresh-cookie.ts` ставит `Secure: config.isProduction`, `SameSite: 'lax'`. Под HTTPS и одним доменом это ровно то, что нужно — cookie не уходит ни на один сторонний домен и недоступна по HTTP.
- MinIO console (порт 9001) нигде не публикуется — ни на хост, ни через Caddy. S3 API (9000) публикуется через Caddy только если `STORAGE_DOMAIN` заполнен и блок в `Caddyfile` оставлен; если используется управляемый S3-провайдер — оба (сервис `minio` и блок `STORAGE_DOMAIN` в `Caddyfile`) следует удалить.

## 6. Первый администратор

Production не сеется demo-данными — после первого запуска в базе есть только пустая организация (миграция 007). Открытие офиса не имеет отдельного REST-эндпоинта (тот же пробел документирует `apps/api/test/rbac.spec.ts`), поэтому первую страну/офис/администратора создаёт `scripts/bootstrap-admin.mjs` — один раз, вручную:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production \
  run --rm -v "$(pwd)/scripts/bootstrap-admin.mjs:/repo/apps/api/bootstrap-admin.mjs:ro" \
  --entrypoint node api bootstrap-admin.mjs
```

с переменными окружения `COUNTRY_CODE`, `COUNTRY_NAME`, `BRANCH_CODE`, `BRANCH_CITY`, `BRANCH_CURRENCY`, `BRANCH_LOCALE`, `BRANCH_TIMEZONE`, `BRANCH_LEGAL_NAME`, `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` (передать через `-e` к тому же `run`; см. заголовок самого скрипта — там пример целиком). Скрипт идемпотентен: повторный запуск с теми же кодами ничего не портит. Проверено на реальной цепочке миграция → bootstrap → логин (PHASE 13, `docs/CHANGELOG.md`) — выданный JWT содержит полный набор прав администратора.

Тот же запуск (миграция 007 + `bootstrap-admin.mjs`) — то, что превращает пустую организацию в брендированную (PHASE 13.5, `docs/WHITE_LABEL.md`): миграция 027 добавляет колонки бренда в `organizations`, а `bootstrap-admin.mjs` заполняет их — либо из `ORG_SHORT_NAME`/`ORG_PRODUCT_NAME`/`ORG_PRIMARY_COLOR`/`ORG_SECONDARY_COLOR`/`ORG_LOGO_URL`/`ORG_LOGO_LIGHT_URL`/`ORG_SUPPORT_EMAIL`/`ORG_SUPPORT_PHONE`, либо из `CLIENT_PROFILE=<name>` (читает `config/clients/<name>/brand.json`, уже собранный в образ `api`). Для профиля, которого ещё нет в репозитории на момент сборки образа, добавить `-v "$(pwd)/config/clients/<name>:/repo/config/clients/<name>:ro"` к той же команде.

После первого входа: сменить пароль (профиль), дальше — всё через обычный API/интерфейс (`POST /api/org/countries`, `POST /api/users`, `PUT /api/admin/users/:id/roles`, экран «Роли и права»).

## 7. CI

`.github/workflows/ci.yml` — install, unit+integration, lint, typecheck, сборка API и web, отдельная проверка миграций (применяются к пустой базе, повторный прогон — no-op), сборка обоих Docker-образов и `verify-full.sh` (стенд, health, 90 smoke-проверок). Автоматического деплоя в production нет и не планируется в этом пайплайне — деплой описан в разделе 3 этого документа и требует отдельного целевого сервера и доступа к нему, которых у CI нет.

## 8. Мониторинг и операции

См. [`OPERATIONS.md`](OPERATIONS.md) — health-пробы, структурированные логи, что смотреть при инциденте, дисковые/ёмкостные проверки.

## 9. Резервное копирование

См. [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) — обязательно к настройке до того, как в системе появятся первые реальные данные.

## 10. Известные ограничения (честно, не задним числом)

- **MinIO и AGPLv3.** См. `THIRD_PARTY_LICENSES.md` — самостоятельное размещение MinIO в production требует решения юриста компании, не разработчика.

Два пробела, найденные приёмочным прогоном PHASE 13, закрыты отдельной правкой сразу после: межофисная лабораторная приёмка (`receive`/`accept` из другого офиса отвечали `404 Sample not found` из-за `JOIN` в `samples.service.ts`, не наследовавшего RLS-исключение `app_sees_laboratory`) и отсутствие аудита `invoice.create`/`issue`/`pay`. Подробности исправления — `docs/SECURITY.md`, тесты — `apps/api/test/cross-office-lab-rls.spec.ts` и `apps/api/test/invoice-audit.spec.ts`.
