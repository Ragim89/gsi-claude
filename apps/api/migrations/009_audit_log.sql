-- ---------------------------------------------------------------------------------------
-- 009. Audit log.
--
-- An inspection company has to be able to answer "who changed this, and when" about every
-- document it issues — that is what accreditation bodies ask for. The log therefore records
-- the actor, the action, the entity, and what the values were before and after.
--
-- It is append-only by construction: the application role may INSERT and SELECT, and has no
-- UPDATE or DELETE grant at all. Not even an administrator can rewrite history through the
-- API; only the database owner can, and that leaves its own trace in the server logs.
-- ---------------------------------------------------------------------------------------

CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  /** Who. Kept as plain columns as well, so the entry stays readable after a user is removed. */
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  user_email   text,
  user_role    text,
  branch_id    uuid REFERENCES branches(id) ON DELETE SET NULL,
  /** What: a dotted verb from the same vocabulary as permissions (job.approve, invoice.pay). */
  action       text NOT NULL,
  entity_type  text,
  entity_id    uuid,
  /** Human-readable handle of the record: job number, invoice number, client name. */
  entity_label text,
  /** Only the fields that changed, not whole rows. */
  before_data  jsonb,
  after_data   jsonb,
  /** Anything else worth keeping: reason for a rejection, file name of an import, row counts. */
  metadata     jsonb,
  ip_address   inet,
  user_agent   text,
  request_id   text
);

CREATE INDEX audit_logs_occurred_idx ON audit_logs (occurred_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_logs_user_idx ON audit_logs (user_id, occurred_at DESC);
CREATE INDEX audit_logs_branch_idx ON audit_logs (branch_id, occurred_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, occurred_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Reading the log needs an explicit permission and stays inside the caller's scope.
CREATE POLICY audit_read ON audit_logs FOR SELECT
  USING (app_has_perm('audit.read') AND (branch_id IS NULL OR app_can_see_branch(branch_id)));

-- Writing is unconditional: an action must never fail to be recorded because of a policy,
-- and the entry always carries the context of whoever performed it.
CREATE POLICY audit_write ON audit_logs FOR INSERT WITH CHECK (true);

GRANT SELECT, INSERT ON audit_logs TO gsi_app;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO gsi_app;
-- Deliberately no UPDATE or DELETE grant.
