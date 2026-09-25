/**
 * PHASE 7 — Reports and certificates.
 *
 * The reports module already existed and worked: 520 issued PDFs, a number from
 * `next_doc_number`, a sha256, a QR token and a public verification function. Nothing here
 * replaces any of that. This migration turns a document that was *issued in one step by job
 * approval* into a document with a life of its own — prepared, reviewed, approved, issued,
 * and corrected only by a new revision that leaves the issued one exactly as it was.
 *
 * Three things are deliberate:
 *
 *   1. **Legacy documents stay valid.** Every existing report keeps its number, its stored
 *      PDF, its checksum and its QR token, and gets one version row describing what is
 *      actually known about it. What was never recorded — which data went into it, which
 *      template version rendered it — stays NULL and is marked `is_legacy`. A snapshot
 *      invented today would be a lie about a document signed last year.
 *
 *   2. **What a document says is frozen when it is issued.** `report_versions.data_snapshot`
 *      holds the facts as they were: client, job, inspection, samples, released results with
 *      their methods, limits and units. Editing a method next year cannot change a certificate
 *      issued this year, because the certificate no longer reads from the method.
 *
 *   3. **The tail of PHASE 6.** `test_results.numeric_text` records the value as the analyst
 *      typed it. `numeric(18,6)` stores 12.40 and 12.4 as the same number, and on a certificate
 *      they are not the same statement: the trailing zero says how precisely it was measured.
 *      The number stays numeric for arithmetic; the text is what a document prints.
 */

-- ---------- Document kinds ------------------------------------------------------------------

CREATE TYPE report_kind AS ENUM (
  'inspection_report',
  'survey_report',
  'laboratory_report',
  'certificate_of_analysis',
  'certificate',
  'sampling_report',
  'custom'
);


-- ---------- Templates -----------------------------------------------------------------------

/**
 * A template is data, not a React component: sections in order, each with its own options.
 * Rendering reads this; adding a document type does not mean writing another screen.
 *
 * Templates are versioned and never edited in place once something has been issued with them —
 * a document must be reproducible, and that means the layout it was printed with has to still
 * exist. `organization_id` is deliberately absent: the group is reachable through the branch,
 * and a column with the same value in every row is not information.
 */
CREATE TABLE report_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL,
  name            text NOT NULL,
  report_type     report_kind NOT NULL,
  /** NULL means the whole group; a branch id means this office prints its own form. */
  branch_id       uuid REFERENCES branches(id),
  /** NULL means the template renders in whatever language the document is written in. */
  language        text,
  version         integer NOT NULL DEFAULT 1,
  is_active       boolean NOT NULL DEFAULT true,
  /** Sections, their order and their options. See docs/WORKFLOWS.md. */
  definition      jsonb NOT NULL DEFAULT '{"sections": []}'::jsonb,
  description     text,
  effective_from  date NOT NULL DEFAULT current_date,
  retired_at      timestamptz,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);
CREATE INDEX report_templates_type_idx ON report_templates (report_type, is_active);

/**
 * A template version is raised by the database, exactly as a laboratory method's is: change
 * what the document looks like or what it contains, and anything already issued keeps pointing
 * at the version it was printed with.
 */
CREATE FUNCTION trg_bump_template_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.definition IS DISTINCT FROM OLD.definition
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.report_type IS DISTINCT FROM OLD.report_type
     OR NEW.language IS DISTINCT FROM OLD.language THEN
    NEW.version := OLD.version + 1;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER report_templates_version BEFORE UPDATE ON report_templates
  FOR EACH ROW EXECUTE FUNCTION trg_bump_template_version();

-- ---------- The document ---------------------------------------------------------------------

