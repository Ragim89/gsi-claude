-- ---------------------------------------------------------------------------------------
-- 013. Inspections as their own entity.
--
-- What already existed (and is kept):
--   * `job_checklist_items` — a snapshot of the template taken when the job is created, with
--     the label, input kind and template version copied into the row. Historic checklists
--     therefore already cannot change when a template is edited: the versioning requirement
--     was met by design in MVP-1, and this migration does not touch it.
--   * `media_attachments` — photos with GPS, capture time and a sha256, linked to the job and
--     optionally to a checklist item.
--   * `service_type` — the existing catalogue of what GSI does. Inspections reuse it rather
--     than introducing a second, competing list of types.
--
-- What changes: a job can now hold several inspections (a loading and a discharge survey, a
-- re-inspection, different types on one nomination), so the field work moves out of the job
-- row into `inspections`. The checklist and the photos are NOT copied anywhere — they gain an
-- `inspection_id` and keep their `job_id`, so reports, Row-Level Security and every existing
-- query keep working untouched.
--
-- Existing data: every job that has field work gets exactly one inspection representing the
-- work already done, and its checklist items and photos are pointed at it. Nothing is deleted,
-- nothing is rewritten.
-- ---------------------------------------------------------------------------------------

CREATE TYPE inspection_status AS ENUM (
  'draft', 'scheduled', 'in_progress', 'completed', 'under_review', 'approved', 'on_hold', 'cancelled'
);

/**
 * Deliberately no READY state: it would add a click without a decision behind it. An
 * inspection is scheduled, and then it starts. See docs/WORKFLOWS.md.
 */

CREATE TYPE finding_severity AS ENUM ('info', 'minor', 'major', 'critical');
CREATE TYPE finding_status AS ENUM ('open', 'acknowledged', 'resolved', 'withdrawn');

CREATE TYPE photo_category AS ENUM (
  'general', 'cargo', 'damage', 'seal', 'container', 'document', 'equipment', 'sampling', 'other'
);

CREATE TABLE inspections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id            uuid NOT NULL REFERENCES branches(id),
  job_id               uuid NOT NULL,
  inspection_number    text NOT NULL UNIQUE,
  /** The same catalogue the job uses — one list of services, not two. */
  type                 service_type NOT NULL,
  status               inspection_status NOT NULL DEFAULT 'draft',
  lead_inspector_id    uuid,
  location             text,
  city                 text,
  scheduled_start      timestamptz,
  scheduled_end        timestamptz,
  actual_start         timestamptz,
  actual_end           timestamptz,
  /** What the inspector found overall, as opposed to item by item. */
  weather_conditions   text,
  site_conditions      text,
  general_observations text,
  conclusion           text,
  /** Ours to read; never printed on anything the client sees. */
  internal_notes       text,
  instructions         text,
  status_before_hold   inspection_status,
  reviewed_by          uuid REFERENCES users(id),
  reviewed_at          timestamptz,
  review_comment       text,
  version              integer NOT NULL DEFAULT 1,
  deleted_at           timestamptz,
  deleted_by           uuid REFERENCES users(id),
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, branch_id),
  FOREIGN KEY (job_id, branch_id) REFERENCES inspection_jobs (id, branch_id) ON DELETE CASCADE,
  FOREIGN KEY (lead_inspector_id, branch_id) REFERENCES users (id, branch_id),
  CHECK (scheduled_end IS NULL OR scheduled_start IS NULL OR scheduled_end >= scheduled_start),
  CHECK (actual_end IS NULL OR actual_start IS NULL OR actual_end >= actual_start)
);
CREATE TRIGGER inspections_updated_at BEFORE UPDATE ON inspections
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER inspections_version BEFORE UPDATE ON inspections
  FOR EACH ROW EXECUTE FUNCTION trg_bump_version();

CREATE INDEX inspections_job_idx ON inspections (job_id) WHERE deleted_at IS NULL;
CREATE INDEX inspections_status_idx ON inspections (branch_id, status) WHERE deleted_at IS NULL;
CREATE INDEX inspections_scheduled_idx ON inspections (scheduled_start) WHERE deleted_at IS NULL;
CREATE INDEX inspections_lead_idx ON inspections (lead_inspector_id) WHERE deleted_at IS NULL;
CREATE INDEX inspections_updated_idx ON inspections (updated_at DESC) WHERE deleted_at IS NULL;

