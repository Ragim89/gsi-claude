# API GSI ONE

REST поверх `/api`. Все эндпоинты, кроме явно публичных, требуют заголовок `Authorization: Bearer <access token>`.

Актуально после PHASE 3.

---

## Общие правила

**Ответ списка** — страница, а не массив:

```json
{ "rows": [ ... ], "total": 942, "limit": 50, "offset": 0 }
```

Так отвечают `/jobs`, `/clients`, `/contracts`, `/admin/audit`. Остальные списки короткие по своей природе (контакты клиента, исполнители заявки, справочники) и отдаются массивом.

**Ошибка** — всегда одинаковой формы:

```json
{
  "statusCode": 409,
  "message": "This job was changed by someone else while you were editing it. Reload it and try again.",
  "requestId": "8bbb3520-93f0-4088-aa1c-626adeb4a373",
  "path": "/api/jobs/…",
  "timestamp": "2026-09-24T07:58:07.208Z"
}
```

`requestId` совпадает с заголовком `X-Request-Id` и с записью в логе. Внутренние детали (стек, SQL) пользователю не уходят никогда.

**Коды**: 400 — данные не прошли проверку или нарушено бизнес-правило; 401 — нет или истёк токен; 403 — нет права; 404 — записи нет **или** она вне области видимости (это одно и то же для того, кто спрашивает); 409 — конфликт состояния (недопустимый переход, устаревшая версия, дубль); 429 — превышен лимит запросов.

**Ограничение частоты**: 300 запросов в минуту на пользователя, 10 попыток входа в минуту.

---

## Аутентификация

| Метод | Путь | Описание |
|---|---|---|
| POST | `/auth/login` | вход; возвращает access + refresh и профиль с правами |
| POST | `/auth/refresh` | обновление пары токенов |
| GET | `/auth/me` | текущий пользователь, его роли, область и права |

Токен несёт коды ролей; права разворачиваются на сервере и кэшируются, поэтому изменение роли действует за секунды, а не после истечения токена.

---

## Заявки

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET | `/jobs` | `job.read` | список: пагинация, поиск, фильтры, сортировка |
| GET | `/jobs/archived` | `job.restore` | архив |
| GET | `/jobs/:id` | `job.read` | карточка + `actions` — что этот пользователь может сделать сейчас |
| POST | `/jobs` | `job.create` | создание; `status: draft \| confirmed` |
| PATCH | `/jobs/:id` | `job.update` | изменение; `version` для защиты от перезаписи |
| **POST** | **`/jobs/:id/transitions`** | зависит от действия | **единственный вход для смены статуса** |
| GET | `/jobs/:id/history` | `job.read_history` | история статусов |
| GET | `/jobs/:id/assignments` | `job.read` | исполнители |
| POST | `/jobs/:id/assignments` | `job.assign` | назначить: `{ userId, role, note? }` |
| DELETE | `/jobs/:id/assignments/:assignmentId` | `job.assign` | снять |
| DELETE | `/jobs/:id` | `job.archive` | в архив (не удаление) |
| POST | `/jobs/:id/restore` | `job.restore` | вернуть из архива |
| GET | `/jobs/:id/checklist` | `job.read` | полевой чек-лист |
| PATCH | `/jobs/:id/checklist/:itemId` | `checklist.update` | ответ по пункту |
| POST | `/jobs/:id/checklist/:itemId/media` | `media.upload` | фото (multipart) |
| GET | `/jobs/:id/report-preview` | `report.preview` | черновик PDF |

### Смена статуса

```http
POST /api/jobs/{id}/transitions
{ "action": "hold", "reason": "Vessel delayed by weather" }
```

`action` — из словаря: `confirm`, `assign`, `start`, `sample`, `send_to_lab`, `prepare_report`, `submit`, `return`, `approve`, `complete`, `invoice`, `close`, `hold`, `resume`, `cancel`. Причина обязательна для `hold`, `cancel`, `return`.

Ответ: `{ "job": { … } }`, а для `approve` — ещё и `{ "report": { … } }`.

Прежние эндпоинты (`/start`, `/submit`, `/return`, `/approve`, `/cancel`) сохранены и вызывают тот же движок — мобильный клиент и старые интеграции продолжают работать.

### Параметры списка заявок

| Параметр | Значения |
|---|---|
| `status` | любой статус жизненного цикла |
| `active` | `true` — всё, что не завершено и не отменено |
| `priority` | `low` … `urgent` |
| `mine` | `true` — заявки, где я исполнитель в любой роли |
| `clientId`, `contractId`, `inspectorId`, `commodityId`, `portId`, `branchId`, `countryId` | фильтры по связям |
| `type`, `commodityGroup`, `contractNo`, `minQuantity`, `maxQuantity` | предметные фильтры |
| `from`, `to` | период по плановой дате |
| `search` | номер заявки, клиент, ссылка клиента, судно, место, контракт, культура, контейнер |
| `sort` | `jobNumber`, `requestedDate`, `scheduledAt`, `priority`, `status`, `updatedAt` |
| `dir` | `asc` \| `desc` |
| `limit` (≤200), `offset` | страница |

---

## CRM

| Метод | Путь | Право |
|---|---|---|
| GET/POST | `/clients` | `client.read` / `client.create` |
| GET/PATCH | `/clients/:id` | `client.read` / `client.update` |
| DELETE | `/clients/:id` | `client.archive` |
| GET/POST | `/clients/:id/contacts` | `client.read` / `client.update` |
| PATCH/DELETE | `/clients/:id/contacts/:contactId` | `client.update` |
| GET/POST | `/contracts` | `contract.read` / `contract.manage` |
| GET/PATCH/DELETE | `/contracts/:id` | `contract.read` / `contract.manage` |
| GET/POST | `/contracts/:id/file` | `contract.read` / `contract.manage` |

---

## Документы, финансы, активы

| Метод | Путь | Право |
|---|---|---|
| GET | `/reports`, `/reports/:id/pdf` | `report.read`, `report.download` |
| GET | `/public/verify/:token` | публично |
| GET | `/finance/dashboard`, `/finance/stream` (SSE) | `dashboard.read` / `finance.read` |
| GET/POST | `/finance/invoices`, `/finance/expenses` | `finance.read` + право действия |
| GET/POST | `/assets`, `/assets/depreciation/run` | `asset.*` |
| GET | `/export/:section`, `/export/all` | `export.run` |
| GET/POST | `/import/:section`, `/import/:section/preview` | `import.run` + право раздела |

## Администрирование

| Метод | Путь | Право |
|---|---|---|
| GET | `/admin/permissions`, `/admin/roles` | `role.manage` или `user.read` |
| PUT | `/admin/roles/:code/permissions` | `role.manage` |
| GET/PUT | `/admin/users/:id/roles` | `user.read` / `role.manage` |
| GET | `/admin/audit` | `audit.read` |
| GET | `/org`, `/org/countries`, `/org/departments` | доступно авторизованным |
| POST/PATCH | `/org/countries`, `/org/departments` | `org.manage` |
| GET/POST/PATCH | `/users`, `/branches` | `user.*`, `branch.*` |

## Проверка состояния

| Путь | Вопрос |
|---|---|
| `/health/live` | процесс жив? (без обращения к зависимостям) |
| `/health/ready` | можно ли слать трафик? (БД и хранилище) |
| `/health` | сводка с задержками |
