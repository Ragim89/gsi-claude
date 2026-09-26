# API GSI ONE

REST поверх `/api`. Все эндпоинты, кроме явно публичных, требуют заголовок `Authorization: Bearer <access token>`.

Актуально после PHASE 8.

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

## Лаборатория

Справочники — что можно измерить, чем и до каких пределов:

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET | `/lab/units` | `lab.method.read` | единицы измерения |
| GET | `/lab/tests` | `lab.method.read` | каталог анализов (`?includeInactive=true`) |
| POST/PATCH | `/lab/tests`, `/lab/tests/:id` | `lab.method.manage` | завести или изменить анализ |
| GET | `/lab/methods?labTestId=…` | `lab.method.read` | методики анализа |
| POST/PATCH | `/lab/methods`, `/lab/methods/:id` | `lab.method.manage` | завести или изменить методику |
| GET | `/lab/specifications` | `lab.specification.read` | нормы; фильтры `labTestId`, `commodityId`, `clientId`, `contractId` |
| POST/PATCH | `/lab/specifications`, `/lab/specifications/:id` | `lab.specification.manage` | завести или изменить норму |
| GET | `/lab/instruments?laboratoryId=…` | `lab.instrument.read` | приборы и сроки поверки |
| POST/PATCH | `/lab/instruments`, `/lab/instruments/:id` | `lab.instrument.manage` | завести или изменить прибор |
| GET | `/lab/panels/:commodityId?sampleId=…` | `lab.test.read` | стандартный набор культуры и что из него уже запрошено |

Версия методики не передаётся и не принимается: её поднимает триггер базы, когда меняется что-то существенное — название, стандарт, единица, пределы, область аккредитации. Правка описания версию не двигает.

Работа лаборатории:

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET | `/lab/dashboard` | `lab.test.read` | счётчики очереди; принимает `laboratoryId`, `branchId`, `mine=true` — те же фильтры, что и список, чтобы плитка и строки под ней считали одно и то же 
| GET | `/lab/requests` | `lab.test.read` | рабочая очередь: пагинация, поиск, фильтры, сортировка |
| GET | `/lab/requests/:id` | `lab.test.read` | карточка + `actions` — что можно сделать сейчас |
| POST | `/lab/requests` | `lab.test.request` | запросить анализы: `{ sampleId, usePanel: true }` либо `{ sampleId, tests: [{ labTestId, testMethodId }] }` |
| GET | `/lab/requests/:id/history` | `lab.test.read` | история статусов |
| GET | `/lab/requests/:id/revisions` | `lab.test.read` | все ревизии результата, включая заменённые |
| POST | `/lab/requests/:id/assignment` | `lab.test.assign` | назначить исполнителя |
| **POST** | **`/lab/requests/:id/transitions`** | зависит от действия | `start`, `hold`, `resume`, `reject`, `cancel` |
| PATCH | `/lab/requests/:id/result` | `lab.result.enter` | сохранить черновик результата |
| POST | `/lab/requests/:id/result/submit` | `lab.result.submit` | сдать работу |
| POST | `/lab/requests/:id/result/review` | `lab.result.review` | техническая проверка (подпись, не смена статуса) |
| POST | `/lab/requests/:id/result/return` | `lab.result.review` | вернуть исполнителю с причиной |
| POST | `/lab/requests/:id/result/approve` | `lab.result.approve` | утвердить |
| POST | `/lab/requests/:id/result/release` | `lab.result.release` | выпустить |
| POST | `/lab/requests/:id/result/amendments` | `lab.result.amend` | ревизия утверждённого результата (причина обязательна) |
| GET | `/lab/requests/:id/attachments` | `lab.test.read` | рабочие записи всех ревизий анализа |
| POST | `/lab/requests/:id/attachments` | `lab.result.enter` | приложить распечатку или журнал к действующей ревизии (multipart) |
| GET | `/lab/released?jobId=…\|sampleId=…` | `lab.test.read` | **только выпущенные** результаты — единственная дверь для отчётов |

`/lab/released` требует `jobId` либо `sampleId` и без них отвечает 400: отчёт всегда про одну заявку или одну пробу, а выгрузка всех выпущенных результатов группы — это не отчёт.

Приложить рабочую запись можно, только пока ревизия на рабочем месте (`in_progress`, `result_entered`); после сдачи — 409, потому что документы доказывают именно то значение, которое подписали.

`PATCH` и `DELETE` для `test_results` не существует: утверждённый результат не правят, его заменяет новая ревизия, а предыдущая остаётся ровно такой, какой её подписали.