-- ---------- Status history (append-only, like the job's) ---------------------------------
CREATE TABLE inspection_status_history (
  id            bigserial PRIMARY KEY,
  inspection_id uuid NOT NULL,
  branch_id     uuid NOT NULL,
  from_status   inspection_status,
  to_status     inspection_status NOT NULL,
  changed_by    uuid REFERENCES users(id),
  reason        text,
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (inspection_id, branch_id) REFERENCES inspections (id, branch_id) ON DELETE CASCADE
);
CREATE INDEX inspection_history_idx ON inspection_status_history (inspection_id, created_at);

-- ---------- The team on one inspection ----------------------------------------------------
/**
 * A job's team and an inspection's team are not always the same: two inspections on one
 * nomination can be run by different people on different days.
 */
CREATE TABLE inspection_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL,
  branch_id     uuid NOT NULL,
  user_id       uuid NOT NULL,
  role          assignment_role NOT NULL DEFAULT 'inspector',
  assigned_by   uuid REFERENCES users(id),
  assigned_at   timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  removed_by    uuid REFERENCES users(id),
  note          text,
  FOREIGN KEY (inspection_id, branch_id) REFERENCES inspections (id, branch_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, branch_id) REFERENCES users (id, branch_id)
);
CREATE INDEX inspection_assignments_idx ON inspection_assignments (inspection_id) WHERE removed_at IS NULL;
CREATE INDEX inspection_assignments_user_idx ON inspection_assignments (user_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX inspection_assignments_unique_idx
  ON inspection_assignments (inspection_id, user_id, role) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX inspection_assignments_lead_idx
  ON inspection_assignments (inspection_id) WHERE role = 'lead_inspector' AND removed_at IS NULL;

-- ---------- Findings ----------------------------------------------------------------------
/**
 * What the inspector observed that someone has to act on. Severity is a business
 * classification for the report and the client — it grants nobody any access.
 */
CREATE TABLE inspection_findings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id  uuid NOT NULL,
  branch_id      uuid NOT NULL,
  category       text,
  severity       finding_severity NOT NULL DEFAULT 'minor',
  status         finding_status NOT NULL DEFAULT 'open',
  title          text NOT NULL,
  description    text,
  recommendation text,
  /** Findings marked internal stay out of anything the client receives. */
  is_internal    boolean NOT NULL DEFAULT false,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, branch_id),
  FOREIGN KEY (inspection_id, branch_id) REFERENCES inspections (id, branch_id) ON DELETE CASCADE
);
CREATE TRIGGER inspection_findings_updated_at BEFORE UPDATE ON inspection_findings
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE INDEX inspection_findings_idx ON inspection_findings (inspection_id);

-- ---------- Measurements ------------------------------------------------------------------
/**
 * Readings taken on site. One extensible table rather than a column per quantity: a draft
 * survey measures drafts and densities, a warehouse inspection measures temperature and
 * moisture, and next year there will be something else.
 */
CREATE TABLE inspection_measurements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id    uuid NOT NULL,
  branch_id        uuid NOT NULL,
  measurement_type text NOT NULL,
  label            text,
  value_numeric    numeric(18, 6),
  value_text       text,
  unit             text,
  /** Where on the object it was taken: hold 3, container door, silo top. */
  position         text,
  measured_at      timestamptz NOT NULL DEFAULT now(),
  measured_by      uuid REFERENCES users(id),
  metadata         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, branch_id),
  FOREIGN KEY (inspection_id, branch_id) REFERENCES inspections (id, branch_id) ON DELETE CASCADE,
  CHECK (value_numeric IS NOT NULL OR value_text IS NOT NULL)
);
CREATE INDEX inspection_measurements_idx ON inspection_measurements (inspection_id);

-- ---------- The existing checklist and photos join the inspection -------------------------
-- They keep their job_id: reports, policies and every existing query go on working.
ALTER TABLE job_checklist_items
  ADD COLUMN inspection_id uuid,
  ADD COLUMN section text,
  /**
   * An item that must be answered before the inspection can be completed. Defaults to true
   * because that is exactly what the job flow already required — every item answered before
   * submission — and silently relaxing it during a migration would be a change nobody asked
   * for. Templates can mark individual items optional.
   */
  ADD COLUMN is_required boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT checklist_inspection_fk FOREIGN KEY (inspection_id, branch_id)
      REFERENCES inspections (id, branch_id) ON DELETE SET NULL;
CREATE INDEX checklist_inspection_idx ON job_checklist_items (inspection_id);

-- An item key was unique per job, which was right when a job had one checklist. Two
-- inspections on one job legitimately ask the same questions twice, so uniqueness moves to
-- the inspection; rows that predate inspections keep the old rule.
ALTER TABLE job_checklist_items DROP CONSTRAINT job_checklist_items_job_id_item_key_key;
CREATE UNIQUE INDEX checklist_item_per_inspection_idx
  ON job_checklist_items (inspection_id, item_key) WHERE inspection_id IS NOT NULL;
CREATE UNIQUE INDEX checklist_item_per_job_idx
  ON job_checklist_items (job_id, item_key) WHERE inspection_id IS NULL;

