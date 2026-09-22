-- =====================================================================================
-- GSI ERP — MVP-1 initial schema
-- Entities: docs/01-architecture.md ("Модель данных — ключевые сущности").
--
-- Multi-branch model: every business table carries branch_id and is protected by
-- PostgreSQL Row-Level Security. The API connects as the non-owner role `gsi_app`
-- and, inside every transaction, sets:
--     app.user_id / app.branch_id / app.role   (set_config(..., is_local => true))
-- Policies read these through app_*() helpers. Without that context no rows are visible.
-- Migrations and seeds run as the schema owner, which bypasses RLS.
-- =====================================================================================

-- ---------- Enum types (mirror packages/shared-types/src/enums.ts) --------------------
CREATE TYPE user_role AS ENUM (
  'inspector', 'lab_technician', 'supervisor', 'finance_controller', 'cfo', 'client', 'admin'
);
CREATE TYPE job_status AS ENUM ('new', 'assigned', 'in_progress', 'under_review', 'approved', 'cancelled');
CREATE TYPE service_type AS ENUM (
  'weight_supervision', 'quality_supervision', 'sampling', 'loading_discharge', 'cleanliness', 'fumigation'
);
CREATE TYPE checklist_result AS ENUM ('ok', 'deviation', 'na');
CREATE TYPE checklist_input_kind AS ENUM ('check', 'text', 'number');
CREATE TYPE media_type AS ENUM ('photo', 'video');
CREATE TYPE report_status AS ENUM ('draft', 'issued', 'revoked');

-- ---------- Session context helpers --------------------------------------------------
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app_branch_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.branch_id', true), '')::uuid $$;

CREATE FUNCTION app_role() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.role', true), '') $$;

-- HQ roles see every branch ("HQ видит всё"). Keep in sync with HQ_ROLES in shared-types.
CREATE FUNCTION app_is_hq() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT COALESCE(app_role() IN ('admin', 'cfo'), false) $$;

CREATE FUNCTION trg_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Child rows of a job always inherit the job's branch_id (callers never supply it).
-- The lookup runs under the caller's RLS, so an invisible job yields NULL → NOT NULL violation.
CREATE FUNCTION trg_inherit_job_branch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.branch_id := (SELECT j.branch_id FROM inspection_jobs j WHERE j.id = NEW.job_id);
  RETURN NEW;
END $$;

