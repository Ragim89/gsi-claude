-- ---------------------------------------------------------------------------------------
-- 014. Samples and chain of custody.
--
-- What already existed (and is reused, not duplicated):
--   * `service_type` already has `sampling`, `assignment_role` already has `sampler`, and the
--     `sampler` role already exists — sampling was always part of the business, it just had
--     nowhere to be recorded.
--   * `next_doc_number(branch, kind)` — the concurrency-safe counter behind every document
--     number. Samples use kind `SMP`: TR-SMP-2026-00001.
--   * `media_attachments` — photos with GPS, capture time and sha256. A sample photo is one
--     of those, with a `sample_id`; no second media table.
--   * `commodities` — the reference list jobs already use.
--   * `branches` — the responsible office, and through it the country and the organisation.
--     Storing organisation_id and country_id on the sample as well would be two more copies
--     of a fact the office already carries, and two more chances for them to disagree.
--
-- What is new: the sample itself, its status history, and the chain of custody — which is the
-- point of the phase. Status is what the business thinks; custody is where the physical
-- sample actually was and who had it. They are deliberately two different tables.
--
-- Existing data: no samples are invented. The demo's 162 sampling jobs record their work as
-- checklist answers whose value fields are all empty — there is no seal number, no quantity
-- and no method in there to rebuild a sample from. That history stays in the checklist where
-- it is, and is documented as such in docs/DATABASE.md.
-- ---------------------------------------------------------------------------------------

-- ---------- Laboratories ------------------------------------------------------------------
/**
 * A minimal reference entity: where a sample is sent. Tests, methods and results are PHASE 6
 * and deliberately absent — a half-built LIMS here would only be rebuilt there.
 */
CREATE TABLE laboratories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  /** The office that runs it; NULL for an external laboratory the group only sends work to. */
  branch_id   uuid REFERENCES branches(id),
  country_id  uuid REFERENCES countries(id),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  city        text,
  address     text,
  timezone    text,
  /** An external laboratory is somebody else's; ours is one of our own offices. */
  is_external boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  contact_email text,
  contact_phone text,
  notes       text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER laboratories_updated_at BEFORE UPDATE ON laboratories
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE INDEX laboratories_branch_idx ON laboratories (branch_id) WHERE is_active;

-- ---------- Vocabularies ------------------------------------------------------------------
/**
 * Enums rather than lookup tables, because that is what this schema already does for a closed
 * business vocabulary (job_status, service_type, finding_severity, photo_category). Lookup
 * tables are used where rows are data the offices maintain — commodities, ports. Each list
 * carries `other` so an unforeseen case is recorded rather than forced into the wrong box.
 */
CREATE TYPE sample_status AS ENUM (
  'draft', 'collected', 'registered', 'sealed', 'dispatched',
  'received_by_lab', 'accepted_by_lab', 'rejected_by_lab', 'on_hold', 'cancelled'
);

CREATE TYPE sample_type AS ENUM (
  'representative', 'composite', 'increment', 'retention', 'reference',
  'control', 'counter_sample', 'other'
);

CREATE TYPE sampling_method AS ENUM (
  'manual', 'automatic', 'systematic', 'random', 'composite', 'incremental', 'other'
);

CREATE TYPE seal_condition AS ENUM ('intact', 'damaged', 'broken', 'missing');
CREATE TYPE sample_condition AS ENUM ('good', 'damaged', 'leaking', 'contaminated', 'insufficient', 'other');

CREATE TYPE sample_rejection_reason AS ENUM (
  'damaged', 'broken_seal', 'insufficient_quantity', 'wrong_sample',
  'missing_documentation', 'container_damage', 'other'
);

/**
 * Custody events are the physical story and do not map one-to-one onto status: a sample can
 * change hands three times without its status moving, and `in_transit` is a place a sample is,
 * not a decision anyone made about it.
 */
CREATE TYPE custody_event_type AS ENUM (
  'collected', 'registered', 'sealed', 'handover', 'dispatched', 'in_transit',
  'received', 'lab_received', 'lab_accepted', 'lab_rejected', 'returned', 'archived', 'correction'
);