Численный результат передаётся **строкой**: `{ "numericValue": "12.40" }`. Через `JSON.parse` и `double precision` 12.40 перестало бы быть 12.40 ещё до записи.

### Запрос анализов

```http
POST /api/lab/requests
{ "sampleId": "…", "usePanel": true, "priority": "high", "dueAt": "2026-12-31T12:00:00.000Z" }
→ 201 { "created": [ … ], "skipped": 0 }
```

Пробу должна была принять лаборатория (`accepted_by_lab`) — иначе 409. Повторный запрос того же анализа той же методикой — тоже 409, если только не передан `skipDuplicates: true`; тогда уже запрошенное просто пропускается. Норма находится **в момент запроса** и записывается в `specification_id`.

### Параметры рабочей очереди

| Параметр | Значения |
|---|---|
| `status` | любой статус жизненного цикла анализа |
| `active` | `true` — всё, за что лаборатория ещё должна ответ |
| `mine` | `true` — назначенное мне |
| `unassigned` | `true` — без исполнителя |
| `reviewed` | `true` \| `false` — есть ли у действующей ревизии техническая проверка; это и отличает «ждут проверки» от «ждут утверждения» |
| `overdue` | `true` — срок прошёл, ответа нет |
| `outOfSpec` | `true` — действующая ревизия вне нормы |
| `sampleId`, `jobId`, `clientId`, `laboratoryId`, `labTestId`, `testMethodId`, `analystId`, `commodityId`, `branchId` | фильтры по связям |
| `priority` | `low` \| `normal` \| `high` \| `urgent` |
| `from`, `to` | период по дате запроса |
| `search` | номер пробы, номер заявки, клиент, код и название анализа, исполнитель |
| `sort` | `requestedAt`, `dueAt`, `priority`, `status`, `updatedAt` |
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

## Документы

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET | `/reports` | `report.read` | реестр: пагинация, поиск, фильтры по типу, статусу, языку, клиенту, периоду |
| GET | `/reports/:id` | `report.read` | карточка + `actions` — что этот пользователь может сделать сейчас |
| POST | `/reports` | `report.create` | начать документ: `{ jobId, reportType, language?, templateId?, title?, content? }` |
| PATCH | `/reports/:id` | `report.update` | правка черновика; `lockVersion` защищает от перезаписи |
| GET | `/reports/sources/:jobId` | `report.create` | из чего документ можно собрать, до того как он создан |
| GET | `/reports/:id/sources` | `report.read` | то же для существующего документа |
| GET | `/reports/:id/versions` | `report.read` | все ревизии, включая заменённые |
| GET | `/reports/:id/history` | `report.read` | история статусов |
| **POST** | **`/reports/:id/submit`** | `report.submit_review` | сдать на проверку |
| POST | `/reports/:id/review` | `report.review` | подпись проверяющего (не меняет статус) |
| POST | `/reports/:id/changes` | `report.review` | вернуть автору с обязательной причиной |
| POST | `/reports/:id/approve` | `report.approve` | утвердить |
| POST | `/reports/:id/issue` | `report.issue` | **выпустить**: заморозить факты, отрендерить, захешировать, сохранить |
| POST | `/reports/:id/revisions` | `report.revise` | открыть ревизию выпущенного документа (причина обязательна) |
| POST | `/reports/:id/cancel` | `report.cancel` | отменить с причиной |
| DELETE / POST | `/reports/:id`, `/reports/:id/restore` | `report.archive` / `report.restore` | архив и возврат |
| GET | `/reports/:id/preview` | `report.preview` | черновик PDF с водяным знаком, нигде не сохраняется |
| GET | `/reports/:id/file?version=N` | `report.download` | выпущенный файл, байт в байт как он был сохранён |
| GET | `/reports/:id/pdf` | `report.download` | то же для документов, выпущенных до появления ревизий |
| GET/POST/PATCH | `/report-templates` | `report.read` / `report.manage_templates` | формы документов и их версии |
| GET | `/public/verify/:token` | публично | проверка подлинности по QR |

Свободного `PATCH status` нет: каждый переход — свой эндпоинт, как у заявки, инспекции, пробы и анализа.

### Что отвечает публичная проверка

```http
GET /api/public/verify/{token}
→ { "valid": true, "reportNumber": "TR-C-2026-00001", "reportType": "certificate_of_analysis",
    "version": 2, "issuedAt": "…", "issuer": "General Survey Inspection (Türkiye)",
    "branchCode": "TR", "checksum": "…64 hex…", "language": "en" }
```