ALTER TABLE reports
  ADD COLUMN report_type         report_kind NOT NULL DEFAULT 'inspection_report',
  ADD COLUMN title               text,
  ADD COLUMN client_id           uuid REFERENCES clients(id),
  ADD COLUMN inspection_id       uuid REFERENCES inspections(id),
  ADD COLUMN sample_id           uuid REFERENCES samples(id),
  ADD COLUMN report_template_id  uuid REFERENCES report_templates(id),
  ADD COLUMN prepared_by         uuid REFERENCES users(id),
  ADD COLUMN prepared_at         timestamptz,
  ADD COLUMN submitted_at        timestamptz,
  ADD COLUMN reviewed_by         uuid REFERENCES users(id),
  ADD COLUMN reviewed_at         timestamptz,
  ADD COLUMN issued_by           uuid REFERENCES users(id),
  ADD COLUMN issued_at           timestamptz,
  ADD COLUMN cancel_reason       text,
  ADD COLUMN deleted_at          timestamptz;

COMMENT ON COLUMN reports.version IS
  'The current revision number of this document. Revision 1 is the first issue.';

/**
 * One report per job per version was the old rule, and it is wrong now: a job legitimately
 * carries an inspection report *and* a certificate of analysis, each with its own revisions.
 * Uniqueness that still matters — the report number and the QR token — is untouched.
 */
ALTER TABLE reports DROP CONSTRAINT reports_job_id_version_key;

CREATE INDEX reports_type_status_idx ON reports (report_type, status);
CREATE INDEX reports_client_idx ON reports (client_id, created_at DESC);
CREATE INDEX reports_inspection_idx ON reports (inspection_id);
CREATE INDEX reports_sample_idx ON reports (sample_id);

-- What is knowable about the documents that already exist, and nothing more.
UPDATE reports r SET
  client_id   = j.client_id,
  prepared_by = r.approved_by,
  prepared_at = r.created_at,
  issued_by   = r.approved_by,
  issued_at   = r.approved_at,
  title       = j.job_number || ' — inspection report'
FROM inspection_jobs j
WHERE j.id = r.job_id;

-- ---------- Versions: what was issued, exactly ------------------------------------------------

/**
 * One row per revision. The content (what a person wrote and chose) and the data snapshot
 * (what the system had at the moment of issue) are separate on purpose: the first is authored,
 * the second is evidence.
 *
 * Rows for issued revisions are never updated by the application — the grants below allow it
 * for the drafting stage only, and the service refuses once `issued_at` is set.
 */
CREATE TABLE report_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id           uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  branch_id           uuid NOT NULL REFERENCES branches(id),
  version_number      integer NOT NULL,
  status              report_status NOT NULL DEFAULT 'draft',

  /** Narrative and choices: summary, observations, conclusions, chosen photos, options. */
  content             jsonb NOT NULL DEFAULT '{}'::jsonb,
  /** The facts, frozen at issue. NULL while the revision is still being written. */
  data_snapshot       jsonb,
  language            text NOT NULL DEFAULT 'en',

  template_id         uuid REFERENCES report_templates(id),
  template_code       text,
  template_version    integer,

  pdf_storage_key     text,
  pdf_sha256          char(64),
  pdf_bytes           bigint,

  prepared_by         uuid REFERENCES users(id),
  prepared_at         timestamptz NOT NULL DEFAULT now(),
  submitted_by        uuid REFERENCES users(id),
  submitted_at        timestamptz,
  reviewed_by         uuid REFERENCES users(id),
  reviewed_at         timestamptz,
  review_comment      text,
  approved_by         uuid REFERENCES users(id),
  approved_at         timestamptz,
  issued_by           uuid REFERENCES users(id),
  issued_at           timestamptz,

  /**
   * Each issued revision carries its own verification token, because each was printed and sent
   * separately. Scanning the copy somebody is holding has to say what *that* copy is — valid,
   * or superseded by a later revision — and one token per document could not tell them apart.
   */
  qr_token            text UNIQUE,
  /** Why this revision exists. Mandatory for every revision after the first. */
  revision_reason     text,
  /** A document issued before this module existed: number, PDF and QR are real, the rest unknown. */
  is_legacy           boolean NOT NULL DEFAULT false,
  lock_version        integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, version_number)
);
CREATE INDEX report_versions_report_idx ON report_versions (report_id, version_number DESC);

