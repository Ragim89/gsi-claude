# White-label core (PHASE 13.5)

How one core codebase serves more than one inspection company. Architecture: **one core repo +
client profiles + a separate deployment, database and storage per company.** There is no
multi-tenant switching inside a running instance — each company gets its own deployment, its own
Postgres database and its own object storage bucket, all running the same, unmodified core image.
"White-label" here means *the core needs no code change to look like a different company*, not
that two companies ever share one database.

## What is Core and what is client-specific

**Core** (this repository, unchanged per client):
- The NestJS/Postgres/React stack, RLS, RBAC, workflows, finance, laboratory, documents.
- The generic document renderer (`apps/api/src/documents/templates/document.ts`), which already
  prints whatever `organizations`/`branches` say and has no company name baked into its wording.
- The `organizations` table's branding columns (migration 027) and the endpoints that read them
  (`GET /api/org`, `GET /api/org/brand`) — the *mechanism*, not any company's values.

**Client-specific** (`config/clients/<name>/`, one directory per company):
- `brand.json` — display name, short name, product name, brand colours, support contact. Read by
  `scripts/bootstrap-admin.mjs` when it provisions a fresh database.
- `manifest.json` — the PWA's name, description, theme colour and icon set.
- `web.env` — the web app's `<title>` and theme-color meta, applied via Vite's own `%VITE_*%`
  substitution in `apps/web/index.html`.
- Its own seed/demo data, if it wants one, following the pattern `apps/api/src/db/seed.ts`
  already sets: `config/clients/gsi/` *is* that pattern's first example — GSI's seven demo
  branches, demo users and `@gsi.local` accounts are exactly what a demo/staging environment for
  GSI seeds, and a second company would write its own `seed-<company>.ts` the same way, gated by
  the same `SEED_ON_START` switch (off in production either way — see docs/DEPLOYMENT.md). The
  files were not physically relocated in this phase to avoid rewiring the seed runner for no
  behavioural change; treat `seed.ts` as GSI's profile until a second company's seed is written.
- Custom logo files, if the bundled ui-kit asset isn't the right one for that company — see
  "Logo" below.

## What already was configuration, not code

Document numbering (`next_doc_number()`), branch letterhead fields (legal name, address, phone,
accreditation, bank details), currencies, locales, and the whole country/office/department
hierarchy were already rows in Postgres, not literals in TypeScript. Migration 027 closes the one
gap that was left: the group's own name, colours and logo.

## Creating a new client profile

1. `mkdir config/clients/acme` and write `brand.json`, `manifest.json`, `web.env` (copy
   `config/clients/gsi/*` as a starting point — every field is documented there).
2. Stand up a fresh deployment: its own Postgres database, its own object storage bucket, the
   unmodified core Docker images (docs/DEPLOYMENT.md).
3. Run migrations. Migration 007 always inserts one `organizations` row named "General Survey
   Inspection" with code `GSI` — that is historical (it predates client profiles) and additive
   migrations are never rewritten (docs/AI_EXECUTION_RULES.md, rule 5). The next step corrects it.
4. Run `scripts/bootstrap-admin.mjs` with `CLIENT_PROFILE=acme` (plus the usual `COUNTRY_*` /
   `BRANCH_*` / `ADMIN_*` variables). It reads `config/clients/acme/brand.json` and updates the
   organization row's branding — `ORG_*` environment variables, if set, override the profile's
   values field by field.
5. `CLIENT_PROFILE=acme npm run build -w @gsi/web` (or `predev` for local development) applies
   `manifest.json` and `web.env` to `apps/web/public/manifest.webmanifest` and `apps/web/.env`
   before the build runs — see `scripts/apply-client-profile.mjs`. `CLIENT_PROFILE` defaults to
   `gsi`, so an unmodified checkout keeps building GSI's own PWA shell without setting anything.

Nothing above edits a file inside `apps/api/src` or `apps/web/src`.

## Changing branding on an existing deployment

Re-run `scripts/bootstrap-admin.mjs` (idempotent) with the fields to change, or update the
`organizations` row's branding columns directly with SQL — there is deliberately no admin-UI
branding editor yet (out of scope for this phase; the architecture assumes branding is set once,
at deployment time, not toggled at runtime).

## What actually reads the branding

- **Login screen / PWA shell**: `GET /api/org/brand`, public (no session — the migration adds a
  `SECURITY DEFINER` `public_org_brand()` function for this, the same pattern
  `public_verify_report`/`public_verify_document` already use to read past RLS with no session).
  `apps/web/src/brand.ts`'s `useBrand()` hook fetches it once; `LoginPage.tsx`, `Layout.tsx`,
  `InstallPrompt.tsx` and the sample-label print in `SampleDetailPage.tsx` all read it.
- **In-app**: `GET /api/org` (authenticated), same fields.
- **Issued documents**: the branding is copied into `ReportDataSnapshot.organization` at issue
  time (`report-data.service.ts#snapshot`), the same way branch letterhead data already was — a
  later rebrand cannot change what an already-issued document says (PHASE 7's immutability
  guarantee is unmodified; this only adds one more frozen field next to the branch data that was
  already frozen there).
- **Colours**: `ThemeStyle` (`packages/ui-kit/src/react/index.tsx`) now accepts a `brand` prop
  and overrides `--gsi-color-primary`/`--gsi-color-accent` (and `--gsi-color-info`, which shares
  `primary`) when the organization sets its own. Every other token — status colours, neutrals,
  the dataviz palette — is untouched: deriving a whole palette from two hex values is a separate
  design problem, not part of this phase.

## Logo

`organizations.logo_url` / `logo_light_url` are nullable; `NULL` keeps the bundled ui-kit asset
(`packages/ui-kit/src/assets`), which is GSI's own logo today. For the web app, set the column to
any URL the browser can load. For PDFs, Chromium renders with **no network access**
(`documents/templates/brand.ts`), so a custom logo there must be a `data:` URI already — the
template functions check for the `data:` prefix and fall back to the bundled asset otherwise. The
bundled PNG/WEBP files themselves were not relocated out of `ui-kit` in this phase (churn was
minimized per the phase brief); a company that needs its own file supplies a `data:`/hosted URL
rather than replacing the package asset. Moving the literal files into
`config/clients/<name>/assets/` and threading them through the build is a reasonable follow-up,
not done here.

## Remaining, deliberately out of scope

- No admin UI to edit branding at runtime (set at deploy time via `bootstrap-admin.mjs` / SQL).
- No automatic full-palette derivation from two brand colours.
- `seed.ts` was not physically split into a `config/clients/gsi/seed.ts` file; see above.
- Migration 007's hardcoded initial `organizations` row is not rewritten (migrations are
  additive-only); every deployment corrects it via `bootstrap-admin.mjs` in step 4 above.
