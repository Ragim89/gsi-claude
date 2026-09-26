# OPERATIONS — повседневная эксплуатация

Health-пробы, логи, что смотреть при инциденте, ёмкость диска и базы. Намеренно без тяжёлого стека мониторинга (Prometheus/Grafana/ELK) — для одного стенда на `docker compose` это оверинжиниринг; здесь — чистые hooks и команды, которые уже работают из коробки, плюс куда именно воткнуть внешний мониторинг, когда он понадобится.

---

## 1. Health и readiness

Три эндпоинта (`apps/api/src/health/health.controller.ts`), потому что оркестратору нужно три разных ответа:

| Эндпоинт | Отвечает на вопрос | Что проверяет |
|---|---|---|
| `GET /api/health/live` | Процесс жив? | Ничего внешнего — не убивает контейнер из-за упавшей БД |
| `GET /api/health/ready` | Может принимать трафик? | PostgreSQL (`SELECT 1`), объектное хранилище (`HeadBucket`) |
| `GET /api/health` | Человекочитаемая сводка | То же самое, плюс `env`, `uptimeSeconds` |

`docker-compose.prod.yml` использует `/api/health/ready` как `healthcheck` контейнера `api` — `docker ps` сразу показывает `unhealthy`, если БД или хранилище недоступны, а не только когда сам процесс упал.

```bash
curl -s https://app.example.com/api/health | jq
docker compose -f docker-compose.prod.yml ps   # STATUS показывает healthy/unhealthy по этому же health-check
```

## 2. Структурированные логи

`LOG_JSON=true` в production (`docker-compose.prod.yml`) — каждая строка лога API одним JSON-объектом, с `requestId`, связывающим ответ клиенту с записью в логе (единый формат ошибок, PHASE 0). В development — читаемый человеком формат (`docker-compose.yml` теперь явно ставит `NODE_ENV: development`, что и переключает формат — до PHASE 13 это переключение зависело от того, что Dockerfile прописывает `NODE_ENV=production` по умолчанию, и dev-стенд молча работал в «production»-режиме логов и cookie).

```bash
docker compose -f docker-compose.prod.yml logs -f api                     # поток
docker compose -f docker-compose.prod.yml logs api | jq -r 'select(.level=="error")'   # только ошибки, если jq доступен
docker compose -f docker-compose.prod.yml logs --since 1h api             # за последний час
```

Логи живут в самом Docker (`json-file` драйвер по умолчанию) — ротацию настраивать на уровне демона (`/etc/docker/daemon.json`, `log-opts.max-size`/`max-file`), иначе диск сервера постепенно съедается логами долгоживущего контейнера.

## 3. Контейнеры: restart policy и мониторинг падений

Каждый сервис в `docker-compose.prod.yml` — `restart: unless-stopped`: падение процесса (не намеренная остановка) перезапускает его автоматически. Мониторить сами перезапуски:

```bash
docker inspect --format '{{.Name}}: restarts={{.RestartCount}} health={{.State.Health.Status}}' \
  $(docker compose -f docker-compose.prod.yml ps -q)
```

Растущий `RestartCount` — сигнал crash loop, требующий логов (`docker compose logs --tail 200 api`), а не просто «перезапустилось и ладно».

**Куда воткнуть внешний мониторинг**, когда он понадобится (без необходимости менять код): `GET /api/health/ready` — цель для любого uptime-чекера (UptimeRobot, healthchecks.io, встроенный алертинг облачного провайдера) с интервалом 1–5 минут и алертом на не-200 несколько раз подряд; JSON-логи (раздел 2) — вход для Loki/Vector/Fluent Bit без изменений в приложении, поскольку формат уже структурирован.

## 4. Ёмкость: диск, база, хранилище

```bash
# Диск хоста
df -h /var/lib/docker

# Размер тома PostgreSQL
docker exec $(docker compose -f docker-compose.prod.yml ps -q db) \
  psql -U "$POSTGRES_USER" -d gsi -c "SELECT pg_size_pretty(pg_database_size('gsi'))"

# Крупнейшие таблицы — где расти будет заметнее всего (audit_logs, ledger_entries, media_attachments)
docker exec $(docker compose -f docker-compose.prod.yml ps -q db) \
  psql -U "$POSTGRES_USER" -d gsi -c "
    SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
    FROM pg_catalog.pg_statio_user_tables
    ORDER BY pg_total_relation_size(relid) DESC LIMIT 10"

# Объектное хранилище (самостоятельно размещённый MinIO)
docker exec $(docker compose -f docker-compose.prod.yml ps -q minio) \
  mc du local/gsi-media
```

`audit_logs` и истории статусов растут монотонно и никогда не архивируются (по дизайну — `SECURITY.md`, `gsi_app` не имеет `DELETE` на этих таблицах ни при каких обстоятельствах). Планировать место с этим в уме: не «когда-нибудь почистим», а «диск рассчитан на N лет истории при текущем темпе».

Практическое правило: алерт на диск хоста при заполнении >80% — раньше, чем PostgreSQL начнёт отказывать в записи при 100%.

## 5. Частые операционные действия

```bash
# Перезапустить только API (например, после смены .env.production и без пересборки образа)
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --no-deps api

# Пересобрать и выкатить новую версию
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build

# Применить миграции вручную, не перезапуская API (MIGRATE_ON_START и так делает это на каждом старте,
# но иногда нужно применить их до выката новой версии кода)
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm --entrypoint node api dist/db/migrate.js

# Посмотреть, кто сейчас держит соединения с БД (диагностика зависшего запроса)
docker exec $(docker compose -f docker-compose.prod.yml ps -q db) \
  psql -U "$POSTGRES_USER" -d gsi -c "SELECT pid, state, query, now() - query_start AS duration FROM pg_stat_activity WHERE state <> 'idle' ORDER BY duration DESC"
```

## 6. Резервное копирование

Отдельный документ — [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md): расписание, retention, шифрование, и реально пройденное восстановление с доказательством целостности.

## 7. Чек-лист перед тем, как звать кого-то ещё

1. `curl https://app.example.com/api/health` — что именно не `ok`: `database` или `storage`?
2. `docker compose -f docker-compose.prod.yml ps` — какой контейнер `unhealthy`/`Restarting`?
3. `docker compose -f docker-compose.prod.yml logs --tail 200 <сервис>` — что последнее написано перед падением?
4. `df -h` — не диск ли переполнен (самая частая причина отказа PostgreSQL на запись)?
5. Если ничего из этого не объясняет проблему — `docs/BACKUP_RESTORE.md`, раздел «Восстановление в production», как последний ресурс.
