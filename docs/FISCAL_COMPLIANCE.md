# Multi-country finance compliance

Migration `028_fiscal_compliance.sql`. One principle drives every decision here: **one common
Finance/accounting core, but each country has its own versioned fiscal/compliance profile.
A country never receives another country's rules by default, and nothing here guesses at a
tax requirement it could not verify.**

---

## 1. Architecture

```
Organization → Country → (Legal Entity) → Branch/Office → Invoice
                    ↓
           Jurisdiction Profile (versioned, effective-dated)
```

Two new, additive concepts sit beside the existing `organizations → countries → branches
(offices) → departments` hierarchy (`007_org_hierarchy.sql`) without changing it:

- **Legal entity** (`legal_entities`) — the fiscal identity an office trades under: legal name,
  fiscal identifier (BIN/IIN/VAT/tax ID — the *type* is free text because the shape of an
  identifier is itself country-specific), VAT registration status, bank details, default
  currency, e-invoice status. One legal entity can cover several offices (`branches
  .legal_entity_id`, nullable). Nothing forces every company in one country to share the same
  VAT registration status — two Kazakhstan legal entities can be VAT-registered and not,
  independently.
- **Jurisdiction profile** (`jurisdiction_profiles`) — versioned, effective-dated tax and
  compliance rules for one country: tax codes and rates, required invoice fields, numbering
  and rounding rules, e-invoice requirements, locale terminology. A row is **never updated or
  deleted** — `gsi_app` has `SELECT, INSERT` only on this table, exactly like `audit_logs`
  (`009_audit_log.sql`). A law change is always a new row with a later `effectiveFrom`; the
  profile in force on a date is resolved purely by `MAX(effective_from) <= that date`.

**Existing `branches` columns (`legal_name`, `tax_id`, `vat_number`, `bank_*` from
`003_branch_profile.sql`) are untouched** and keep working exactly as before — they are what
every non-fiscal invoice and PDF still reads. `legal_entities` is a parallel, opt-in model; a
branch is not required to link to one.

## 2. Legal entity model

`legal_entities` (see `packages/shared-types/src/fiscal.ts` for the full TS shape):

| Column | Notes |
|---|---|
| `organization_id`, `country_id` | Which org/country this entity belongs to. |
| `code` | Short, unique (e.g. `GSI-KZ-1`). |
| `legal_name`, `legal_address` | Printed on fiscal invoices. |
| `fiscal_identifier_type`, `fiscal_identifier` | e.g. `'BIN'` / `'071234567890'`. |
| `vat_registered`, `vat_registration_number` | Drives which tax codes are even reachable — see §7. |
| `default_tax_code`, `default_currency` | `default_currency` **defaults from the country's verified jurisdiction profile when omitted** (KZ → KZT) — see `LegalEntityService.create()`. |
| `bank_name`, `bank_account`, `bank_swift` | Printed on the fiscal invoice instead of the TR/EN template's placeholder text. |
| `e_invoice_status` | One of `ESF_STATUSES` — see §6. |

CRUD: `apps/api/src/finance/legal-entity.service.ts`, exposed at `/api/admin/fiscal/legal-
entities` (`apps/api/src/admin/fiscal.controller.ts`). Reading needs `finance.read`; creating
or editing needs `legal_entity.manage` (admin only — see §5).

No backfill was performed from existing `branches` rows on migration: VAT registration status,
real bank IBANs and fiscal identifiers are facts about GSI's actual legal entities that only
GSI can supply, and the branch profile columns already carry `'TBC'` placeholders for exactly
this reason. Inventing them would violate the one rule this whole feature is built around.

## 3. Kazakhstan currency behavior

- A KZ legal entity created without an explicit `defaultCurrency` gets `KZT` from the seeded
  jurisdiction profile (`jurisdiction_profiles.default_document_currency`).
- A fiscal invoice's currency defaults to the legal entity's `defaultCurrency`, **not** the
  client's branch currency (the legacy invoice path still uses the client's branch currency,
  unchanged).