-- ---------- branches -----------------------------------------------------------------
CREATE TABLE branches (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                    text NOT NULL UNIQUE CHECK (code ~ '^[A-Z]{2,3}$'),
  country                 char(2) NOT NULL,              -- ISO 3166-1 alpha-2
  city                    text NOT NULL,
  currency                char(3) NOT NULL,              -- ISO 4217, accounting currency
  locale                  text NOT NULL,                 -- default locale, e.g. 'tr'
  ui_locales              text[] NOT NULL DEFAULT '{en}',
  timezone                text NOT NULL,                 -- IANA, e.g. 'Europe/Istanbul'
  legal_name              text NOT NULL,
  address                 text,
  phone                   text,
  email                   text,
  accreditation           text,
  is_hq                   boolean NOT NULL DEFAULT false,
  -- Spec names this letterhead_template_id. MVP-1 keeps templates in code
  -- (apps/api/src/documents/templates), so this is a template key, not an FK.
  letterhead_template_id  text NOT NULL DEFAULT 'tr-default',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER branches_updated_at BEFORE UPDATE ON branches FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ---------- users --------------------------------------------------------------------
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      uuid NOT NULL REFERENCES branches(id),
  email          text NOT NULL,
  password_hash  text NOT NULL,
  full_name      text NOT NULL,
  role           user_role NOT NULL,
  locale         text NOT NULL DEFAULT 'en',
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, branch_id)               -- target for composite FKs (same-branch guarantees)
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE INDEX users_branch_role_idx ON users (branch_id, role);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ---------- clients (CRM / контрагенты) ----------------------------------------------
-- ASSUMPTION: a client belongs to exactly one branch (the branch that serves it).
-- Group-wide client dedup across branches is out of scope for MVP-1.
CREATE TABLE clients (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id        uuid NOT NULL REFERENCES branches(id),
  name             text NOT NULL,
  gafta_fosfa_ref  text,
  tax_id           text,
  country          char(2),
  address          text,
  contact_name     text,
  contact_email    text,
  contact_phone    text,
  notes            text,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, branch_id)
);
CREATE INDEX clients_branch_name_idx ON clients (branch_id, lower(name));
CREATE TRIGGER clients_updated_at BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ---------- inspection_jobs ----------------------------------------------------------
CREATE TABLE inspection_jobs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id              uuid NOT NULL REFERENCES branches(id),
  job_number             text NOT NULL UNIQUE,
  client_id              uuid NOT NULL,
  type                   service_type NOT NULL,
  status                 job_status NOT NULL DEFAULT 'new',
  assigned_inspector_id  uuid,
  location               text NOT NULL,
  vessel_or_object       text,
  commodity              text,
  quantity               text,
  scheduled_at           timestamptz,
  instructions           text,
  review_comment         text,
  submitted_at           timestamptz,
  approved_at            timestamptz,
  approved_by            uuid REFERENCES users(id),
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, branch_id),
  -- Client and inspector must belong to the same branch as the job.
  FOREIGN KEY (client_id, branch_id) REFERENCES clients (id, branch_id) ON DELETE RESTRICT,
  FOREIGN KEY (assigned_inspector_id, branch_id) REFERENCES users (id, branch_id)
);
CREATE INDEX jobs_branch_status_idx ON inspection_jobs (branch_id, status);
CREATE INDEX jobs_client_idx ON inspection_jobs (client_id);
CREATE INDEX jobs_inspector_idx ON inspection_jobs (assigned_inspector_id);
CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON inspection_jobs FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ---------- job_checklist_items ------------------------------------------------------
-- label / input_kind / template_version are snapshotted from the template at job creation
-- so later template edits never alter what the inspector saw (ISO 17020 traceability).
CREATE TABLE job_checklist_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id         uuid NOT NULL,
  job_id            uuid NOT NULL,
  item_key          text NOT NULL,
  label             jsonb NOT NULL,
  input_kind        checklist_input_kind NOT NULL DEFAULT 'check',
  template_version  text NOT NULL,
  sort_order        integer NOT NULL DEFAULT 0,
  result            checklist_result,
  value             text,
  notes             text,
  updated_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, item_key),
  UNIQUE (id, branch_id),
  FOREIGN KEY (job_id, branch_id) REFERENCES inspection_jobs (id, branch_id) ON DELETE CASCADE
);
CREATE TRIGGER checklist_branch BEFORE INSERT ON job_checklist_items FOR EACH ROW EXECUTE FUNCTION trg_inherit_job_branch();
CREATE TRIGGER checklist_updated_at BEFORE UPDATE ON job_checklist_items FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ---------- media_attachments --------------------------------------------------------
-- Spec lists `url`; we store the object key and issue short-lived presigned URLs instead,
-- so media never becomes publicly reachable. Originals are kept untouched (sha256 recorded)
-- for ISO 17020 audit; `preview_key` is a downscaled JPEG for UI and PDF.
CREATE TABLE media_attachments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id          uuid NOT NULL,
  job_id             uuid NOT NULL,
  checklist_item_id  uuid,
  type               media_type NOT NULL DEFAULT 'photo',
  storage_key        text NOT NULL,
  preview_key        text,
  mime_type          text NOT NULL,
  size_bytes         bigint NOT NULL,
  sha256             char(64) NOT NULL,
  original_name      text,
  gps_lat            double precision CHECK (gps_lat BETWEEN -90 AND 90),
  gps_lng            double precision CHECK (gps_lng BETWEEN -180 AND 180),
  gps_accuracy_m     real,
  taken_at           timestamptz,
  uploaded_by        uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, branch_id) REFERENCES inspection_jobs (id, branch_id) ON DELETE CASCADE,
  FOREIGN KEY (checklist_item_id, branch_id) REFERENCES job_checklist_items (id, branch_id) ON DELETE CASCADE
);
CREATE INDEX media_job_idx ON media_attachments (job_id, checklist_item_id);
CREATE TRIGGER media_branch BEFORE INSERT ON media_attachments FOR EACH ROW EXECUTE FUNCTION trg_inherit_job_branch();

