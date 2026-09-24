-- ---------------------------------------------------------------------------------------
-- 012. The job becomes the operational centre of the platform.
--
-- What already existed and is kept as is:
--   * the table `inspection_jobs` — renaming it would touch six migrations, five foreign
--     keys, every Row-Level Security policy, issued reports and the finance ledger, for no
--     gain at all;
--   * `job_number` from next_doc_number() — already unique and concurrency-safe (a counter
--     row updated inside the transaction, never MAX(id)+1), and already printed on issued
--     reports, so the format stays: TR-J-2026-00001;
--   * `branch_id` as the responsible office, `assigned_inspector_id` as the lead;
--   * `deleted_at` as the archive marker, which stays separate from the `cancelled` status:
--     cancelling is a business outcome, archiving is retention.
--
-- What this migration adds:
--   * the full lifecycle (draft → … → closed, plus on hold and cancelled);
--   * an immutable status history;
--   * assignments, so a job can have a team rather than one inspector;
--   * the operational fields the office actually fills in: priority, requested date,
--     client reference, contact, internal notes, transport details;
--   * a version column for optimistic locking, so two people editing one job cannot
--     silently overwrite each other.
--
-- Status mapping for existing rows:
--   new          → confirmed   (a job in the old model was already complete, just unassigned)
--   assigned     → assigned
--   in_progress  → in_progress
--   under_review → under_review   (this IS the REVIEW state; the name stays, it reads better)
--   approved     → approved
--   cancelled    → cancelled
-- The mapping is done by renaming the enum value, so existing rows are not rewritten.
-- ---------------------------------------------------------------------------------------

-- ---------- Lifecycle -------------------------------------------------------------------
-- Renaming rather than adding-and-updating: the value keeps its identity, so all 956 existing
-- rows move to the new vocabulary without touching a single one, and no code can keep writing
-- the retired name by accident — it no longer exists.
ALTER TYPE job_status RENAME VALUE 'new' TO 'confirmed';

ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'draft'              BEFORE 'confirmed';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'sampling'           AFTER 'in_progress';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'lab'                AFTER 'sampling';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'report_preparation' AFTER 'lab';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'completed'          AFTER 'approved';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'invoiced'           AFTER 'completed';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'closed'             AFTER 'invoiced';
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'on_hold'            AFTER 'closed';

CREATE TYPE job_priority AS ENUM ('low', 'normal', 'high', 'urgent');

/** What the inspection is performed on; decides which transport fields are worth filling. */
CREATE TYPE job_object_kind AS ENUM ('vessel', 'warehouse', 'terminal', 'truck', 'rail', 'container', 'other');

ALTER TABLE inspection_jobs
  ADD COLUMN priority          job_priority NOT NULL DEFAULT 'normal',
  ADD COLUMN client_contact_id uuid,
  /** The office that asked for the work, when it is not the one performing it. */
  ADD COLUMN requesting_branch_id uuid REFERENCES branches(id),
  ADD COLUMN city              text,
  ADD COLUMN object_kind       job_object_kind,
  ADD COLUMN container_no      text,
  ADD COLUMN transport_ref     text,
  /** The client's own reference for this job — what they quote when they call. */
  ADD COLUMN client_reference  text,
  /** Visible to us, never printed on anything the client sees. */
  ADD COLUMN internal_notes    text,
  /** The date the client asked for; `scheduled_at` is when we actually plan to be there. */
  ADD COLUMN requested_date    date,
  /** The state a job was in before it was put on hold, so resuming returns it there. */
  ADD COLUMN status_before_hold job_status,
  /** Bumped on every update; a stale form is rejected instead of overwriting newer data. */
  ADD COLUMN version           integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT jobs_contact_fk FOREIGN KEY (client_contact_id, branch_id)
      REFERENCES client_contacts (id, branch_id) ON DELETE SET NULL;

