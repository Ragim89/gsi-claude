# BACKUP_RESTORE — резервное копирование и восстановление

Что бэкапится, как часто, где хранится, чем шифруется, и — самое главное — доказательство, что восстановление действительно работает, а не просто существует в виде скрипта.

---

## 1. Что бэкапится

Два независимых бэкапа, оба нужны вместе — база без файлов отчётов бесполезна, файлы без базы не найти:

| Что | Скрипт | Формат |
|---|---|---|
| PostgreSQL (вся схема, включая `audit_logs`, истории статусов — от имени владельца схемы, а не `gsi_app`) | `scripts/backup-db.sh` | `pg_dump -Fc` (сжатый, restorable через `pg_restore`) + `.counts` (точные `COUNT(*)` по каждой таблице) |
| Объектное хранилище (PDF отчётов, фотографии, вложения) | `scripts/backup-storage.sh` | `.tar.gz` зеркала бакета + `.count` (число объектов) |

Оба скрипта пишут в `backups/db/` и `backups/storage/` (в `.gitignore` — бэкапы никогда не коммитятся) с именем `gsi-<UTC-таймштамп>.*`.

## 2. Как запускать

```bash
# Против production-стека (docker-compose.prod.yml — значение по умолчанию):
S3_ACCESS_KEY=... S3_SECRET_KEY=... ENV_FILE=.env.production scripts/backup-db.sh
S3_ACCESS_KEY=... S3_SECRET_KEY=... ENV_FILE=.env.production scripts/backup-storage.sh

# Против dev-стека, для проверки самого механизма:
COMPOSE_FILE=docker-compose.yml S3_ACCESS_KEY=minioadmin S3_SECRET_KEY=minioadmin scripts/backup-storage.sh
```

`backup-db.sh` использует `docker compose exec db pg_dump` — сам PostgreSQL, никакого отдельного клиента ставить не нужно. `backup-storage.sh` запускает `mc` **внутри уже работающего контейнера `minio`** (образ MinIO сам несёт клиент `mc`), а не тянет отдельный образ `minio/mc`/`quay.io/minio/mc` — оба на момент написания требуют авторизации для анонимного `docker pull`, и рабочий контейнер уже содержит всё нужное.

## 3. Расписание и retention

Оба скрипта в конце сами удаляют файлы старше `RETENTION_DAYS` (по умолчанию 14) в своей папке — `find ... -mtime +14 -delete`. Планировщик — обычный `cron` на хосте (или `systemd timer`), например:

```cron
0 3 * * * cd /opt/gsi-erp && ENV_FILE=.env.production scripts/backup-db.sh      >> /var/log/gsi-backup-db.log 2>&1
15 3 * * * cd /opt/gsi-erp && ENV_FILE=.env.production scripts/backup-storage.sh >> /var/log/gsi-backup-storage.log 2>&1
```

Ежедневно ночью, с 15-минутным сдвигом, чтобы не бороться за нагрузку на БД одновременно. `RETENTION_DAYS=30` разумно для второго, более редкого прогона на удалённое хранилище (раздел 5).

## 4. Шифрование at rest

Оба скрипта поддерживают опциональное шифрование GPG:

```bash
BACKUP_GPG_RECIPIENT=ops@example.com scripts/backup-db.sh
```

— результат `gsi-<timestamp>.dump.gpg` вместо `.dump`, исходный незашифрованный файл удаляется сразу после шифрования. Требует, чтобы публичный ключ `ops@example.com` уже был импортирован в связку ключей той машины, что делает бэкап (`gpg --import ops-public.asc`).

**Если GPG не настроен** (по умолчанию) — шифрование at rest обеспечивается на уровне тома/хранилища, куда копируются файлы из `backups/`: диск с включённым LUKS/BitLocker, или SSE управляемого объектного хранилища (S3 `--sse=AES256`, Backblaze B2 server-side encryption), если бэкапы синхронизируются туда (раздел 5). **Держать незашифрованные бэкапы только на локальном диске сервера — не решение**: тот же диск, что теряется при инциденте с сервером, уносит и бэкап.

## 5. Куда класть бэкапы

Локальная папка `backups/` — только промежуточная стадия. Не хранить бэкап только на том же сервере, что и сама база: инцидент с сервером (диск, кража, компрометация) уничтожает и то, и другое одновременно. Синхронизировать `backups/` на отдельное хранилище — `rclone`/`aws s3 sync`/`rsync` на другой хост — сразу после того, как оба скрипта отработали (см. пример `cron` выше, третья строка):

