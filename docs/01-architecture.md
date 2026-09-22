# 01. Архитектура и модули

## Тип системы
Мультибранчевая ERP с единым ядром + надстройками на филиал (не SaaS multi-tenant, а холдинговая структура):

```
GSI Group HQ (Istanbul)
 ├── Turkey       (TRY)
 ├── Romania      (RON/EUR)
 ├── Ukraine      (UAH)
 ├── Uzbekistan   (UZS)
 ├── Kazakhstan   (KZT)
 ├── UAE (FZE)    (AED)
 └── Italy        (EUR)
```

Каждый филиал = запись `Company/Branch`:
- свой план счетов (или маппинг на групповой план для консолидации)
- своя валюта учёта + курс к валюте консолидации (рекомендация: EUR или USD)
- свой шаблон фирменного бланка/печати/подписанта
- своя локаль (язык по умолчанию, формат даты/чисел, часовой пояс)
- Row-Level Security: пользователь филиала видит только свои данные, HQ видит всё

## Модули (домены)
1. **CRM / Контрагенты** — клиенты, контракты, привязка к GAFTA/FOSFA номерам.
2. **Операции / Инспекции** (ядро): Заявка (Job) → Назначение инспектора → Полевой чек-лист по типу услуги → Фото/видео → Черновик отчёта → Проверка супервайзером → Утверждённый отчёт/сертификат (PDF).
3. **Лаборатория (LIMS)** — приём образцов, методики (ГМО/микотоксины/пестициды/микробиология/витамины), ввод результатов, сверка с MRL, протокол испытаний.
4. **Мобильное приложение инспектора** — офлайн-first, фото/видео с гео+таймштампом, цифровая подпись, синхронизация.
5. **Генератор отчётов на бланке** — шаблон per-branch (лого, реквизиты, язык, подпись/QR для верификации), выгрузка истории по контрагенту.
6. **Финансы и биллинг** — счета клиентам, затраты филиалов, мультивалютный учёт, intercompany-расчёты.
7. **Финансовая аналитика в реальном времени** — капитализация группы, P&L, cash flow (детали: см. 03-finance-dashboard.md).
8. **HR / Инспекторский состав** — квалификации, ISO-сертификаты, графики, зоны покрытия.
9. **Compliance / Качество** — журнал несоответствий, внутренние аудиты, версии методик, сроки аккредитаций.
10. **Документы и сертификаты** — реестр Certificates/Reports/Accreditations, клиентский доступ.
11. **Админка** — филиалы, роли, языки, шаблоны бланков, курсы валют.

## Роли
- Полевой инспектор — только свои задания, мобильный доступ
- Лаборант — LIMS, ввод результатов
- Супервайзер/менеджер филиала — утверждение отчётов, локальная отчётность
- Финконтролёр филиала — счета/расходы филиала
- CFO / HQ — консолидированный дашборд группы
- Клиент — личный кабинет, только свои отчёты
- Админ системы — роли, локализация, шаблоны

## Модель данных — ключевые сущности (для первой миграции БД)
- `branches` (id, country, currency, locale, legal_name, letterhead_template_id)
- `users` (id, branch_id, role, locale)
- `clients` (id, branch_id, name, gafta_fosfa_ref)
- `contracts` (id, client_id, branch_id, terms)
- `inspection_jobs` (id, branch_id, client_id, type, status, assigned_inspector_id, location, scheduled_at)
- `job_checklist_items` (id, job_id, item_key, value, notes)
- `media_attachments` (id, job_id, checklist_item_id, type[photo/video], url, gps, taken_at)
- `lab_samples` (id, job_id, sample_code, methods[])
- `lab_results` (id, sample_id, method, value, unit, mrl_limit, pass_fail)
- `reports` (id, job_id, branch_id, status, pdf_url, approved_by, approved_at, qr_code)
- `invoices` (id, branch_id, client_id, currency, amount, status)
- `expenses` (id, branch_id, category, amount, currency)
- `fx_rates` (id, branch_currency, base_currency, rate, date)
- `ledger_entries` (id, branch_id, account, debit, credit, currency, date) — основа real-time дашборда