-- ---------- Samples -----------------------------------------------------------------------
CREATE TABLE samples (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id               uuid NOT NULL REFERENCES branches(id),
  job_id                  uuid NOT NULL,
  /** Usually taken during an inspection; NULL when a sample is registered at the office. */
  inspection_id           uuid,
  client_id               uuid NOT NULL,
  sample_number           text NOT NULL UNIQUE,

  sample_type             sample_type NOT NULL DEFAULT 'representative',
  sampling_method         sampling_method NOT NULL DEFAULT 'manual',
  status                  sample_status NOT NULL DEFAULT 'draft',
  status_before_hold      sample_status,

  /** The reference list where the office keeps one, plus what the inspector actually wrote. */
  commodity_id            uuid REFERENCES commodities(id),
  commodity               text,
  commodity_details       text,
  quantity                numeric(18, 3),
  unit                    text,
  container_type          text,
  batch_lot_number        text,
  container_reference     text,
  location                text,

  /** Seal tracking: a sample's integrity is the whole reason the chain exists. */
  seal_number             text,
  seal_type               text,
  sealed_by               uuid REFERENCES users(id),
  sealed_at               timestamptz,
  seal_state              seal_condition,
  seal_broken_at          timestamptz,
  seal_broken_by          uuid REFERENCES users(id),

  sampled_by              uuid REFERENCES users(id),
  sampled_at              timestamptz,
  condition_notes         text,
  instructions            text,
  internal_notes          text,

  destination_laboratory_id uuid REFERENCES laboratories(id),
  dispatched_at           timestamptz,
  dispatched_by           uuid REFERENCES users(id),
  courier                 text,
  tracking_reference      text,
  package_count           integer,
  received_at             timestamptz,
  received_by             uuid REFERENCES users(id),
  received_condition      sample_condition,
  received_seal_condition seal_condition,
  lab_decision_at         timestamptz,
  lab_decision_by         uuid REFERENCES users(id),
  rejection_reason        sample_rejection_reason,
  rejection_notes         text,

  /** Grouping and derivation: a lot's primary, counter and retention samples travel together,
      and a laboratory will later split one sample into portions. Both are only the hooks. */
  sample_group            text,
  parent_sample_id        uuid REFERENCES samples(id),

  version                 integer NOT NULL DEFAULT 1,
  deleted_at              timestamptz,
  deleted_by              uuid REFERENCES users(id),
  created_by              uuid REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  UNIQUE (id, branch_id),
  FOREIGN KEY (job_id, branch_id) REFERENCES inspection_jobs (id, branch_id) ON DELETE CASCADE,
  FOREIGN KEY (inspection_id, branch_id) REFERENCES inspections (id, branch_id) ON DELETE SET NULL,
  FOREIGN KEY (client_id, branch_id) REFERENCES clients (id, branch_id),
  CHECK (quantity IS NULL OR quantity > 0),
  CHECK (package_count IS NULL OR package_count > 0)
);
CREATE TRIGGER samples_updated_at BEFORE UPDATE ON samples
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER samples_version BEFORE UPDATE ON samples
  FOR EACH ROW EXECUTE FUNCTION trg_bump_version();

CREATE INDEX samples_job_idx          ON samples (job_id)            WHERE deleted_at IS NULL;
CREATE INDEX samples_inspection_idx   ON samples (inspection_id)     WHERE deleted_at IS NULL;
CREATE INDEX samples_client_idx       ON samples (client_id)         WHERE deleted_at IS NULL;
CREATE INDEX samples_status_idx       ON samples (branch_id, status) WHERE deleted_at IS NULL;
CREATE INDEX samples_sampled_idx      ON samples (sampled_at DESC)   WHERE deleted_at IS NULL;
CREATE INDEX samples_sampler_idx      ON samples (sampled_by)        WHERE deleted_at IS NULL;
CREATE INDEX samples_lab_idx          ON samples (destination_laboratory_id) WHERE deleted_at IS NULL;
CREATE INDEX samples_updated_idx      ON samples (updated_at DESC)   WHERE deleted_at IS NULL;
CREATE INDEX samples_group_idx        ON samples (sample_group)      WHERE sample_group IS NOT NULL;
CREATE INDEX samples_parent_idx       ON samples (parent_sample_id)  WHERE parent_sample_id IS NOT NULL;
-- A seal number is looked up by hand at a laboratory counter, so it is indexed case-insensitively.
CREATE INDEX samples_seal_idx         ON samples (lower(seal_number)) WHERE seal_number IS NOT NULL;
CREATE INDEX samples_batch_idx        ON samples (lower(batch_lot_number)) WHERE batch_lot_number IS NOT NULL;

-- ---------- Status history (append-only) --------------------------------------------------
CREATE TABLE sample_status_history (
  id          bigserial PRIMARY KEY,
  sample_id   uuid NOT NULL,
  branch_id   uuid NOT NULL,
  from_status sample_status,
  to_status   sample_status NOT NULL,
  changed_by  uuid REFERENCES users(id),
  reason      text,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (sample_id, branch_id) REFERENCES samples (id, branch_id) ON DELETE CASCADE
);
CREATE INDEX sample_history_idx ON sample_status_history (sample_id, created_at);

-- ---------- Chain of custody (append-only) ------------------------------------------------
/**
 * Where the sample physically was, who held it, and in what condition it was handed over.
 *
 * Append-only in the strongest sense available: `gsi_app` is granted SELECT and INSERT and
 * nothing else, so neither a bug nor an administrator with a browser can rewrite a handover
 * after the fact. A mistake is corrected by recording a `correction` event that points at the
 * entry it corrects — the original stays, and so does the fact that somebody changed their
 * account of it.
 */
