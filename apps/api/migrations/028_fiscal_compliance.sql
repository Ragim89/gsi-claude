-- ---------------------------------------------------------------------------------------
-- 028. Multi-country finance compliance: legal entities and versioned jurisdiction profiles.
--
-- Until now a branch's fiscal identity was a handful of flat columns (003_branch_profile:
-- tax_id, vat_number, bank_*) and an invoice's tax was one caller-supplied percentage
-- (002_finance: invoices.tax_rate). That works as long as every country is taxed the same
-- way, which is exactly the assumption a real multi-country group cannot make: Kazakhstan's
-- VAT rate, registration rules and required invoice fields are not Turkey's or Romania's,
-- and they change on their own government's schedule, not GSI's.
--
-- Two new concepts, both additive — nothing existing is renamed, dropped or backfilled with
-- invented data:
--
--  * `legal_entities` — the fiscal identity a branch trades under (legal name, fiscal
--    identifier, VAT registration status, bank details, default currency). One legal entity
--    can cover several offices; a branch may optionally point at one via legal_entity_id.
--    This is the "minimal safe abstraction" the task asked for: it sits beside the existing
--    organization → country → branch hierarchy without touching it.
--
--  * `jurisdiction_profiles` — versioned, effective-dated tax/compliance rules per country
--    (tax codes and rates, required invoice fields, numbering/rounding rules, e-invoice
--    requirements). A row, once written, is never updated or deleted — a law change is a new
--    row with a later effective_from, enforced by GRANT (no UPDATE/DELETE for gsi_app) the
--    same way audit_logs is append-only. An invoice records which profile *version* it used,
--    so a future rate change can never alter a document already issued.
--
-- Only Kazakhstan gets a verified profile in this migration (see the seed below for sources).
-- Every other country simply has no row — resolveJurisdictionProfile() then returns nothing
-- and the API refuses to create a "fiscal" invoice for it (explicit compliance_config_required
-- error) rather than guessing or silently applying KZ's rules. Existing invoice creation
-- (no legal_entity_id given) is completely untouched: see the additive columns on `invoices`
-- below, all nullable, defaulting to the "legacy" shape every existing and future non-fiscal
-- invoice keeps using.
-- ---------------------------------------------------------------------------------------

CREATE TYPE esf_status AS ENUM (
  'not_required', 'draft', 'ready', 'submitted', 'registered', 'corrected', 'additional', 'cancelled'
);

CREATE TYPE jurisdiction_profile_status AS ENUM ('verified', 'compliance_config_required');

