# GSI ERP

ERP platform for **General Survey Inspection (GSI)**, an international inspection company. Specification: [`docs/`](docs/) (00–07).

This branch implements **MVP-1** ([docs/06-roadmap.md](docs/06-roadmap.md)): clients, inspection jobs, a field checklist with photos, a PDF report on the Türkiye letterhead, basic roles, and authentication.

## Repository layout

```
apps/
  api/             NestJS modular monolith (auth, admin, crm, operations, documents)
    migrations/    plain SQL migrations (schema + Row-Level Security)
  web/             React + TypeScript (Vite), react-i18next, TanStack Query
packages/
  shared-types/    domain types, enums, job status machine, checklist templates
  ui-kit/          design tokens (single source of brand colours) + React components
docs/              specification
```

`apps/mobile` and `packages/i18n` from [docs/05-tech-stack.md](docs/05-tech-stack.md) are deferred (see "Not done yet" below).

## Run locally (Docker)

Requirements: Docker Desktop (with Compose v2).

```bash
docker compose up --build
```

| What | URL |
|---|---|
| Web app | http://localhost:8080 |
| API health check | http://localhost:3000/api/health |
| MinIO console (photos / PDFs) | http://localhost:9001 (`minioadmin` / `minioadmin`) |
| PostgreSQL | `localhost:5432`, db `gsi`, owner `gsi` / `gsi` |

On start, the API runs migrations and seeds demo data: 7 branches, users, 3 clients, and 1 assigned job in Türkiye.

| Demo account | Role | Branch |
|---|---|---|
| `admin@gsi.local` | admin (HQ, sees all branches) | TR |
| `supervisor.tr@gsi.local` | supervisor | TR |
| `inspector.tr@gsi.local` | inspector (has the demo job) | TR |
| `inspector2.tr@gsi.local` | inspector | TR |
| `supervisor.ro@gsi.local` / `inspector.ro@gsi.local` | supervisor / inspector | RO |

Every demo account uses the password `ChangeMe123!` (set `SEED_PASSWORD` in `.env` to change it). To override other defaults, copy `.env.example` to `.env`.

Reset everything: `docker compose down -v`.

### End-to-end walkthrough
1. Log in as `inspector.tr@gsi.local`, open the demo job, and fill in the checklist (OK / Deviation / N/A, readings, notes). Attach photos to the items; on a phone this opens the rear camera. Then click **Submit for review**.
2. Log in as `supervisor.tr@gsi.local`, open the job, and click **Preview PDF (draft)**. Then click **Approve & issue report**, or **Return for rework** with a comment.
3. Open the client card (**Clients → Anatolia Grain Trading**). The issued report appears under **Reports** with a **Download PDF** button.
4. The QR code on the PDF links to `http://localhost:8080/verify/<token>`, a public authenticity check.
5. Log in as `supervisor.ro@gsi.local`: none of the Türkiye data is visible. PostgreSQL RLS enforces this, not just the UI.

### Running without Docker (dev mode)
Needs Node 20+, plus PostgreSQL 16 and MinIO running (for example `docker compose up db minio`).

```bash
npm install
npm run build:packages
npm run build -w @gsi/api && npm run db:migrate && npm run db:seed
npm run dev:api     # http://localhost:3000/api  (nest --watch)
npm run dev:web     # http://localhost:5173      (proxies /api → :3000)
```

PDF rendering needs Chromium. Set `PUPPETEER_EXECUTABLE_PATH` to the Chrome or Chromium binary, for example `C:\Program Files\Google\Chrome\Application\chrome.exe`.

## Key design decisions

- **Branch isolation = PostgreSQL Row-Level Security.** Every business table has a `branch_id`. The API connects as `gsi_app`, a role that is not the table owner and has `NOBYPASSRLS`. For each request it opens a transaction and sets `app.user_id / app.branch_id / app.role` with `set_config(..., is_local)`. The policies in `001_init.sql` enforce three rules:
  - users see only their own branch;
  - HQ roles (`admin`, `cfo`) see everything;
  - inspectors see only jobs assigned to them.

  Child rows (checklist, media, reports) inherit `branch_id` from the job through a trigger. Composite FKs ensure a job's client and inspector belong to the same branch.