CREATE TABLE sample_custody_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_id          uuid NOT NULL,
  branch_id          uuid NOT NULL,
  event_type         custody_event_type NOT NULL,
  from_user_id       uuid REFERENCES users(id),
  from_office_id     uuid REFERENCES branches(id),
  from_location      text,
  to_user_id         uuid REFERENCES users(id),
  to_office_id       uuid REFERENCES branches(id),
  to_location        text,
  laboratory_id      uuid REFERENCES laboratories(id),
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  recorded_by        uuid REFERENCES users(id),
  seal_state         seal_condition,
  condition          sample_condition,
  notes              text,
  /** The handover note, dispatch document or photograph that evidences this event. */
  media_id           uuid,
  /** Set only on a `correction`: the entry whose account this one supersedes. */
  corrects_event_id  uuid REFERENCES sample_custody_events(id),
  metadata           jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (sample_id, branch_id) REFERENCES samples (id, branch_id) ON DELETE CASCADE,
  CHECK (event_type <> 'correction' OR corrects_event_id IS NOT NULL)
);
CREATE INDEX sample_custody_idx ON sample_custody_events (sample_id, occurred_at);
CREATE INDEX sample_custody_lab_idx ON sample_custody_events (laboratory_id) WHERE laboratory_id IS NOT NULL;

-- ---------- Photos and documents join the sample ------------------------------------------
ALTER TABLE media_attachments
  ADD COLUMN sample_id uuid,
  ADD CONSTRAINT media_sample_fk FOREIGN KEY (sample_id, branch_id)
      REFERENCES samples (id, branch_id) ON DELETE SET NULL;
CREATE INDEX media_sample_idx ON media_attachments (sample_id);

ALTER TABLE sample_custody_events
  ADD CONSTRAINT custody_media_fk FOREIGN KEY (media_id) REFERENCES media_attachments(id) ON DELETE SET NULL;

-- ---------- Row-Level Security ------------------------------------------------------------
/**
 * "Own" scope on a sample: the person who took it, or anyone on its inspection or its job.
 *
 * It takes the row's values rather than its id on purpose. A policy that looks the row up in
 * its own table cannot see a row the same statement is inserting — the sub-query runs against
 * the snapshot from before the command — so `INSERT … RETURNING` would be refused for exactly
 * the people who take samples for a living. Passing the columns sidesteps that entirely and is
 * one query cheaper besides. SECURITY DEFINER because it consults the assignment tables, which
 * have policies of their own.
 */