- Foreign-currency KZ invoices are not blocked: pass `currency` explicitly on invoice creation
  and it is honored as-is — an explicit case, not a silent default.
- `CONSOLIDATION_CURRENCY` (the group's reporting currency, still EUR by default — see
  `apps/api/src/config.ts`) is untouched; `fx_rates`/`fx_rate_on()` already carry a KZT↔EUR rate
  (`apps/api/src/db/seed-finance.ts`).

## 4. Kazakhstan tax/VAT behavior — sources

New Kazakhstan Tax Code: **Кодекс Республики Казахстан от 18.07.2025 № 214-VIII «О налогах и
других обязательных платежах в бюджет»**, ИПС «Әділет» document `K2500000214`
(<https://adilet.zan.kz/rus/docs/K2500000214>), signed 18 July 2025, in force from **1 January
2026**.

| Tax code | Rate | Basis |
|---|---|---|
| `STANDARD` | 16% | Standard VAT on domestic turnover and imports from 1 Jan 2026 (up from 12%). Corroborated independently by EY Kazakhstan, PwC Tax Summaries, Sovos, and vatcalc.com, all citing the same law. |
| `ZERO` | 0% | Export turnover. Carried forward as a longstanding, EAEU-wide VAT mechanic. **Not independently re-verified article-by-article** against the renumbered 2026 code — flagged as a limitation (§13). |
| `EXEMPT` | 0% | Seller is not VAT-registered, or turnover is exempt. Applied automatically — see §7. |

**Deliberately not modelled**: the reduced 5% rate for pharmaceuticals/medical devices/services
(rising to 10% from 2027) — GSI Kazakhstan issues inspection/laboratory services, not
pharmaceutical turnover, so adding a rate the system would never select was out of scope. The
VAT registration threshold (10,000 MCI from 2026) is a registration-eligibility fact, not an
invoicing rule, and is not modelled here either.

Electronic invoicing: kgd.gov.kz confirms registered VAT payers issue electronic invoices
through ИС ЭСФ (`esf.gov.kz`). This system never submits to it — see §6.

## 5. Permissions

Four new permission codes (`008_rbac.sql`'s catalogue, extended in `028_fiscal_compliance.sql`):

| Permission | Who | What |
|---|---|---|
| `legal_entity.read` | Everyone who has `finance.read` | See legal entities (needed to pick one when raising an invoice). |
| `legal_entity.manage` | `admin` only | Create/edit legal entities. |
| `fiscal_profile.read` | Everyone who has `finance.read` | See jurisdiction profiles. |
| `fiscal_profile.manage` | `admin` only | Add a new jurisdiction profile version. |

RLS enforces the same split at the database layer (`legal_entities_manage`,
`jurisdiction_profiles_write` policies) — the API permission check is not the only gate.

## 6. ESF readiness (electronic invoice integration boundary)

`esf_status` (on both `legal_entities.e_invoice_status` and `invoices.esf_status`):
`not_required | draft | ready | submitted | registered | corrected | additional | cancelled`.

A fiscal invoice for a VAT-registered KZ entity starts at `draft` when created (the profile
says e-invoicing is required); it is **never auto-transitioned**. `EsfService`
(`apps/api/src/finance/esf.service.ts`) exposes:

- `GET /finance/invoices/:id/esf-export` — the structured seller/buyer/line/tax data an operator
  keys into ИС ЭСФ today, or a future official integration would submit.
- `POST /finance/invoices/:id/esf-status` — records what actually happened in the real system
  (an operator enters the registration number ИС ЭСФ returned). Nothing in this codebase calls
  esf.gov.kz, and a PDF is never labelled "registered ЭСФ" unless this endpoint was told so.

## 7. Invoice fiscal snapshot

`invoices.fiscal_snapshot` (jsonb, `FiscalSnapshot` in shared-types) is built at **issue** time
(`InvoicesService.buildFiscalSnapshot`), not at creation — so a legal entity's bank details
fixed while an invoice still sits in draft are reflected correctly, per the task's own wording
("при ISSUE invoice сохранить snapshot"). It captures: legal entity (as of issue time), buyer,
jurisdiction + exact profile version used, the tax code and rate applied, supply date, document
currency, every line's net/tax/gross, the invoice's own subtotal/tax/grand total, the invoice
number, and the e-invoice requirement. Once written it is **never recomputed** — a later edit to
the legal entity or a new jurisdiction profile version cannot change it.

A **non-VAT-registered** legal entity can never have `STANDARD` (or any taxable code) applied to
its invoices: `fiscal-calc.ts`'s `resolveTaxCode()` overrides the caller's requested code with
the profile's non-taxable code whenever `legalEntity.vatRegistered === false`, so "forgot to
pass EXEMPT" can never charge VAT on an unregistered seller's behalf.

Every invoice created **without** a `legalEntityId` (every invoice before this migration, and
every one created for a country with no legal entity attached) keeps `isLegacyFiscal: true`,
`fiscalSnapshot: null` — the legacy math in `InvoicesService.create()`/`.issue()` is completely
untouched.

## 8. Other-country isolation

`InvoicesService.resolveFiscal()` throws a `400` naming `compliance_config_required` when a
legal entity's country has no **verified** jurisdiction profile on the invoice's date — it never
falls back to another country's rules, and it never lets the invoice through un-taxed by
accident. Every country other than Kazakhstan has **no row at all** in `jurisdiction_profiles`
today (no placeholder was inserted, deliberately: a placeholder claiming "TR's default currency
is X" would itself be an invented compliance fact). The legacy invoice path is available to
every country regardless, unaffected.

Adding a country safely, once its rules are verified against official sources: insert one
`jurisdiction_profiles` row (via `POST /admin/fiscal/jurisdiction-profiles`, admin-only) with
`status: 'verified'`, and create `legal_entities` rows for it. No code or schema change needed.

## 9. Historical-data safety

- `jurisdiction_profiles` rows are insert-only (no UPDATE/DELETE grant) — a rate change is
  always a new version.
- `invoices.fiscal_snapshot` freezes what was actually charged at issue time.
- `invoices.is_legacy_fiscal` marks every invoice that has no verified fiscal snapshot, rather
  than reconstructing one — the "safe legacy marker" the task asked for.
- No existing `branches`, `invoices`, `invoice_lines`, or `ledger_entries` column, row, or value
  was changed, renamed, or backfilled by this migration.

## 10. Tests

`apps/api/src/finance/fiscal-calc.spec.ts` (unit — tax code resolution and per-line rounding)
and `apps/api/test/fiscal-compliance.spec.ts` (integration — the full KZ scenario list, cross-
country isolation, immutability, RBAC, audit, PDF). See the phase report for exact counts.

## 11. Known limitations

- Zero-rating for KZ exports is carried forward from the prior code as a longstanding EAEU
  mechanic; this migration's source review could not independently re-fetch and quote the
  renumbered article text of the 2026 code for it (the standard 16% rate is independently
  corroborated by four professional tax-advisory sources citing the same law, which zero-rating
  was not).
- The KZ reduced 5%/10% medical rate and the 10,000 MCI VAT registration threshold are
  intentionally not modelled (see §4) — out of scope for GSI's service lines.
- No country other than Kazakhstan has a verified profile. Every such country is explicitly
  `compliance_config_required`, not silently assumed compliant.
- The invoice-creation web form (`InvoicesPage.tsx`) does not yet offer a legal-entity/tax-code
  picker — the fiscal path is fully reachable via the API today; wiring the web form is a
  follow-up, not attempted here to avoid destabilizing the existing, tested invoice UI under
  this task's scope.
- `legal_entities` backfill from existing branches was deliberately not performed (§2) — an
  admin must create/link legal entities through `/admin/fiscal` (or the API) as real fiscal data
  becomes available.
