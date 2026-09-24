# API GSI ONE

REST поверх `/api`. Все эндпоинты, кроме явно публичных, требуют заголовок `Authorization: Bearer <access token>`.

Актуально после PHASE 5.

---

## Общие правила

**Ответ списка** — страница, а не массив:

```json
{ "rows": [ ... ], "total": 942, "limit": 50, "offset": 0 }
```

Так отвечают `/jobs`, `/inspections`, `/samples`, `/clients`, `/contracts`, `/admin/audit`. Остальные списки короткие по своей природе (контакты клиента, исполнители заявки, справочники) и отдаются массивом.

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

## Инспекции

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET | `/inspections` | `inspection.read` | список: пагинация, поиск, фильтры, сортировка |
| GET | `/inspections/:id` | `inspection.read` | карточка + `actions` — что этот пользователь может сделать сейчас |
| POST | `/inspections` | `inspection.create` | создание по заявке: `{ jobId, type?, location?, scheduledStart?, leadInspectorId?, withChecklist? }` |
| PATCH | `/inspections/:id` | `inspection.update` | изменение; `version` для защиты от перезаписи |
| **POST** | **`/inspections/:id/transitions`** | зависит от действия | **единственный вход для смены статуса** |
| GET | `/inspections/:id/history` | `inspection.read` | история статусов |
| GET | `/inspections/:id/assignments` | `inspection.read` | исполнители |
| POST | `/inspections/:id/assignments` | `inspection.assign` | назначить: `{ userId, role?, note? }` |
| DELETE | `/inspections/:id/assignments/:assignmentId` | `inspection.assign` | снять |
| GET | `/inspections/:id/checklist` | `inspection.read` | пункты + прогресс + признак редактируемости |
| **PATCH** | **`/inspections/:id/checklist`** | `checklist.update` | **пачка ответов одним запросом** (автосохранение) |
| GET/POST | `/inspections/:id/findings` | `inspection.read` / `inspection.add_finding` | замечания |
| PATCH | `/inspections/:id/findings/:findingId` | `inspection.add_finding` | изменить; после утверждения — только `status` |
| GET/POST | `/inspections/:id/measurements` | `inspection.read` / `inspection.add_measurement` | замеры |
| DELETE | `/inspections/:id/measurements/:measurementId` | `inspection.add_measurement` | удалить замер |
| GET | `/inspections/:id/photos` | `inspection.read` | фотографии с подписанными ссылками |
| POST | `/inspections/:id/photos` | `media.upload` | фото (multipart): `file`, `category?`, `caption?`, `checklistItemId?`, GPS, `takenAt` |
| DELETE | `/inspections/:id` | `inspection.archive` | в архив (не удаление) |
| POST | `/inspections/:id/restore` | `inspection.restore` | вернуть из архива |

### Смена статуса

```http
POST /api/inspections/{id}/transitions
{ "action": "return", "reason": "Photograph the damaged seal" }
```

`action` — из словаря: `schedule`, `start`, `complete`, `submit_review`, `return`, `approve`, `reopen`, `hold`, `resume`, `cancel`. Причина обязательна для `hold`, `cancel`, `return`, `reopen`. Ответ — карточка инспекции.

### Пачка ответов чек-листа

```http
PATCH /api/inspections/{id}/checklist
{ "answers": [
  { "itemId": "…", "result": "deviation", "notes": "Hatch cover seal damaged" },
  { "itemId": "…", "result": "ok" }
] }
```

До 200 ответов за запрос. Поле, которого нет в объекте, не меняется — экран шлёт только то, чего касался инспектор. Ответ — весь чек-лист с прогрессом:

```json
{ "items": [ … ], "total": 6, "answered": 2, "requiredRemaining": 4, "editable": true }
```

Пункт чужой инспекции отклоняется с 404, а не молча пропускается: экран, приславший не те идентификаторы, — это ошибка, и терять из-за неё работу инспектора нельзя.

### Параметры списка инспекций

| Параметр | Значения |
|---|---|
| `status` | любой статус жизненного цикла |
| `active` | `true` — всё, что не утверждено и не отменено |
| `mine` | `true` — инспекции, где я ведущий или назначен |
| `jobId`, `clientId`, `inspectorId`, `branchId`, `countryId` | фильтры по связям |
| `type` | вид услуги из общего каталога |
| `from`, `to` | период по плановой дате |
| `search` | номер инспекции, номер заявки, клиент, место, город |
| `sort` | `inspectionNumber`, `scheduledStart`, `status`, `updatedAt` |
| `dir` | `asc` \| `desc` |
| `limit` (≤200), `offset` | страница |

