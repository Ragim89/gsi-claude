# 05. Технологический стек

- **Backend:** Node.js (NestJS) — модульный монолит с чётким разделением по доменам (Operations, Lab, Finance, HR, Documents), с прицелом на выделение сервисов (Reports Generator, Notifications) при росте нагрузки.
- **БД:** PostgreSQL, `branch_id` на всех таблицах + Row-Level Security; Redis — кэш и очереди (BullMQ).
- **Файлы/медиа:** S3-совместимое хранилище (MinIO / облачный S3).
- **Frontend (web):** React + TypeScript, UI-кит на токенах (цвет/типографика из бренд-гайда GSI, см. 00-overview.md), i18n через `react-i18next`.
- **Mobile (инспекторы):** React Native, offline-first (SQLite/WatermelonDB + фоновая синхронизация).
- **Отчёты/PDF:** Puppeteer (HTML→PDF) или Carbone/DocxTemplater, один шаблон на филиал.
- **Realtime:** Socket.IO (финансовый дашборд, статусы job'ов).
- **Auth:** JWT + refresh, обязательное 2FA для финансовых ролей.
- **Инфраструктура:** Docker + docker-compose для dev, CI/CD (GitHub Actions), staging/prod окружения, шифрованные бэкапы БД и медиа.

## Структура репозитория (предложение)
```
/apps
  /web           — React web-клиент
  /mobile        — React Native инспекторское приложение
  /api           — NestJS backend (модули по доменам)
/packages
  /ui-kit        — общие компоненты, дизайн-токены (цвет/типографика GSI)
  /i18n          — общие переводы и глоссарий
  /shared-types  — общие TS-типы (Job, Report, Invoice и т.д.)
/docs            — этот набор спецификаций (00–07)
```