-- ---------- legal_entities -------------------------------------------------------------
CREATE TABLE legal_entities (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES organizations(id),
  country_id               uuid NOT NULL REFERENCES countries(id),
  code                     text NOT NULL UNIQUE,
  legal_name               text NOT NULL,
  legal_address            text,
  /** Free text on purpose: 'BIN' (KZ), 'IIN' (KZ sole proprietor), 'VAT', 'TAX_ID' … — the
      shape of a fiscal identifier is itself country-specific and this is reference metadata,
      not a value this migration should constrain to what one country happens to use. */
  fiscal_identifier_type   text,
  fiscal_identifier        text,
  vat_registered           boolean NOT NULL DEFAULT false,
  vat_registration_number  text,
  /** A code from the applicable jurisdiction profile's config->'taxCodes', e.g. 'STANDARD'. */
  default_tax_code         text,
  default_currency         char(3) NOT NULL,
  bank_name                text,
  bank_account             text,
  bank_swift               text,
  invoice_number_prefix    text,
  e_invoice_status         esf_status NOT NULL DEFAULT 'not_required',
  is_active                boolean NOT NULL DEFAULT true,
  created_by               uuid REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER legal_entities_updated_at BEFORE UPDATE ON legal_entities
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE INDEX legal_entities_country_idx ON legal_entities (country_id);
CREATE INDEX legal_entities_org_idx ON legal_entities (organization_id);

-- An office may declare which legal entity it trades under. Nullable and additive: a branch
-- with no legal_entity_id keeps working exactly as before (the legacy invoice path).
ALTER TABLE branches ADD COLUMN legal_entity_id uuid REFERENCES legal_entities(id);
CREATE INDEX branches_legal_entity_idx ON branches (legal_entity_id);

ALTER TABLE legal_entities ENABLE ROW LEVEL SECURITY;
-- Same visibility as other money-adjacent reference data: whoever may see finance figures may
-- see which legal entities exist (needed to pick one when raising an invoice); changing one is
-- a distinct, narrower permission so an ordinary finance/inspector/lab user cannot.
CREATE POLICY legal_entities_read ON legal_entities FOR SELECT USING (app_has_perm('finance.read'));
CREATE POLICY legal_entities_manage ON legal_entities FOR ALL
  USING (app_has_perm('legal_entity.manage')) WITH CHECK (app_has_perm('legal_entity.manage'));
GRANT SELECT, INSERT, UPDATE ON legal_entities TO gsi_app;
-- Deliberately no DELETE grant: retire a legal entity with is_active = false, never remove the
-- row a historical invoice's fiscal_snapshot refers to.

-- ---------- jurisdiction_profiles -------------------------------------------------------
CREATE TABLE jurisdiction_profiles (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code               char(2) NOT NULL,
  profile_version            integer NOT NULL,
  status                     jurisdiction_profile_status NOT NULL,
  effective_from             date NOT NULL,
  /** Informational only — NEVER required for resolution (see resolveJurisdictionProfile()):
      the profile in force on a date is simply the row with the latest effective_from on or
      before it. Kept nullable because gsi_app has no UPDATE grant on this table (below), so
      a row can only ever record an end date it already knew about at insert time (e.g. a
      rate known in advance to expire); it is never retroactively closed off by the next
      version's insert. */
  effective_to               date,
  default_document_currency  char(3) NOT NULL,
  /** Tax codes/rates, required invoice fields, numbering, rounding, e-invoice requirements,
      locale terminology — see packages/shared-types/src/fiscal.ts JurisdictionProfileConfig
      for the shape, and docs/FISCAL_COMPLIANCE.md for how to read/extend it. */
  config                     jsonb NOT NULL,
  /** Where the rates and rules above were verified, for the next person who has to trust or
      re-check them. Required for a 'verified' profile; may be sparse for a placeholder. */
  source_notes               text,
  created_by                 uuid REFERENCES users(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country_code, profile_version),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
-- The profile in force on a given date is resolved purely by effective_from — see the note on
-- that column above. No uniqueness constraint on "the open one" is needed or possible here: a
-- law change is a brand-new row with a later effective_from, and the previous row is never
-- touched (gsi_app has no UPDATE grant on this table — see below).
CREATE INDEX jurisdiction_profiles_lookup_idx ON jurisdiction_profiles (country_code, effective_from DESC);

ALTER TABLE jurisdiction_profiles ENABLE ROW LEVEL SECURITY;
-- Reference/compliance data: every authenticated user may read which rules apply to which
-- country (the invoice PDF and the admin screen both need this, and there is nothing secret
-- about a country's own published tax law). Only an explicit permission may add a new version.
CREATE POLICY jurisdiction_profiles_read ON jurisdiction_profiles FOR SELECT USING (app_role() IS NOT NULL);
CREATE POLICY jurisdiction_profiles_write ON jurisdiction_profiles FOR INSERT
  WITH CHECK (app_has_perm('fiscal_profile.manage'));
GRANT SELECT, INSERT ON jurisdiction_profiles TO gsi_app;
-- Deliberately no UPDATE or DELETE grant — exactly the audit_logs pattern (009_audit_log.sql):
-- a profile version is a historical fact once written. A law change is a new row.

-- ---------- invoices: optional fiscal snapshot ------------------------------------------
-- Every column below is nullable (or defaults to the "legacy" value) so that every existing
-- invoice, and every future invoice created without a legal_entity_id, is completely
-- unaffected: same columns used, same values, same behavior as before this migration.
ALTER TABLE invoices
  ADD COLUMN legal_entity_id             uuid REFERENCES legal_entities(id),
  ADD COLUMN jurisdiction_country_code   char(2),
  ADD COLUMN jurisdiction_profile_id     uuid REFERENCES jurisdiction_profiles(id),
  ADD COLUMN jurisdiction_profile_version integer,
  ADD COLUMN tax_code                    text,
  /** true = no verified fiscal profile was used to build this invoice (every invoice created
      before this migration, and every one created for a country with no verified jurisdiction
      profile). This is the "safe legacy marker" the task requires instead of guessing at
      historical tax data. Only the fiscal invoice-creation path below ever sets it false. */
  ADD COLUMN is_legacy_fiscal            boolean NOT NULL DEFAULT true,
  /** Immutable at issue time: legal entity, jurisdiction + version, seller/buyer fiscal data,
      per-line net/tax/gross, totals, numbering context, bank/e-invoice details — everything
      needed to reconstruct exactly what was charged and why, even if the legal entity or the
      jurisdiction profile changes later. NULL for legacy invoices (nothing to snapshot). */
  ADD COLUMN fiscal_snapshot             jsonb,
  ADD COLUMN esf_status                  esf_status NOT NULL DEFAULT 'not_required',
  ADD COLUMN esf_registration_number     text,
  ADD COLUMN esf_submitted_at            timestamptz,
  ADD COLUMN esf_registered_at           timestamptz;

CREATE INDEX invoices_legal_entity_idx ON invoices (legal_entity_id) WHERE legal_entity_id IS NOT NULL;

-- New permissions (packages/shared-types/src/rbac.ts PERMISSIONS mirrors this list).
INSERT INTO permissions (code, category, description) VALUES
  ('legal_entity.read',    'finance', 'See legal entities and their fiscal profile'),
  ('legal_entity.manage',  'finance', 'Create and edit legal entities'),
  ('fiscal_profile.read',  'finance', 'See jurisdiction/tax compliance profiles'),
  ('fiscal_profile.manage','finance', 'Add a new version of a jurisdiction/tax compliance profile');

-- legal_entity.read / fiscal_profile.read ride along with finance.read (RLS already gates
-- legal_entities/jurisdiction_profiles reads that way); granting the explicit codes too keeps
-- the permission catalogue honest for any UI that checks by code rather than by table access.
INSERT INTO role_permissions (role_code, permission_code)
SELECT r.code, p.code
FROM roles r, (VALUES ('legal_entity.read'), ('fiscal_profile.read')) AS p(code)
WHERE r.code IN (SELECT role_code FROM role_permissions WHERE permission_code = 'finance.read');

-- legal_entity.manage / fiscal_profile.manage: HQ/Admin only, per the task's explicit scope —
-- an ordinary finance controller, inspector or lab role must not change jurisdiction rules.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'admin', code FROM (VALUES ('legal_entity.manage'), ('fiscal_profile.manage')) AS p(code);

-- ---------- Kazakhstan — first verified rule pack ---------------------------------------
-- Sources (see docs/FISCAL_COMPLIANCE.md for the full citation trail):
--  * Кодекс Республики Казахстан от 18.07.2025 № 214-VIII «О налогах и других обязательных
--    платежах в бюджет» (new Tax Code), ИПС «Әділет» document K2500000214
--    (https://adilet.zan.kz/rus/docs/K2500000214), in force from 1 January 2026.
--  * Standard VAT rate 12% → 16% from 1 January 2026, corroborated independently by EY
--    Kazakhstan, PwC Tax Summaries, Sovos and vatcalc.com's coverage of the same law.
--  * Zero-rating of export turnover is carried forward as a structural, EAEU-wide VAT
--    mechanic; this migration could not independently re-fetch the renumbered article text
--    of the new code for it, so it is marked accordingly in source_notes — treat the 0% code
--    as high-confidence, not independently re-verified article-by-article.
--  * The reduced 5% rate (pharmaceuticals/medical devices/services in 2026, 10% from 2027) is
--    intentionally NOT included: GSI Kazakhstan issues inspection/laboratory services, not
--    pharmaceutical turnover, and adding a rate this system would never select is scope this
--    task did not ask for. Extending KZ's profile to it later is a new profile version, not a
--    schema change.
--  * ИС ЭСФ (electronic invoice) system: kgd.gov.kz confirms registered VAT payers issue
--    electronic invoices through the state system (esf.gov.kz); this migration only records
--    e-invoice *requirement*, never a submission — see esf_status above and
--    docs/FISCAL_COMPLIANCE.md §ESF readiness.
INSERT INTO jurisdiction_profiles
  (country_code, profile_version, status, effective_from, effective_to, default_document_currency, config, source_notes)
VALUES (
  'KZ', 1, 'verified', '2026-01-01', NULL, 'KZT',
  jsonb_build_object(
    'taxCodes', jsonb_build_array(
      jsonb_build_object('code', 'STANDARD', 'label', 'НДС 16% / VAT 16%', 'rate', 16, 'kind', 'standard',
        'notes', 'Standard rate on domestic turnover and imports, Tax Code №214-VIII, effective 2026-01-01.'),
      jsonb_build_object('code', 'ZERO', 'label', 'НДС 0% (экспорт) / VAT 0% (export)', 'rate', 0, 'kind', 'zero',
        'notes', 'Zero-rated export turnover; EAEU-wide mechanic carried forward from the prior code.'),
      jsonb_build_object('code', 'EXEMPT', 'label', 'Без НДС / Non-taxable', 'rate', 0, 'kind', 'no_tax',
        'notes', 'Seller is not VAT-registered, or turnover is exempt; no VAT is charged or shown.')
    ),
    'invoiceRequiredFields', jsonb_build_array('sellerFiscalId', 'sellerLegalAddress', 'supplyDate', 'invoiceNumber'),
    'sellerFiscalIdentifierLabel', 'БИН / BIN',
    'buyerFiscalIdentifierLabel', 'БИН/ИИН / BIN/IIN',
    'supplyDateRequired', true,
    'numberingRules', jsonb_build_object('resetPeriod', 'year', 'description', 'Existing next_doc_number(): <BRANCH>-I-<YEAR>-NNNNN; unchanged by this profile.'),
    'roundingRule', jsonb_build_object('decimals', 2, 'mode', 'half_up'),
    'bankPaymentRequirements', jsonb_build_array('bankName', 'iban', 'bic'),
    'eInvoice', jsonb_build_object('required', true, 'system', 'ИС ЭСФ (esf.gov.kz)',
      'description', 'Required for VAT-registered legal entities per KGD guidance; this system never submits — see esf_status.'),
    'locale', jsonb_build_object('documentTerm', jsonb_build_object('ru', 'Счет-фактура', 'en', 'Invoice'), 'defaultLocale', 'ru'),
    'sourceCitations', jsonb_build_array(
      'Кодекс РК от 18.07.2025 №214-VIII, adilet.zan.kz/rus/docs/K2500000214, в силе с 01.01.2026',
      'EY Kazakhstan tax alert on the new Tax Code (ey.com/en_kz)',
      'PwC Tax Summaries — Kazakhstan, Corporate — Other taxes (taxsummaries.pwc.com/kazakhstan)',
      'Sovos — Kazakhstan Adjusts VAT Rates (sovos.com/regulatory-updates/vat)',
      'vatcalc.com — Kazakhstan VAT rise to 16% Jan 2026'
    )
  ),
  'Standard 16% rate independently corroborated by EY/PwC/Sovos/vatcalc citing the same law (K2500000214). '
  || 'Zero-rating for exports carried forward as a longstanding EAEU mechanic, not re-verified article-by-article '
  || 'in the renumbered 2026 code — flagged as a limitation. Reduced 5% medical rate deliberately not modelled '
  || '(out of scope for GSI''s service lines). ESF requirement confirmed via kgd.gov.kz; no submission is simulated.'
);