- **Job lifecycle:** `new → assigned → in_progress → under_review → approved` (a job can also go `under_review → in_progress` when returned, or to `cancelled`). The transition table lives in `packages/shared-types`. Approval and report issuing happen in **one transaction**, so no job is ever "approved" without its PDF.
- **Checklist snapshot:** each job copies its template items (label, input kind, template version) into `job_checklist_items`. Editing a template later does not change historical jobs (ISO 17020 traceability).
- **Media:** originals are stored in S3/MinIO byte-for-byte with a recorded SHA-256 (for audit). A ≤1600px JPEG preview is used in the UI and in PDFs. Browsers get short-lived presigned URLs, and the bucket is private.
- **PDF:** a per-branch HTML template (`apps/api/src/documents/templates/`) is rendered by headless Chromium (puppeteer-core). **All colours and fonts come from `packages/ui-kit/src/tokens.ts`** as `--gsi-*` CSS variables, and the web app uses the same tokens. When the brandbook arrives, only that one file changes.
- **Document numbers:** `TR-J-2026-00001` for jobs and `TR-R-2026-00001` for reports. Counters are per branch and per year.

## Assumptions (open questions from docs/07)

Each one is marked in the code with `ASSUMPTION:` (`grep -rn "ASSUMPTION" apps packages`). The main ones:

| # | Assumption | Where |
|---|---|---|
| Q1 | Brand HEX values come from the website reconstruction; semantic colours and the font stack were chosen by us; a text wordmark stands in for the logo | `packages/ui-kit/src/tokens.ts`, `tr-default.ts` |
| Q2 | Branch legal names and addresses are placeholders ("legal name TBC") | `apps/api/src/db/seed.ts` |
| Q3 | UI ships in EN + RU; TR and the other languages come in MVP-2 | `apps/web/src/i18n.ts` |
| Q4 | Report layout, TR/EN bilingual labels, disclaimer text, numbering format, and checklist items per service are drafts | `tr-default.ts`, `checklist-templates.ts`, `001_init.sql` |
| Q4 | Branches without their own template fall back to the TR layout, with their own requisites | `documents/templates/index.ts` |
| — | HQ = `admin` + `cfo` roles | `shared-types/src/enums.ts`, `app_is_hq()` |
| — | Inspectors can read but not edit clients; supervisors can start or submit a job on an inspector's behalf | `clients.controller.ts`, `jobs.service.ts` |
| — | Photo capture time comes from the client (file `lastModified`) and GPS from the browser; no EXIF parsing yet; photos only, no video yet | `checklist.service.ts`, `Checklist.tsx` |
| — | Refresh tokens are stateless JWTs stored in localStorage (no revocation list) | `auth.service.ts`, `web/src/api.ts` |
| — | The public verification page shows the report number, date, branch, service, and client name to anyone with the QR token | `public_verify_report()` |

## API overview (`/api`)

| Method & path | Roles |
|---|---|
| `POST /auth/login`, `POST /auth/refresh`, `GET /auth/me` | public / any |
| `GET /branches` | any (RLS-scoped) |
| `GET /users?role=` · `POST /users` · `PATCH /users/:id` | supervisor+admin · admin · admin |
| `GET/POST /clients`, `GET/PATCH/DELETE /clients/:id` | read: any · write: supervisor, admin |
| `GET/POST /jobs`, `GET/PATCH/DELETE /jobs/:id` | read: any (inspector: own jobs) · write: supervisor, admin |
| `POST /jobs/:id/{assign,start,submit,return,approve,cancel}` | per the lifecycle above |
| `GET /jobs/:id/checklist`, `PATCH /jobs/:id/checklist/:itemId` | assigned inspector / supervisor |
| `POST /jobs/:id/checklist/:itemId/media` (multipart `file`, `gpsLat`, `gpsLng`, `takenAt`), `DELETE /media/:id` | assigned inspector / supervisor |
| `GET /jobs/:id/report-preview` | supervisor, admin (watermarked draft PDF) |
| `GET /reports?clientId=&jobId=`, `GET /reports/:id/pdf` | any (RLS-scoped) |
| `GET /public/verify/:token` | public |