-- Existing rows: the client asked for them on the day they were raised.
UPDATE inspection_jobs SET requested_date = COALESCE(scheduled_at::date, created_at::date)
WHERE requested_date IS NULL;

ALTER TABLE inspection_jobs ALTER COLUMN requested_date SET DEFAULT current_date;

CREATE FUNCTION trg_bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;

CREATE TRIGGER jobs_version BEFORE UPDATE ON inspection_jobs
  FOR EACH ROW EXECUTE FUNCTION trg_bump_version();

-- ---------- Status history --------------------------------------------------------------
/**
 * Every status change, for good. Append-only: the application role may insert and read,
 * and has no grant to update or delete — the same rule as the audit log.
 */
CREATE TABLE job_status_history (
  id          bigserial PRIMARY KEY,
  job_id      uuid NOT NULL,
  branch_id   uuid NOT NULL,
  from_status job_status,
  to_status   job_status NOT NULL,
  changed_by  uuid REFERENCES users(id),
  reason      text,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, branch_id) REFERENCES inspection_jobs (id, branch_id) ON DELETE CASCADE
);
CREATE INDEX job_status_history_job_idx ON job_status_history (job_id, created_at);

-- Existing jobs get the one entry we can honestly reconstruct: how they reached today's state.
INSERT INTO job_status_history (job_id, branch_id, from_status, to_status, changed_by, created_at, metadata)
SELECT id, branch_id, NULL, status, COALESCE(approved_by, created_by), COALESCE(approved_at, created_at),
       '{"backfilled": true}'::jsonb
FROM inspection_jobs;

-- ---------- Assignments -----------------------------------------------------------------
CREATE TYPE assignment_role AS ENUM (
  'lead_inspector', 'inspector', 'sampler', 'lab_coordinator', 'report_reviewer', 'operations_coordinator'
);

/**
 * Who works on a job. One row per person per role; `removed_at` retires an assignment
 * instead of deleting it, so "who was on this job in March" stays answerable.
 */
CREATE TABLE job_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid NOT NULL,
  branch_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  role        assignment_role NOT NULL DEFAULT 'inspector',
  assigned_by uuid REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  removed_by  uuid REFERENCES users(id),
  note        text,
  FOREIGN KEY (job_id, branch_id) REFERENCES inspection_jobs (id, branch_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, branch_id) REFERENCES users (id, branch_id)
);
CREATE INDEX job_assignments_job_idx ON job_assignments (job_id) WHERE removed_at IS NULL;
CREATE INDEX job_assignments_user_idx ON job_assignments (user_id) WHERE removed_at IS NULL;
-- The same person is not assigned twice in the same role while the first is still live.
CREATE UNIQUE INDEX job_assignments_unique_idx ON job_assignments (job_id, user_id, role)
  WHERE removed_at IS NULL;
-- At most one lead per job.
CREATE UNIQUE INDEX job_assignments_lead_idx ON job_assignments (job_id)
  WHERE role = 'lead_inspector' AND removed_at IS NULL;

-- The inspector a job already had becomes its lead, so nothing is lost in the move.
INSERT INTO job_assignments (job_id, branch_id, user_id, role, assigned_by, assigned_at)
SELECT id, branch_id, assigned_inspector_id, 'lead_inspector', created_by, created_at
FROM inspection_jobs
WHERE assigned_inspector_id IS NOT NULL;