-- Every existing report becomes revision 1 of itself, described honestly.
INSERT INTO report_versions (report_id, branch_id, version_number, status, language, template_code,
                             pdf_storage_key, pdf_sha256, prepared_by, prepared_at,
                             approved_by, approved_at, issued_by, issued_at, qr_token, is_legacy)
SELECT r.id, r.branch_id, 1, r.status, r.locale, r.template_id,
       r.pdf_storage_key, r.pdf_sha256, r.approved_by, r.created_at,
       r.approved_by, r.approved_at, r.approved_by, r.approved_at, r.qr_code, true
FROM reports r;

-- ---------- History ---------------------------------------------------------------------------

/**
 * Append-only, like every other business history in this system: the application role may read
 * and insert and has no grant to update or delete.
 */
CREATE TABLE report_status_history (
  id           bigserial PRIMARY KEY,
  report_id    uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  version_number integer,
  from_status  report_status,
  to_status    report_status NOT NULL,
  changed_by   uuid REFERENCES users(id),
  reason       text,
  metadata     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_history_idx ON report_status_history (report_id, created_at);

-- One honest line for each document that already existed: it was issued, and we know when.
INSERT INTO report_status_history (report_id, version_number, from_status, to_status, changed_by, reason, created_at)
SELECT r.id, 1, NULL, r.status, r.approved_by,
       'Issued before the document workflow existed; recorded when it was introduced',
       COALESCE(r.approved_at, r.created_at)
FROM reports r;

-- ---------- The tail of PHASE 6: how precisely it was measured ---------------------------------

/**
 * `numeric(18,6)` cannot tell 12.40 from 12.4, and a certificate must: the last digit states
 * the precision of the measurement. The number stays numeric — everything that calculates uses
 * it — and this column keeps the analyst's own writing for everything that prints.
 *
 * The format is constrained here; that it equals `numeric_value` is checked by the service,
 * which is the only place that can compare them before the value is stored.
 */
ALTER TABLE test_results
  ADD COLUMN numeric_text text
    CHECK (numeric_text IS NULL OR numeric_text ~ '^-?[0-9]{1,12}(\.[0-9]{1,6})?$');

COMMENT ON COLUMN test_results.numeric_text IS
  'The value exactly as the analyst typed it. NULL for results entered before this existed.';

-- ---------- Least privilege across offices (PHASE 6 found this) --------------------------------

/**
 * A sample sent to a laboratory in another office is visible to that office by policy, but its
 * card could not be opened: the sample is read through a join to the job and the client, and
 * those belong to the sending office.
 *
 * Opening a client's commercial record to another country to fix that would trade a small
 * inconvenience for a large disclosure. This function gives the receiving laboratory exactly
 * what it needs to do the work and nothing else: what the sample is, how much of it there is,
 * how it was sealed and who to ask about it — no contract, no tariff, no invoice, no client
 * address or trading history. The client is named because a laboratory that cannot say whose
 * material is on the bench cannot run a chain of custody at all.
 */
CREATE FUNCTION lab_sample_brief(p_sample uuid)
RETURNS TABLE (
  id uuid, sample_number text, status sample_status, commodity text, quantity numeric, unit text,
  seal_number text, seal_state seal_condition, sampled_at timestamptz, received_at timestamptz,
  container_type text, batch_lot_number text, condition_notes text, instructions text,
  job_number text, client_name text, laboratory_id uuid, branch_code text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.sample_number, s.status,
         COALESCE(cm.name->>'en', s.commodity), s.quantity, s.unit,
         s.seal_number, s.seal_state, s.sampled_at, s.received_at,
         s.container_type, s.batch_lot_number, s.condition_notes, s.instructions,
         j.job_number, c.name, s.destination_laboratory_id, b.code
  FROM samples s
  JOIN inspection_jobs j ON j.id = s.job_id
  JOIN clients c ON c.id = s.client_id
  JOIN branches b ON b.id = s.branch_id
  LEFT JOIN commodities cm ON cm.id = s.commodity_id
  WHERE s.id = p_sample
    AND s.deleted_at IS NULL
    -- Only for the office whose laboratory is holding it, and only once it has been sent there.
    AND s.destination_laboratory_id IS NOT NULL
    AND app_sees_laboratory(s.destination_laboratory_id)
    AND app_has_perm('lab.test.read')
$$;
REVOKE ALL ON FUNCTION lab_sample_brief(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab_sample_brief(uuid) TO gsi_app;

-- ---------- Verification: what the QR says about a document ------------------------------------

/**
 * The public check behind the QR code, extended to tell the truth about documents that are no
 * longer current. A superseded certificate is not a forgery and a cancelled one is not a
 * missing page — answering 404 for either would teach people that the check cannot be trusted.
 *
 * It stays deliberately thin: number, type, status, issue date, issuing office and the checksum
 * of the file. Whoever holds the document already knows whose it is; whoever merely found the
 * QR code should not learn it from us.
 */
CREATE OR REPLACE FUNCTION public_verify_report(p_token text)
RETURNS TABLE (report_number text, status report_status, issued_at timestamptz, branch text,
               job_number text, service_type service_type, client_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.report_number, r.status, COALESCE(r.issued_at, r.approved_at), b.legal_name,
         j.job_number, j.type, c.name
  FROM reports r
  JOIN inspection_jobs j ON j.id = r.job_id
  JOIN clients c ON c.id = j.client_id
  JOIN branches b ON b.id = r.branch_id
  WHERE r.qr_code = p_token
$$;

/**
 * Keyed on the **revision's** token, not the document's: the copy in somebody's hand is one
 * particular revision, and the honest answer is about that copy. A revision that a later one
 * replaced is a valid historical document, and says so; it is not a forgery and not a 404.
 */
CREATE FUNCTION public_verify_document(p_token text)
RETURNS TABLE (
  report_number text, report_type report_kind, status report_status, version integer,
  issued_at timestamptz, issuer text, branch_code text, checksum char(64),
  superseded_by_version integer, cancelled_reason text, document_title text, language text,
  document_status report_status
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.report_number, r.report_type,
         /* What this copy is: superseded once the document has moved past this revision. */
         CASE
           WHEN r.status IN ('cancelled', 'revoked') THEN r.status
           WHEN v.version_number < r.version THEN 'superseded'::report_status
           ELSE v.status
         END,
         v.version_number,
         COALESCE(v.issued_at, r.issued_at, r.approved_at), b.legal_name, b.code, v.pdf_sha256,
         CASE WHEN v.version_number < r.version THEN r.version END,
         r.cancel_reason, r.title, v.language, r.status
  FROM report_versions v
  JOIN reports r ON r.id = v.report_id
  JOIN branches b ON b.id = r.branch_id
  WHERE v.qr_token = p_token
$$;
REVOKE ALL ON FUNCTION public_verify_document(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_verify_document(text) TO gsi_app;

-- ---------- Row-Level Security ------------------------------------------------------------------

ALTER TABLE report_templates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_versions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_status_history ENABLE ROW LEVEL SECURITY;

-- Templates are reference data: everyone reads them, only a template manager writes them.
CREATE POLICY report_templates_read ON report_templates FOR SELECT USING (true);
CREATE POLICY report_templates_manage ON report_templates FOR ALL
  USING (app_has_perm('report.manage_templates')) WITH CHECK (app_has_perm('report.manage_templates'));

-- A version is visible exactly when its document is.
CREATE POLICY report_versions_visible ON report_versions FOR ALL
  USING (EXISTS (SELECT 1 FROM reports r WHERE r.id = report_versions.report_id))
  WITH CHECK (EXISTS (SELECT 1 FROM reports r WHERE r.id = report_versions.report_id));

CREATE POLICY report_history_read ON report_status_history FOR SELECT
  USING (EXISTS (SELECT 1 FROM reports r WHERE r.id = report_status_history.report_id));
CREATE POLICY report_history_write ON report_status_history FOR INSERT WITH CHECK (true);

-- The archive is hidden the same way it is everywhere else.
DROP POLICY reports_branch ON reports;
CREATE POLICY reports_branch ON reports FOR ALL
  USING (app_is_live(deleted_at)
         AND app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM inspection_jobs j WHERE j.id = reports.job_id))
  WITH CHECK (app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM inspection_jobs j WHERE j.id = reports.job_id));

GRANT SELECT, INSERT, UPDATE ON report_templates TO gsi_app;
GRANT SELECT, INSERT, UPDATE ON report_versions TO gsi_app;
-- History is append-only, and that is a grant rather than a promise.
GRANT SELECT, INSERT ON report_status_history TO gsi_app;
GRANT USAGE, SELECT ON SEQUENCE report_status_history_id_seq TO gsi_app;

-- ---------- Permissions -------------------------------------------------------------------------

INSERT INTO permissions (code, category, description) VALUES
  ('report.create',           'documents', 'Start a report or certificate'),
  ('report.update',           'documents', 'Edit a draft report'),
  ('report.submit_review',    'documents', 'Hand a draft in for review'),
  ('report.review',           'documents', 'Technically review a report, or return it with a reason'),
  ('report.approve',          'documents', 'Approve a reviewed report'),
  ('report.issue',            'documents', 'Issue an approved report as an official document'),
  ('report.revise',           'documents', 'Open a revision of an issued document'),
  ('report.cancel',           'documents', 'Cancel an issued document, with a reason'),
  ('report.archive',          'documents', 'Move a report to the archive'),
  ('report.restore',          'documents', 'Bring a report back from the archive'),
  ('report.manage_templates', 'documents', 'Create and version document templates'),
  ('report.self_approve',     'documents', 'Approve a report one prepared oneself')
ON CONFLICT (code) DO NOTHING;

-- Whoever could read reports can still read them; the new rights are granted deliberately.
INSERT INTO role_permissions (role_code, permission_code)
SELECT DISTINCT rp.role_code, v.code FROM role_permissions rp,
  (VALUES ('report.create'), ('report.update'), ('report.submit_review')) AS v(code)
WHERE rp.permission_code = 'job.submit'
ON CONFLICT DO NOTHING;

/**
 * Reviewing and approving a document is the same judgement as approving the job it describes,
 * so it follows `job.approve`. Issuing is separate: approved says the document is right,
 * issued says it may leave the building with a client's name on it.
 */
INSERT INTO role_permissions (role_code, permission_code)
SELECT DISTINCT rp.role_code, v.code FROM role_permissions rp,
  (VALUES ('report.review'), ('report.approve'), ('report.issue'), ('report.revise'),
          ('report.cancel'), ('report.archive'), ('report.restore')) AS v(code)
WHERE rp.permission_code = 'job.approve'
ON CONFLICT DO NOTHING;

-- The laboratory writes certificates of analysis for its own work.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'lab_manager', v.code FROM (VALUES
  ('report.create'), ('report.update'), ('report.submit_review'), ('report.review')) AS v(code)
ON CONFLICT DO NOTHING;

-- Administrators and the people who run offices and countries get everything except the right
-- to approve their own work, which nobody is given by default.
INSERT INTO role_permissions (role_code, permission_code)
SELECT r.code, p.code FROM roles r, permissions p
WHERE r.code IN ('admin', 'country_manager', 'office_manager')
  AND p.code LIKE 'report.%' AND p.code <> 'report.self_approve'
ON CONFLICT DO NOTHING;

-- The person whose job it is to check documents, checks documents.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'report_reviewer', v.code FROM (VALUES
  ('report.review'), ('report.approve')) AS v(code)
ON CONFLICT DO NOTHING;
