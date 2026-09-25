-- ---------------------------------------------------------------------------------------
-- 023. PHASE 10 — General documents registry.
--
-- Reports already have a document engine (016/017/018): their own numbering, their own
-- workflow, their own PDF renderer. That stays exactly as it is. This is the *other* kind of
-- document — a file someone attaches to a client, a job, an inspection, a sample, an invoice,
-- or an already-issued report — that has no lifecycle of its own beyond "here" and "archived".
--
-- Storage is the existing MinIO/S3 bucket through the existing StorageService; this migration
-- only adds the row that remembers what was uploaded, for what, and by whom. A row can instead
-- point at an issued report's own `report_version_id` — the "reference" case in the check
-- constraint below — so a report already stored once by PHASE 7 is never copied into this table
-- as a second binary just to appear in a client's document list.
-- ---------------------------------------------------------------------------------------

CREATE TYPE document_entity_type AS ENUM ('client', 'job', 'inspection', 'sample', 'report', 'invoice');
CREATE TYPE document_category AS ENUM
  ('contract', 'certificate', 'correspondence', 'customs', 'identity', 'photo', 'invoice', 'other');
CREATE TYPE document_visibility AS ENUM ('internal', 'client_visible');

CREATE TABLE documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id         uuid NOT NULL REFERENCES branches(id),
  entity_type       document_entity_type NOT NULL,
  entity_id         uuid NOT NULL,
  category          document_category NOT NULL DEFAULT 'other',
  title             text NOT NULL,
  filename          text NOT NULL,
  mime_type         text NOT NULL,
  size_bytes        bigint NOT NULL CHECK (size_bytes > 0),
  storage_key       text,
  report_version_id uuid REFERENCES report_versions(id),
  version           integer NOT NULL DEFAULT 1,
  replaces_id       uuid REFERENCES documents(id),
  visibility        document_visibility NOT NULL DEFAULT 'internal',
  metadata          jsonb,
  uploaded_by       uuid NOT NULL REFERENCES users(id),
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz,
  archived_by       uuid REFERENCES users(id),
  -- Every row either holds its own file or points at one PHASE 7 already stored — never neither,
  -- never both.
  CHECK ((storage_key IS NOT NULL) <> (report_version_id IS NOT NULL))
);

CREATE INDEX documents_entity_idx  ON documents (entity_type, entity_id) WHERE archived_at IS NULL;
CREATE INDEX documents_branch_idx  ON documents (branch_id) WHERE archived_at IS NULL;
CREATE INDEX documents_replaces_idx ON documents (replaces_id) WHERE replaces_id IS NOT NULL;

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- Same "archived, not deleted" shape as clients/jobs/invoices/expenses/assets (010_soft_delete):
-- app_is_live() reads deleted_at everywhere else, so it is reused here on archived_at rather
-- than inventing a second convention for the same idea.
CREATE POLICY documents_read ON documents FOR SELECT
  USING (app_has_perm('document.read') AND app_can_see_branch(branch_id) AND app_is_live(archived_at));

CREATE POLICY documents_insert ON documents FOR INSERT
  WITH CHECK (app_has_perm('document.upload') AND app_can_see_branch(branch_id));

-- UPDATE exists only to archive a row (set archived_at/archived_by) or record a new version's
-- replaces_id back-reference; there is no general edit and no DELETE policy, so a document can
-- never leave the table once written — the same immutability the audit log gets, for the same
-- reason: a document that "was never there" is worse than one that was later archived.
CREATE POLICY documents_archive ON documents FOR UPDATE
  USING (app_has_perm('document.archive') AND app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

GRANT SELECT, INSERT, UPDATE ON documents TO gsi_app;

INSERT INTO permissions (code, category, description) VALUES
  ('document.read',    'documents', 'View documents attached to clients, jobs, inspections, samples, reports and invoices'),
  ('document.upload',  'documents', 'Upload a document to a client, job, inspection, sample or invoice'),
  ('document.archive', 'documents', 'Archive an uploaded document')
ON CONFLICT DO NOTHING;

-- Read is broad: whoever can already see the parent record (RLS on that record's own table)
-- gains nothing new by also having document.read — this permission gates the documents table
-- itself, not the parent entity a second time.
INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'document.read' FROM roles
WHERE code IN ('admin', 'cfo', 'country_manager', 'office_manager', 'supervisor', 'operations',
               'finance_controller', 'sales', 'report_reviewer', 'lab_manager', 'lab_analyst',
               'inspector', 'sampler', 'viewer')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'document.upload' FROM roles
WHERE code IN ('admin', 'country_manager', 'office_manager', 'supervisor', 'operations',
               'finance_controller', 'sales', 'report_reviewer', 'lab_manager', 'lab_analyst',
               'inspector', 'sampler')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'document.archive' FROM roles
WHERE code IN ('admin', 'country_manager', 'office_manager', 'supervisor')
ON CONFLICT DO NOTHING;