-- ---------- reports ------------------------------------------------------------------
CREATE TABLE reports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id          uuid NOT NULL,
  job_id             uuid NOT NULL,
  report_number      text NOT NULL UNIQUE,
  version            integer NOT NULL DEFAULT 1,
  status             report_status NOT NULL DEFAULT 'issued',
  template_id        text NOT NULL,
  locale             text NOT NULL,
  pdf_storage_key    text,
  pdf_sha256         char(64),
  approved_by        uuid REFERENCES users(id),
  approved_at        timestamptz,
  -- Spec: qr_code. Holds the unguessable verification token encoded into the QR code;
  -- the QR itself is rendered from it (PUBLIC_WEB_URL/verify/<token>).
  qr_code            text NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, version),
  FOREIGN KEY (job_id, branch_id) REFERENCES inspection_jobs (id, branch_id) ON DELETE RESTRICT
);
CREATE INDEX reports_branch_idx ON reports (branch_id, created_at DESC);
CREATE TRIGGER reports_branch BEFORE INSERT ON reports FOR EACH ROW EXECUTE FUNCTION trg_inherit_job_branch();

-- ---------- document numbering -------------------------------------------------------
-- ASSUMPTION: numbering format <BRANCH>-<KIND>-<YEAR>-<5 digits>, e.g. TR-R-2026-00042,
-- restarting yearly per branch. Replace once GSI shares its current numbering (open question #4).
CREATE TABLE doc_counters (
  branch_id   uuid NOT NULL REFERENCES branches(id),
  kind        text NOT NULL,
  year        integer NOT NULL,
  last_value  integer NOT NULL,
  PRIMARY KEY (branch_id, kind, year)
);

CREATE FUNCTION next_doc_number(p_branch uuid, p_kind text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code text;
  v_year integer := EXTRACT(YEAR FROM now())::integer;
  v_n integer;
BEGIN
  IF NOT (app_is_hq() OR p_branch = app_branch_id()) THEN
    RAISE EXCEPTION 'branch access denied' USING ERRCODE = '42501';
  END IF;
  SELECT code INTO v_code FROM branches WHERE id = p_branch;
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'unknown branch %', p_branch;
  END IF;
  INSERT INTO doc_counters AS c (branch_id, kind, year, last_value)
  VALUES (p_branch, p_kind, v_year, 1)
  ON CONFLICT (branch_id, kind, year) DO UPDATE SET last_value = c.last_value + 1
  RETURNING last_value INTO v_n;
  RETURN format('%s-%s-%s-%s', v_code, p_kind, v_year, lpad(v_n::text, 5, '0'));
END $$;

-- ---------- functions that must see across branches ----------------------------------
-- Login happens before any branch context exists.
CREATE FUNCTION auth_find_user(p_email text, p_id uuid)
RETURNS TABLE (id uuid, branch_id uuid, role user_role, email text, password_hash text,
               full_name text, locale text, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, u.branch_id, u.role, u.email, u.password_hash, u.full_name, u.locale, u.is_active
  FROM users u
  WHERE (p_email IS NOT NULL AND lower(u.email) = lower(p_email))
     OR (p_id IS NOT NULL AND u.id = p_id)
  LIMIT 1
$$;

-- Third-party verification of a report by the token printed in its QR code.
-- ASSUMPTION: exposing report number, issue date, branch, service and client name to whoever
-- holds the token is acceptable (the token is only printed on the document itself).
CREATE FUNCTION public_verify_report(p_token text)
RETURNS TABLE (report_number text, status report_status, issued_at timestamptz, branch text,
               job_number text, service_type service_type, client_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.report_number, r.status, r.approved_at, b.legal_name, j.job_number, j.type, c.name
  FROM reports r
  JOIN inspection_jobs j ON j.id = r.job_id
  JOIN clients c ON c.id = j.client_id
  JOIN branches b ON b.id = r.branch_id
  WHERE r.qr_code = p_token
$$;

REVOKE ALL ON FUNCTION next_doc_number(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_find_user(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_verify_report(text) FROM PUBLIC;

-- ---------- Row-Level Security -------------------------------------------------------
ALTER TABLE branches            ENABLE ROW LEVEL SECURITY;
ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients             ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_jobs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_attachments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports             ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_counters        ENABLE ROW LEVEL SECURITY;  -- no policies: only via next_doc_number()

CREATE POLICY branches_read ON branches FOR SELECT
  USING (app_is_hq() OR id = app_branch_id());
CREATE POLICY branches_admin ON branches FOR ALL
  USING (app_role() = 'admin') WITH CHECK (app_role() = 'admin');

CREATE POLICY users_read ON users FOR SELECT
  USING (app_is_hq() OR branch_id = app_branch_id());
CREATE POLICY users_admin ON users FOR ALL
  USING (app_role() = 'admin') WITH CHECK (app_role() = 'admin');

CREATE POLICY clients_branch ON clients FOR ALL
  USING (app_is_hq() OR branch_id = app_branch_id())
  WITH CHECK (app_is_hq() OR branch_id = app_branch_id());

-- Inspectors additionally see only jobs assigned to them ("только свои задания").
CREATE POLICY jobs_branch ON inspection_jobs FOR ALL
  USING (
    app_is_hq()
    OR (branch_id = app_branch_id()
        AND (app_role() <> 'inspector' OR assigned_inspector_id = app_user_id()))
  )
  WITH CHECK (app_is_hq() OR branch_id = app_branch_id());

-- Child tables: branch check + the parent job must be visible (inherits the inspector rule).
CREATE POLICY checklist_branch ON job_checklist_items FOR ALL
  USING ((app_is_hq() OR branch_id = app_branch_id())
         AND EXISTS (SELECT 1 FROM inspection_jobs j WHERE j.id = job_checklist_items.job_id))
  WITH CHECK ((app_is_hq() OR branch_id = app_branch_id())
         AND EXISTS (SELECT 1 FROM inspection_jobs j WHERE j.id = job_checklist_items.job_id));

CREATE POLICY media_branch ON media_attachments FOR ALL
  USING ((app_is_hq() OR branch_id = app_branch_id())
         AND EXISTS (SELECT 1 FROM inspection_jobs j WHERE j.id = media_attachments.job_id))
  WITH CHECK ((app_is_hq() OR branch_id = app_branch_id())
         AND EXISTS (SELECT 1 FROM inspection_jobs j WHERE j.id = media_attachments.job_id));

CREATE POLICY reports_branch ON reports FOR ALL
  USING ((app_is_hq() OR branch_id = app_branch_id())
         AND EXISTS (SELECT 1 FROM inspection_jobs j WHERE j.id = reports.job_id))
  WITH CHECK ((app_is_hq() OR branch_id = app_branch_id())
         AND EXISTS (SELECT 1 FROM inspection_jobs j WHERE j.id = reports.job_id));

-- ---------- Grants for the application role ------------------------------------------
-- `gsi_app` is created by the migration runner (src/db/migrate.ts) before this file runs.
GRANT USAGE ON SCHEMA public TO gsi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  branches, users, clients, inspection_jobs, job_checklist_items, media_attachments, reports
  TO gsi_app;
GRANT EXECUTE ON FUNCTION next_doc_number(uuid, text), auth_find_user(text, uuid),
  public_verify_report(text) TO gsi_app;