ALTER TABLE media_attachments
  ADD COLUMN inspection_id uuid,
  ADD COLUMN category photo_category NOT NULL DEFAULT 'general',
  ADD COLUMN caption text,
  ADD CONSTRAINT media_inspection_fk FOREIGN KEY (inspection_id, branch_id)
      REFERENCES inspections (id, branch_id) ON DELETE SET NULL;
CREATE INDEX media_inspection_idx ON media_attachments (inspection_id);

-- ---------- Backfill ----------------------------------------------------------------------
-- One inspection per existing job: the field work that has already happened, with the dates
-- and the person the job already recorded.
INSERT INTO inspections (branch_id, job_id, inspection_number, type, status, lead_inspector_id,
                         location, scheduled_start, actual_start, actual_end, instructions,
                         created_by, created_at, updated_at)
SELECT j.branch_id,
       j.id,
       -- A number in the same shape as every other document, allocated in one pass.
       b.code || '-INS-' || to_char(COALESCE(j.created_at, now()), 'YYYY') || '-' ||
         lpad((row_number() OVER (PARTITION BY j.branch_id, date_part('year', j.created_at)
                                  ORDER BY j.created_at, j.id))::text, 5, '0'),
       j.type,
       CASE j.status
         WHEN 'draft' THEN 'draft'
         WHEN 'confirmed' THEN 'draft'
         WHEN 'assigned' THEN 'scheduled'
         WHEN 'in_progress' THEN 'in_progress'
         WHEN 'sampling' THEN 'in_progress'
         WHEN 'lab' THEN 'completed'
         WHEN 'report_preparation' THEN 'completed'
         WHEN 'under_review' THEN 'under_review'
         WHEN 'on_hold' THEN 'on_hold'
         WHEN 'cancelled' THEN 'cancelled'
         ELSE 'approved'   -- approved, completed, invoiced, closed: the field work is done
       END::inspection_status,
       j.assigned_inspector_id,
       j.location,
       j.scheduled_at,
       j.submitted_at,
       j.approved_at,
       j.instructions,
       j.created_by,
       j.created_at,
       j.updated_at
FROM inspection_jobs j
JOIN branches b ON b.id = j.branch_id;

-- Keep the document counters honest: the next inspection number must not collide with the
-- ones just handed out.
INSERT INTO doc_counters (branch_id, kind, year, last_value)
SELECT branch_id, 'INS', date_part('year', created_at)::int, count(*)
FROM inspections
GROUP BY branch_id, date_part('year', created_at)
ON CONFLICT (branch_id, kind, year) DO UPDATE SET last_value = GREATEST(doc_counters.last_value, EXCLUDED.last_value);

-- The checklist and the photos now belong to that inspection as well as to the job.
UPDATE job_checklist_items c SET inspection_id = i.id
FROM inspections i WHERE i.job_id = c.job_id;

UPDATE media_attachments m SET inspection_id = i.id
FROM inspections i WHERE i.job_id = m.job_id;

-- Each backfilled inspection gets the one history entry that can honestly be reconstructed.
INSERT INTO inspection_status_history (inspection_id, branch_id, from_status, to_status, changed_by, created_at, metadata)
SELECT id, branch_id, NULL, status, created_by, created_at, '{"backfilled": true}'::jsonb
FROM inspections;

-- …and the inspector it already had.
INSERT INTO inspection_assignments (inspection_id, branch_id, user_id, role, assigned_by, assigned_at)
SELECT id, branch_id, lead_inspector_id, 'lead_inspector', created_by, created_at
FROM inspections WHERE lead_inspector_id IS NOT NULL;

-- ---------- Row-Level Security ------------------------------------------------------------
/**
 * "Own" scope on an inspection: the lead, anyone assigned to it, and anyone assigned to its
 * job. SECURITY DEFINER for the same reason as the job helper — the policy reads the
 * assignment table that has a policy of its own.
 */
CREATE FUNCTION app_is_on_inspection(p_inspection uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM inspection_assignments a
    WHERE a.inspection_id = p_inspection AND a.user_id = app_user_id() AND a.removed_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM inspections i
    JOIN job_assignments ja ON ja.job_id = i.job_id AND ja.removed_at IS NULL
    WHERE i.id = p_inspection AND ja.user_id = app_user_id()
  ) OR EXISTS (
    SELECT 1 FROM inspections i WHERE i.id = p_inspection AND i.lead_inspector_id = app_user_id()
  )