---

## Пробы и цепочка хранения

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET | `/samples` | `sample.read` | список: пагинация, поиск, фильтры, сортировка |
| GET | `/samples/laboratories` | `sample.read` | куда можно отправить пробу (только работающие) |
| GET | `/samples/laboratories?includeInactive=true` | `org.manage` | включая закрытые — для экрана администрирования |
| POST | `/samples/laboratories` | `org.manage` | добавить лабораторию |
| PATCH | `/samples/laboratories/:labId` | `org.manage` | изменить или закрыть (`isActive: false`) |
| GET | `/samples/:id` | `sample.read` | карточка + `actions` — что этот пользователь может сделать сейчас |
| POST | `/samples` | `sample.create` | запись пробы: `{ inspectionId \| jobId, sampleType?, commodity?, quantity?, unit?, … }` |
| PATCH | `/samples/:id` | `sample.update` | изменение; `version` для защиты от перезаписи |
| **POST** | **`/samples/:id/transitions`** | зависит от действия | **единственный вход для смены статуса** |
| GET | `/samples/:id/history` | `sample.read` | история статусов |
| GET | `/samples/:id/custody` | `sample.read_custody` | цепочка ответственного хранения |
| **POST** | **`/samples/:id/custody`** | `sample.update` | **передача из рук в руки** (статус не меняется) |
| POST | `/samples/:id/custody/:eventId/corrections` | `sample.update` | исправление записи новой записью |
| GET/POST | `/samples/:id/attachments` | `sample.read` / `sample.add_attachment` | фото и документы (multipart) |
| GET | `/samples/:id/label` | `sample.print_label` | данные этикетки и QR |
| DELETE | `/samples/:id` | `sample.archive` | в архив (не удаление) |
| POST | `/samples/:id/restore` | `sample.restore` | вернуть из архива |

Для события цепочки хранения **нет** `PATCH` и **нет** `DELETE` — и у роли базы данных нет таких прав. Это не забытая функциональность, а суть модуля.

### Смена статуса

```http
POST /api/samples/{id}/transitions
{ "action": "dispatch", "destinationLaboratoryId": "…", "courier": "Aras Kargo",
  "trackingReference": "AK-772311", "packageCount": 1 }
```

`action` — из словаря: `collect`, `register`, `seal`, `dispatch`, `receive`, `accept`, `reject`, `return`, `hold`, `resume`, `cancel`. Причина обязательна для `hold`, `cancel`, `reject`, `return`.

Каждое действие принимает поля, которые принадлежат именно ему, и они записываются вместе со статусом в одной транзакции:

| Действие | Поля |
|---|---|
| `collect` | `location`, `condition`, `notes` |
| `seal` | `sealNumber` (обязательно), `sealType`, `sealedBy` |
| `dispatch` | `destinationLaboratoryId`, `courier`, `trackingReference`, `packageCount` |
| `receive` | `sealState`, `condition`, `receivedBy`, `notes` |
| `accept` / `reject` | `decidedBy`, `rejectionReason` (обязательна при `reject`), `notes` |

Кто опломбировал, отправил, принял и решил, подставляется из текущего пользователя, если поле не передано: запись не должна оставаться пустой.

### Параметры списка проб

| Параметр | Значения |
|---|---|
| `status` | любой статус жизненного цикла |
| `active` | `true` — всё, что не принято лабораторией и не отменено |
| `mine` | `true` — пробы, которые я отобрал или записал |
| `jobId`, `inspectionId`, `clientId`, `samplerId`, `commodityId`, `laboratoryId`, `branchId`, `countryId` | фильтры по связям; все выведены на экран (страна и офис — через переключатель филиала) |
| `sampleType` | тип пробы |
| `from`, `to` | период по дате отбора |
| `search` | номер пробы, номер заявки, клиент, культура, **номер пломбы**, партия/лот, ссылка на контейнер |
| `sort` | `sampleNumber`, `sampledAt`, `status`, `updatedAt` |
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
