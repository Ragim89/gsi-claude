# Рабочие процессы GSI ONE

Документ описывает жизненные циклы сущностей и правила переходов. Актуально с PHASE 3.

---

## Заявка (Job)

Заявка — центральная операционная сущность: через неё связаны клиент, контракт, исполнители, чек-лист, отчёт и финансы.

### Состояния

```mermaid
stateDiagram-v2
    [*] --> draft: создание
    [*] --> confirmed: создание с полными данными

    draft --> confirmed: confirm
    draft --> cancelled: cancel

    confirmed --> assigned: assign
    confirmed --> on_hold: hold
    confirmed --> cancelled: cancel

    assigned --> in_progress: start
    assigned --> assigned: assign (ещё исполнитель)
    assigned --> on_hold: hold
    assigned --> cancelled: cancel

    in_progress --> sampling: sample
    in_progress --> report_preparation: prepare_report
    in_progress --> under_review: submit
    in_progress --> on_hold: hold
    in_progress --> cancelled: cancel

    sampling --> lab: send_to_lab
    sampling --> report_preparation: prepare_report
    sampling --> under_review: submit
    sampling --> on_hold: hold

    lab --> report_preparation: prepare_report
    lab --> under_review: submit
    lab --> on_hold: hold

    report_preparation --> under_review: submit
    report_preparation --> on_hold: hold

    under_review --> in_progress: return (с причиной)
    under_review --> approved: approve → выпуск отчёта
    under_review --> on_hold: hold

    approved --> completed: complete
    completed --> invoiced: invoice
    completed --> closed: close
    invoiced --> closed: close

    on_hold --> in_progress: resume (возврат в прежнее состояние)

    closed --> [*]
    cancelled --> [*]
```

### Действия, права и обязательная причина

| Действие | Из | В | Право | Причина обязательна | Проверки |
|---|---|---|---|---|---|
| `confirm` | draft | confirmed | `job.change_status` | — | клиент, офис, тип услуги, запрошенная дата |
| `assign` | confirmed, assigned | assigned | `job.assign` | — | есть хотя бы один исполнитель |
| `start` | assigned | in_progress | `job.start` | — | — |
| `sample` | in_progress | sampling | `job.change_status` | — | — |
| `send_to_lab` | sampling | lab | `job.change_status` | — | — |
| `prepare_report` | in_progress, sampling, lab | report_preparation | `job.change_status` | — | — |
| `submit` | in_progress, sampling, lab, report_preparation | under_review | `job.submit` | — | чек-лист заполнен полностью |
| `return` | under_review | in_progress | `job.cancel` | **да** | — |
| `approve` | under_review | approved | `job.approve` | — | в той же транзакции выпускается отчёт |
| `complete` | approved | completed | `job.change_status` | — | есть выпущенный отчёт |
| `invoice` | completed | invoiced | `job.change_status` | — | — |
| `close` | completed, invoiced | closed | `job.close` | — | нет неоплаченных счетов |
| `hold` | все активные | on_hold | `job.change_status` | **да** | — |
| `resume` | on_hold | предыдущее состояние | `job.change_status` | — | — |
| `cancel` | draft … report_preparation, on_hold | cancelled | `job.cancel` | **да** | — |

Терминальные состояния: `closed`, `cancelled`. Повторное открытие не предусмотрено; если понадобится — это отдельное право и отдельный переход, а не редактирование статуса.

### Почему «под проверкой» называется `under_review`

Значение существует с MVP-1, печатается и переводится. Переименование в `review` ничего не улучшает, но затрагивает данные, переводы и код — поэтому осталось как есть. В терминах ТЗ `under_review` = REVIEW.

Значение `new` из старой модели переименовано в `confirmed` (миграция 012): заявка в прежней модели уже была полной, ей не хватало только исполнителя. Переименование значения enum не переписывает строки — все 956 существующих заявок перешли в новый словарь без единого UPDATE.

### Движок

Ни один эндпоинт не пишет `status` напрямую. Единственный вход — `JobWorkflowService.apply()`, и он всегда делает одно и то же:

```
проверить право → проверить допустимость перехода → проверить причину →
проверить бизнес-правила → обновить строку → записать историю →
записать аудит → отправить событие
```

Всё это внутри одной транзакции вызывающего кода: заявки со статусом, которого нет в истории, существовать не может.

События (`JobEventsService`) — это шов для уведомлений PHASE 10: `job.status_changed`, `job.assigned`, `job.unassigned`.

### Исполнители

Заявку ведёт команда, а не один инспектор:

| Роль назначения | Смысл |
|---|---|
| `lead_inspector` | ведущий; дублируется в `assigned_inspector_id` для отчёта и области видимости «свои» |
| `inspector` | инспектор |
| `sampler` | пробоотборщик |
| `lab_coordinator` | координатор лаборатории |
| `report_reviewer` | проверяющий отчёт |
| `operations_coordinator` | координатор операций |

Ведущий на заявке один — это гарантирует частичный уникальный индекс. Снятие исполнителя не удаляет строку, а проставляет `removed_at`: «кто работал на этой заявке в марте» остаётся вопросом с ответом.

Проверки при назначении: сотрудник активен и работает в офисе, отвечающем за заявку. Назначение и снятие пишутся в аудит.

### Просрочка

Просрочка не хранится: это `scheduled_at < now()` при активном статусе. Статус `overdue` был бы третьим источником правды и рассинхронизировался бы в первый же день.

### Архив против отмены

- `cancelled` — бизнес-исход: работа не состоялась, заявка видна.
- `deleted_at` (архив) — жизненный цикл хранения: заявка скрыта из списков, восстанавливается по праву `job.restore`.

Архивировать можно только заявку, которая не начиналась (`draft`, `confirmed`) или уже отменена. Всё остальное сначала отменяется.

### Конкурентное редактирование

У заявки есть `version`, увеличиваемая триггером при каждом изменении. Форма присылает версию, с которой её открыли; если в базе новее — изменение отклоняется с 409 и понятным сообщением, а не затирает чужую правку.

---

## Отчёт

`draft → issued → revoked`. Выпуск происходит только при утверждении заявки (`approve`), в той же транзакции. Отчёт с QR проверяется публично по токену без авторизации.

Версионирование отчётов (новая ревизия вместо тихого изменения) — PHASE 7.

## Счёт

`draft → issued → partially_paid → paid`, плюс `cancelled`. Отмена не удаляет проводки, а сторнирует их. Детали — в `docs/03-finance-dashboard.md`.

## Контракт

`draft → active → suspended / expired / terminated`. Статус меняется вручную; срок действия контролируется отдельно (`valid_to`), и экран контрактов показывает истекающие.