```cron
30 3 * * * aws s3 sync /opt/gsi-erp/backups s3://gsi-backups-offsite/ --sse AES256
```

## 6. Восстановление — реальный прогон, доказательство целостности

Оба восстанавливающих скрипта поднимают **одноразовый, изолированный** контейнер (PostgreSQL/MinIO) и никогда не трогают работающий `db`/`minio` стека — восстановление не может случайно стереть боевые данные:

```bash
scripts/restore-db.sh backups/db/gsi-20260926T043511Z.dump
scripts/restore-storage.sh backups/storage/gsi-20260926T043903Z.tar.gz
```

`restore-db.sh` сверяет **точное количество строк** каждой таблицы восстановленной базы с `.counts`, записанным `backup-db.sh` в момент снятия дампа. `restore-storage.sh` сверяет число объектов архива с числом объектов, реально оказавшихся в бакете после `mc mirror`.

### Прогон, которым это подтверждено (PHASE 13, 2026-09-26)

Против живого dev-стенда со всеми демо-данными (999 заявок, 587 файлов в объектном хранилище):

```
$ scripts/backup-db.sh
Wrote backups/db/gsi-20260926T043511Z.dump (2.0M)
Wrote backups/db/gsi-20260926T043511Z.counts — 62 tables

$ scripts/restore-db.sh backups/db/gsi-20260926T043511Z.dump
  OK    asset_depreciation: 1318
  OK    assets: 61
  ... (все 62 таблицы)
  OK    users: 25
  (62 tables checked)
restore-db: PASS — every table's row count matches the backup exactly

$ scripts/backup-storage.sh
Mirrored 587 object(s).
Wrote backups/storage/gsi-20260926T043903Z.tar.gz (42M, 587 objects)

$ scripts/restore-storage.sh backups/storage/gsi-20260926T043903Z.tar.gz
Archived objects:  587
Restored objects:  587
restore-storage: PASS — every archived object round-tripped through restore
```

62 из 62 таблиц — точное совпадение количества строк; 587 из 587 объектов хранилища — точное совпадение. Ни один из скриптов не был написан «на веру»: первая версия `backup-db.sh` реально ловила ошибку (цикл `while read` внутри которого `docker compose exec` перехватывал общий stdin и обрывал перечисление после первой же таблицы — посчитана была только `asset_depreciation`), а `docker cp`/`-v` с путём в системном `/tmp` под этим Docker CLI на Windows не резолвился (`GetFileAttributesEx C:\tmp`) — оба найдены и исправлены именно на этом прогоне, не задним числом. Подробности — в самих скриптах (`scripts/restore-db.sh`, `scripts/restore-storage.sh`) и в `docs/CHANGELOG.md` (PHASE 13).

### Восстановление в production (не тренировка, а инцидент)

Намеренно не автоматизировано отдельным скриптом — замена работающей базы слишком необратима, чтобы делать это без ручного подтверждения на каждом шаге:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production stop api
# распаковать дамп, если он был зашифрован: gpg -d gsi-....dump.gpg > gsi-....dump
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T db \
  pg_restore -U "$POSTGRES_USER" -d gsi --clean --if-exists -Fc < gsi-....dump
# для хранилища: mc mirror распакованный архив прямо в боевой бакет (тот же mc, что в контейнере minio)
docker compose -f docker-compose.prod.yml --env-file .env.production start api
curl https://app.example.com/api/health/ready
```

`--clean --if-exists` заставляет `pg_restore` сначала удалить существующие объекты — иначе восстановление в непустую базу упадёт на конфликтах имён. Прогнать `scripts/restore-db.sh` на самом дампе **до** этого шага — минимальная проверка, что файл вообще целый.

## 7. Что не покрыто и почему

- **Point-in-time recovery** (WAL-архивирование) не настроен: `pg_dump`-снимки раз в сутки означают до 24 часов потенциальной потери данных при худшем сценарии. Для организации с более строгим RPO — `pgBackRest`/`wal-g` поверх того же `db`-сервиса, отдельная задача.
- **Проверка восстановления не автоматизирована по расписанию** — `scripts/restore-db.sh`/`restore-storage.sh` запускаются вручную (или из CI по отдельному, ещё не заведённому job'у). Раз в квартал прогонять вручную на последнем бэкапе — минимальная дисциплина до появления такого job'а.