-- ---------- Indexes for the list screen --------------------------------------------------
CREATE INDEX jobs_priority_idx ON inspection_jobs (branch_id, priority) WHERE deleted_at IS NULL;
CREATE INDEX jobs_scheduled_idx ON inspection_jobs (scheduled_at) WHERE deleted_at IS NULL;
CREATE INDEX jobs_requested_idx ON inspection_jobs (requested_date) WHERE deleted_at IS NULL;
CREATE INDEX jobs_updated_idx ON inspection_jobs (updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX jobs_client_ref_idx ON inspection_jobs (client_reference) WHERE client_reference IS NOT NULL;

-- ---------- Row-Level Security ------------------------------------------------------------
/**
 * "Own" scope used to mean the one inspector named on the job. With a team on it, everyone
 * assigned must see it. SECURITY DEFINER because the jobs policy calls this while reading
 * assignments, which would otherwise recurse through their own policy.
 */
CREATE FUNCTION app_is_assigned(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM job_assignments a
    WHERE a.job_id = p_job AND a.user_id = app_user_id() AND a.removed_at IS NULL
  )
$$;
REVOKE ALL ON FUNCTION app_is_assigned(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_assigned(uuid) TO gsi_app;

DROP POLICY jobs_branch ON inspection_jobs;
CREATE POLICY jobs_branch ON inspection_jobs FOR ALL
  USING (app_can_see_branch(branch_id)
         AND app_is_live(deleted_at)
         AND (app_scope() <> 'own'
              OR assigned_inspector_id = app_user_id()
              OR app_is_assigned(id)))
  WITH CHECK (app_can_see_branch(branch_id));

ALTER TABLE job_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_assignments    ENABLE ROW LEVEL SECURITY;

CREATE POLICY job_history_read ON job_status_history FOR SELECT
  USING (app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM inspection_jobs j WHERE j.id = job_status_history.job_id));
-- Writing is unconditional for the same reason as the audit log: a transition must never
-- fail to be recorded. There is no UPDATE or DELETE grant at all.
CREATE POLICY job_history_write ON job_status_history FOR INSERT WITH CHECK (true);

CREATE POLICY job_assignments_branch ON job_assignments FOR ALL
  USING (app_can_see_branch(branch_id)
         AND (app_scope() <> 'own' OR user_id = app_user_id() OR app_is_assigned(job_id)))
  WITH CHECK (app_can_see_branch(branch_id));

GRANT SELECT, INSERT ON job_status_history TO gsi_app;
GRANT USAGE, SELECT ON SEQUENCE job_status_history_id_seq TO gsi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON job_assignments TO gsi_app;

-- ---------- Permissions -------------------------------------------------------------------
INSERT INTO permissions (code, category, description) VALUES
  ('job.archive',       'operations', 'Archive a job'),
  ('job.restore',       'operations', 'Restore an archived job'),
  ('job.change_status', 'operations', 'Move a job through its lifecycle'),
  ('job.close',         'operations', 'Close a finished job'),
  ('job.read_history',  'operations', 'See the status history of a job'),
  ('job.read_finance',  'operations', 'See invoices and costs on a job')
ON CONFLICT DO NOTHING;

-- job.delete was always an archive in disguise; the catalogue now says what it does.
INSERT INTO role_permissions (role_code, permission_code)
SELECT role_code, 'job.archive' FROM role_permissions WHERE permission_code = 'job.delete'
ON CONFLICT DO NOTHING;
DELETE FROM role_permissions WHERE permission_code = 'job.delete';
DELETE FROM permissions WHERE code = 'job.delete';

-- Anyone who could move a job through the old endpoints keeps doing so under the new right.
INSERT INTO role_permissions (role_code, permission_code)
SELECT DISTINCT role_code, 'job.change_status' FROM role_permissions
WHERE permission_code IN ('job.start', 'job.submit', 'job.approve', 'job.cancel')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT DISTINCT role_code, 'job.read_history' FROM role_permissions
WHERE permission_code = 'job.read'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'job.restore' FROM roles
WHERE code IN ('admin', 'country_manager', 'office_manager', 'supervisor')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'job.close' FROM roles
WHERE code IN ('admin', 'country_manager', 'office_manager', 'supervisor', 'operations', 'finance_controller')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'job.read_finance' FROM roles
WHERE code IN ('admin', 'cfo', 'country_manager', 'office_manager', 'supervisor', 'finance_controller')
ON CONFLICT DO NOTHING;