Токен принадлежит **ревизии**, а не документу: скан копии, которая у человека на руках, отвечает о ней. Заменённая ревизия возвращает `status: "superseded"` и `supersededBy`, отменённый документ — `status: "cancelled"` и причину. Имени клиента и номера заявки в ответе нет.

## Финансы, активы, данные

| Метод | Путь | Право |
|---|---|---|
| GET | `/finance/dashboard`, `/finance/stream` (SSE) | `dashboard.read` / `finance.read` |
| GET/POST | `/finance/invoices`, `/finance/expenses` | `finance.read` + право действия |
| POST | `/finance/invoices/:id/issue` \| `/pay` \| `/cancel` | `invoice.issue` \| `invoice.pay` \| `invoice.cancel` |
| GET | `/finance/invoices/:id/payments` | `finance.read` — история платежей по счёту |
| GET/POST | `/finance/invoices/:id/reminders` | `finance.read` / `invoice.remind` — **лог**, не отправка (адаптер писем — PHASE 10) |
| GET/POST | `/assets`, `/assets/depreciation/run` | `asset.*` |
| GET | `/export/:section`, `/export/all` | `export.run` |
| GET/POST | `/import/:section`, `/import/:section/preview` | `import.run` + право раздела |

### Прайс-лист (PHASE 8)

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET/POST | `/finance/services` | `service.read` / `service.manage` | каталог услуг — не коммерческие данные, как справочники |
| PATCH | `/finance/services/:id` | `service.manage` | изменить или деактивировать |
| GET/POST | `/finance/prices` | `pricing.read` / `pricing.manage` | цены — коммерческие данные, та же изоляция, что у контрактов |
| PATCH | `/finance/prices/:id/deactivate` | `pricing.manage` | снять с действия |
| GET | `/finance/prices/resolve?serviceId=…&branchId=…&clientId=…&contractId=…` | `pricing.read` | действующая цена, порядок контракт → клиент → офис по умолчанию |

### Предложения (PHASE 8)

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET/POST | `/finance/quotes` | `quote.read` / `quote.create` | список / создать (`status: draft`) |
| GET | `/finance/quotes/:id` | `quote.read` | карточка + `actions` |
| DELETE | `/finance/quotes/:id` | `quote.update` | архивировать черновик |
| POST | `/finance/quotes/:id/send` | `quote.send` | draft → sent |
| POST | `/finance/quotes/:id/accept` \| `/reject` \| `/expire` | `quote.decide` | sent → accepted \| rejected \| expired (причина обязательна для `reject`) |
| POST | `/finance/quotes/:id/revise` | `quote.update` | назад в draft, причина обязательна |
| POST | `/finance/quotes/:id/cancel` | `quote.cancel` | отмена, причина обязательна |
| POST | `/finance/quotes/:id/create-invoice` | `invoice.create` | только из `accepted`; копирует позиции в новый черновик счёта |

Жизненный цикл не версионируется, как отчёт: предложение можно послать заново после `revise`, а не только исправить черновик.

### Платежи (PHASE 8)

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET/POST | `/finance/payments` | `payment.read` / `payment.create` (входящий) или `expense.pay` (исходящий) | список / регистрация |
| GET | `/finance/payments/:id` | `payment.read` | карточка с разнесением |
| POST | `/finance/payments/:id/allocate` | `payment.allocate` | разнести неразнесённый остаток на счёт или расход |

`POST /finance/invoices/:id/pay` не изменился: он по-прежнему полностью разносит платёж на один счёт — это тонкий случай `payments`, а не отдельный механизм.

### Заявка: себестоимость и маржа (PHASE 8)

| Метод | Путь | Право |
|---|---|---|
| GET | `/finance/jobs/:id/summary` | `job.read_finance` |

Выручка и себестоимость — это счета и расходы, у которых `job_id` указывает на эту заявку; отдельной таблицы затрат нет.

### Акт сверки клиента (PHASE 8)

| Метод | Путь | Право |
|---|---|---|
| GET | `/finance/clients/:id/statement?from=…&to=…` | `finance.read` |

Бегущее сальдо: выставленный счёт — дебет, применённый платёж — кредит, каждая сумма по курсу своей даты.

### Мультистрановой финансовый комплаенс (028)