CREATE FUNCTION app_sample_is_mine(p_sampled_by uuid, p_created_by uuid, p_job uuid, p_inspection uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_sampled_by = app_user_id()
      OR p_created_by = app_user_id()
      OR app_is_assigned(p_job)
      OR (p_inspection IS NOT NULL AND app_is_on_inspection(p_inspection))
$$;
REVOKE ALL ON FUNCTION app_sample_is_mine(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_sample_is_mine(uuid, uuid, uuid, uuid) TO gsi_app;

/**
 * A sample dispatched to a laboratory has to become visible to the office that runs it, or
 * nobody there could receive it. Visibility follows the destination, not only the origin —
 * which is exactly what dispatching a sample means.
 */
CREATE FUNCTION app_sees_laboratory(p_lab uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_lab IS NOT NULL AND EXISTS (
    SELECT 1 FROM laboratories l
    WHERE l.id = p_lab AND l.branch_id IS NOT NULL AND app_can_see_branch(l.branch_id)
  )
$$;
REVOKE ALL ON FUNCTION app_sees_laboratory(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_sees_laboratory(uuid) TO gsi_app;

ALTER TABLE samples               ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE sample_custody_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE laboratories          ENABLE ROW LEVEL SECURITY;

CREATE POLICY samples_visible ON samples FOR ALL
  USING (app_is_live(deleted_at)
         AND (app_can_see_branch(branch_id) OR app_sees_laboratory(destination_laboratory_id))
         AND (app_scope() <> 'own'
              OR app_sample_is_mine(sampled_by, created_by, job_id, inspection_id)
              OR app_sees_laboratory(destination_laboratory_id)))
  WITH CHECK (app_can_see_branch(branch_id) OR app_sees_laboratory(destination_laboratory_id));

CREATE POLICY sample_history_read ON sample_status_history FOR SELECT
  USING (EXISTS (SELECT 1 FROM samples s WHERE s.id = sample_status_history.sample_id));
CREATE POLICY sample_history_write ON sample_status_history FOR INSERT WITH CHECK (true);

CREATE POLICY sample_custody_read ON sample_custody_events FOR SELECT
  USING (EXISTS (SELECT 1 FROM samples s WHERE s.id = sample_custody_events.sample_id));
CREATE POLICY sample_custody_write ON sample_custody_events FOR INSERT WITH CHECK (true);

-- Every office needs to know which laboratories exist in order to dispatch to them.
CREATE POLICY laboratories_read ON laboratories FOR SELECT USING (true);
CREATE POLICY laboratories_manage ON laboratories FOR ALL
  USING (app_has_perm('org.manage')) WITH CHECK (app_has_perm('org.manage'));

GRANT SELECT, INSERT, UPDATE, DELETE ON samples TO gsi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON laboratories TO gsi_app;
-- No UPDATE and no DELETE: the history and the chain of custody are append-only by grant,
-- not by good intentions in the service layer.
GRANT SELECT, INSERT ON sample_status_history TO gsi_app;
GRANT SELECT, INSERT ON sample_custody_events TO gsi_app;
GRANT USAGE, SELECT ON SEQUENCE sample_status_history_id_seq TO gsi_app;

-- ---------- Permissions -------------------------------------------------------------------
INSERT INTO permissions (code, category, description) VALUES
  ('sample.read',           'operations', 'See samples'),
  ('sample.create',         'operations', 'Record a sample'),
  ('sample.update',         'operations', 'Edit sample details'),
  ('sample.register',       'operations', 'Register a collected sample'),
  ('sample.seal',           'operations', 'Apply or break a seal'),
  ('sample.dispatch',       'operations', 'Dispatch a sample to a laboratory'),
  ('sample.receive',        'operations', 'Receive a sample'),
  ('sample.accept_lab',     'operations', 'Accept a sample at the laboratory'),
  ('sample.reject_lab',     'operations', 'Reject a sample at the laboratory'),
  ('sample.archive',        'operations', 'Archive a sample'),
  ('sample.restore',        'operations', 'Restore an archived sample'),
  ('sample.read_custody',   'operations', 'Read the chain of custody'),
  ('sample.add_attachment', 'operations', 'Attach photos and documents to a sample'),
  ('sample.print_label',    'operations', 'Print a sample label')
ON CONFLICT DO NOTHING;

-- Derived from the rights each role already has, for the same reason as in migration 013:
-- a role that has to be edited by hand is a role nobody updates.
INSERT INTO role_permissions (role_code, permission_code)
SELECT DISTINCT role_code, v.code FROM role_permissions rp,
  (VALUES ('sample.read'), ('sample.read_custody')) AS v(code)
WHERE rp.permission_code = 'inspection.read'
ON CONFLICT DO NOTHING;

-- Whoever does the field work takes the sample, seals it and labels it.
INSERT INTO role_permissions (role_code, permission_code)
SELECT DISTINCT role_code, v.code FROM role_permissions rp,
  (VALUES ('sample.create'), ('sample.update'), ('sample.seal'),
          ('sample.add_attachment'), ('sample.print_label')) AS v(code)
WHERE rp.permission_code = 'inspection.start'
ON CONFLICT DO NOTHING;

-- Registering and dispatching is office work.
INSERT INTO role_permissions (role_code, permission_code)
SELECT DISTINCT role_code, v.code FROM role_permissions rp,
  (VALUES ('sample.register'), ('sample.dispatch'), ('sample.archive')) AS v(code)
WHERE rp.permission_code = 'inspection.create'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'sample.restore' FROM roles
WHERE code IN ('admin', 'country_manager', 'office_manager', 'supervisor')
ON CONFLICT DO NOTHING;

-- The laboratory side of the counter: receiving and the accept/reject decision.
INSERT INTO role_permissions (role_code, permission_code)
SELECT r.code, v.code FROM roles r,
  (VALUES ('sample.read'), ('sample.read_custody'), ('sample.receive'),
          ('sample.accept_lab'), ('sample.reject_lab'), ('sample.add_attachment')) AS v(code)
WHERE r.code IN ('lab_manager', 'lab_analyst')
ON CONFLICT DO NOTHING;

-- Samplers take samples; that is the whole job.
INSERT INTO role_permissions (role_code, permission_code)
SELECT r.code, v.code FROM roles r,
  (VALUES ('sample.read'), ('sample.read_custody'), ('sample.create'), ('sample.update'),
          ('sample.seal'), ('sample.add_attachment'), ('sample.print_label')) AS v(code)
WHERE r.code = 'sampler'
ON CONFLICT DO NOTHING;

-- ---------- No laboratories are invented here ---------------------------------------------
-- The table is created empty on purpose. Nothing in this database says which offices actually
-- run a laboratory — no office has a laboratory department recorded — so inventing one per
-- branch would be fabricating facilities that may not exist. Laboratories are entered by an
-- administrator (`org.manage`), and the demo seed creates its own, marked as demo data.