$$;
REVOKE ALL ON FUNCTION app_is_on_inspection(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_on_inspection(uuid) TO gsi_app;

/**
 * Being on an inspection means being on its job.
 *
 * Without this, somebody sent to one inspection of a job could not see the job it belongs to —
 * and since every inspection query joins the job for its number and client, could not see the
 * inspection either. The jobs policy itself is untouched: it already asks this function.
 */
CREATE OR REPLACE FUNCTION app_is_assigned(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM job_assignments a
    WHERE a.job_id = p_job AND a.user_id = app_user_id() AND a.removed_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM inspections i
    LEFT JOIN inspection_assignments ia ON ia.inspection_id = i.id AND ia.removed_at IS NULL
    WHERE i.job_id = p_job AND i.deleted_at IS NULL
      AND (i.lead_inspector_id = app_user_id() OR ia.user_id = app_user_id())
  )
$$;

ALTER TABLE inspections              ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_assignments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_findings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_measurements  ENABLE ROW LEVEL SECURITY;

CREATE POLICY inspections_branch ON inspections FOR ALL
  USING (app_can_see_branch(branch_id)
         AND app_is_live(deleted_at)
         AND (app_scope() <> 'own' OR app_is_on_inspection(id)))
  WITH CHECK (app_can_see_branch(branch_id));

CREATE POLICY inspection_history_read ON inspection_status_history FOR SELECT
  USING (app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM inspections i WHERE i.id = inspection_status_history.inspection_id));
CREATE POLICY inspection_history_write ON inspection_status_history FOR INSERT WITH CHECK (true);

CREATE POLICY inspection_assignments_branch ON inspection_assignments FOR ALL
  USING (app_can_see_branch(branch_id)
         AND (app_scope() <> 'own' OR user_id = app_user_id() OR app_is_on_inspection(inspection_id)))
  WITH CHECK (app_can_see_branch(branch_id));

CREATE POLICY inspection_findings_branch ON inspection_findings FOR ALL
  USING (app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM inspections i WHERE i.id = inspection_findings.inspection_id))
  WITH CHECK (app_can_see_branch(branch_id));

CREATE POLICY inspection_measurements_branch ON inspection_measurements FOR ALL
  USING (app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM inspections i WHERE i.id = inspection_measurements.inspection_id))
  WITH CHECK (app_can_see_branch(branch_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON inspections, inspection_assignments,
  inspection_findings, inspection_measurements TO gsi_app;
GRANT SELECT, INSERT ON inspection_status_history TO gsi_app;
GRANT USAGE, SELECT ON SEQUENCE inspection_status_history_id_seq TO gsi_app;

-- ---------- Permissions -------------------------------------------------------------------
INSERT INTO permissions (code, category, description) VALUES
  ('inspection.read',             'operations', 'See inspections'),
  ('inspection.create',           'operations', 'Create inspections'),
  ('inspection.update',           'operations', 'Edit inspection details'),
  ('inspection.assign',           'operations', 'Assign people to an inspection'),
  ('inspection.start',            'operations', 'Start field work'),
  ('inspection.complete',         'operations', 'Complete an inspection'),
  ('inspection.review',           'operations', 'Send an inspection for review or return it'),
  ('inspection.approve',          'operations', 'Approve an inspection'),
  ('inspection.cancel',           'operations', 'Cancel or hold an inspection'),
  ('inspection.archive',          'operations', 'Archive an inspection'),
  ('inspection.restore',          'operations', 'Restore an archived inspection'),
  ('inspection.add_finding',      'operations', 'Record findings'),
  ('inspection.add_measurement',  'operations', 'Record measurements')
ON CONFLICT DO NOTHING;

-- Whoever could see or run jobs gets the matching inspection right: the field work is the
-- same work, and a role that had to be edited by hand would be a role nobody updates.
INSERT INTO role_permissions (role_code, permission_code)
SELECT DISTINCT role_code, 'inspection.read' FROM role_permissions WHERE permission_code = 'job.read'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT DISTINCT role_code, v.code FROM role_permissions rp,
  (VALUES ('inspection.create'), ('inspection.update'), ('inspection.assign'),
          ('inspection.cancel'), ('inspection.archive')) AS v(code)
WHERE rp.permission_code = 'job.create'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT DISTINCT role_code, v.code FROM role_permissions rp,
  (VALUES ('inspection.start'), ('inspection.complete'), ('inspection.add_finding'),
          ('inspection.add_measurement')) AS v(code)
WHERE rp.permission_code = 'job.start'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT DISTINCT role_code, v.code FROM role_permissions rp,
  (VALUES ('inspection.review'), ('inspection.approve')) AS v(code)
WHERE rp.permission_code = 'job.approve'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'inspection.restore' FROM roles
WHERE code IN ('admin', 'country_manager', 'office_manager', 'supervisor')
ON CONFLICT DO NOTHING;

-- Samplers do field work too: they record what they saw and measured.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'sampler', v.code FROM (VALUES ('inspection.read'), ('inspection.start'),
  ('inspection.add_finding'), ('inspection.add_measurement')) AS v(code)
ON CONFLICT DO NOTHING;