`POST /finance/invoices` принимает необязательные `legalEntityId` / `taxCode`: без них — прежнее
поведение (`taxRate` от вызывающего, `isLegacyFiscal: true`); с ними — налог считается по
версии `jurisdiction_profiles`, действующей на дату счёта (см. `docs/FISCAL_COMPLIANCE.md`).

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET | `/admin/fiscal/legal-entities`, `/legal-entities/:id` | `finance.read` | список / карточка юр. лица |
| POST/PATCH | `/admin/fiscal/legal-entities`, `/legal-entities/:id` | `legal_entity.manage` | только HQ/Admin |
| GET | `/admin/fiscal/jurisdiction-profiles`, `/jurisdiction-countries` | `finance.read` | версии по стране / статус по каждой известной стране |
| POST | `/admin/fiscal/jurisdiction-profiles` | `fiscal_profile.manage` | добавляет СЛЕДУЮЩУЮ версию; существующая не редактируется и не удаляется |
| GET | `/finance/invoices/:id/esf-export` | `finance.read` | данные для ручного ввода в ИС ЭСФ — ничего не отправляет |
| POST | `/finance/invoices/:id/esf-status` | `invoice.issue` | фиксирует статус ЭСФ по факту из реальной системы, не имитирует его |

## Аналитика (PHASE 9)

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET | `/analytics/jobs?from=…&to=…&branchId=…&countryId=…` | `analytics.read` | заявки по месяцам, офису, стране, клиенту, услуге, статусу |
| GET | `/analytics/turnaround?from=…&to=…&branchId=…&countryId=…` | `analytics.read` | пять этапов (заявка→инспекция→лаборатория→выпущенный результат→отчёт), среднее/медиана/P90, тренд по месяцам |
| GET | `/analytics/workload?from=…&to=…&branchId=…&countryId=…` | `analytics.workload` | инспекторы, пробоотборщики, лаборанты, лаборатории, рецензенты — в работе / завершено |

Читает только уже существующие таблицы (`inspection_jobs`, `inspections`, `samples`, `test_requests`, `test_results`, `report_versions`, `job_assignments`) — новых таблиц нет. Row-Level Security та же, что у остальных модулей: у того же эндпоинта `own`-область инспектора возвращает только его собственные заявки — отдельного «личного» эндпоинта не заведено. `analytics.workload` — отдельное право (не входит в `analytics.read`), потому что показывает разбивку по конкретным людям, а не только по заявке.

## Документы, уведомления, поиск (PHASE 10)

| Метод | Путь | Право | Описание |
|---|---|---|---|
| GET | `/documents?entityType=…&entityId=…` | `document.read` | документы одной сущности (client/job/inspection/sample/report/invoice) |
| POST | `/documents` (multipart) | `document.upload` | загрузка файла: `entityType`, `entityId`, `category`, `title`, `visibility?`, `replacesId?` |
| POST | `/documents/:id/archive` | `document.archive` | архивирование (строка остаётся, скрывается политикой) |
| GET | `/notifications?unreadOnly=…` | `notification.read` | свои уведомления и счётчик непрочитанных |
| POST | `/notifications/:id/read` | `notification.read` | отметить одно прочитанным |
| POST | `/notifications/read-all` | `notification.read` | отметить все прочитанными |
| GET | `/notifications/stream` (SSE) | `notification.read` | пинг «что-то изменилось» — клиент перечитывает список, как `/finance/stream` |
| GET | `/search?q=…` | `search.read` | заявки, клиенты, пробы, отчёты/сертификаты, счета — по номеру или названию |

Загрузка проверяет MIME и расширение файла друг против друга (PDF/Word/Excel/изображения), затем что сущность существует и видна вызывающему в его же транзакции — второй проверки видимости не заведено, потому что первой достаточно: `document.read` закрывает саму таблицу `documents`, а не сущность повторно. Выпущенный отчёт не копируется в `documents` вторым файлом — `ReportDocumentsService.issue()`/`issueForJob()` регистрируют ссылку (`report_version_id`) на уже сохранённый PDF сразу после выпуска, в той же транзакции.

Уведомления рождаются из событий, которые операционные модули уже отправляли ради самого этого дня (`job-events.service.ts`, с PHASE 3): назначение заявки, приём пробы лабораторией, результат анализа/отчёт на рассмотрении/утверждении, выпуск отчёта. Два типа не привязаны к действию — «инспекция скоро» и «счёт просрочен» — их находит часовой сдвиг (`notifications-cron.service.ts`), с дедупликацией, чтобы не напоминать о том же самом на каждом тике. Почтовый адаптер (`email/`) подключён пока только к `RemindersService`: `EMAIL_PROVIDER=console` (по умолчанию) только логирует письмо, `EMAIL_PROVIDER=smtp` отправляет через любой SMTP-сервер — секретов в репозитории нет.

Поиск не заводит отдельной модели прав: каждый под-запрос — тот же `SELECT`, что уже выполняет список соответствующей сущности, в транзакции вызывающего, под теми же политиками (включая `app_sees_finance()` для счетов).

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
