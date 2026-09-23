-- ---------------------------------------------------------------------------------------
-- 010. Soft delete for business records.
--
-- Deleting a client, a job, an invoice or an asset removed the row for good. For an
-- inspection company that is unacceptable: those records are evidence, and a mistaken click
-- destroyed them. Records are now archived — hidden from every list, still there for the
-- audit trail and recoverable by an administrator.
--
-- Reports are not in this list on purpose: an issued report is never removed, not even
-- softly. It can be revoked, which is a status, and revocation stays visible.
-- ---------------------------------------------------------------------------------------

ALTER TABLE clients         ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by uuid REFERENCES users(id);
ALTER TABLE inspection_jobs ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by uuid REFERENCES users(id);
ALTER TABLE invoices        ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by uuid REFERENCES users(id);
ALTER TABLE expenses        ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by uuid REFERENCES users(id);
ALTER TABLE assets          ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by uuid REFERENCES users(id);

-- Partial indexes: every list query filters on "not archived", which is almost every row.
CREATE INDEX clients_active_idx  ON clients (branch_id) WHERE deleted_at IS NULL;
CREATE INDEX jobs_active_idx     ON inspection_jobs (branch_id, status) WHERE deleted_at IS NULL;
CREATE INDEX invoices_active_idx ON invoices (branch_id, status) WHERE deleted_at IS NULL;
CREATE INDEX expenses_active_idx ON expenses (branch_id, expense_date) WHERE deleted_at IS NULL;
CREATE INDEX assets_active_idx   ON assets (branch_id, status) WHERE deleted_at IS NULL;

-- An inventory number may be reused once the old asset is archived, but not while it is live.
-- The constraint owns its index, so it is the constraint that has to go.
ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_branch_id_inventory_no_key;
CREATE UNIQUE INDEX assets_inventory_no_active_idx
  ON assets (branch_id, inventory_no) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------------------
-- Hiding archived rows is the policies' job, not every query's.
--
-- Putting "deleted_at IS NULL" into each SELECT would work until the first query that forgot
-- it. In the USING clause it applies to every read, update and delete, for code written today
-- and code written next year. WITH CHECK deliberately does NOT carry the condition — archiving
-- a row is itself an UPDATE that sets deleted_at, and it has to be allowed to succeed.
--
-- An administrator restoring something sets app.include_archived = 'on' for that transaction.
-- ---------------------------------------------------------------------------------------

CREATE FUNCTION app_show_archived() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT COALESCE(current_setting('app.include_archived', true) = 'on', false) $$;

CREATE FUNCTION app_is_live(p_deleted_at timestamptz) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT p_deleted_at IS NULL OR app_show_archived() $$;

GRANT EXECUTE ON FUNCTION app_show_archived(), app_is_live(timestamptz) TO gsi_app;

DROP POLICY clients_branch ON clients;
CREATE POLICY clients_branch ON clients FOR ALL
  USING (app_can_see_branch(branch_id) AND app_is_live(deleted_at))
  WITH CHECK (app_can_see_branch(branch_id));

DROP POLICY jobs_branch ON inspection_jobs;
CREATE POLICY jobs_branch ON inspection_jobs FOR ALL
  USING (app_can_see_branch(branch_id)
         AND app_is_live(deleted_at)
         AND (app_scope() <> 'own' OR assigned_inspector_id = app_user_id()))
  WITH CHECK (app_can_see_branch(branch_id));

DROP POLICY invoices_branch ON invoices;
CREATE POLICY invoices_branch ON invoices FOR ALL
  USING (app_sees_finance() AND app_can_see_branch(branch_id) AND app_is_live(deleted_at))
  WITH CHECK (app_sees_finance() AND app_can_see_branch(branch_id));

DROP POLICY expenses_branch ON expenses;
CREATE POLICY expenses_branch ON expenses FOR ALL
  USING (app_sees_finance() AND app_can_see_branch(branch_id) AND app_is_live(deleted_at))
  WITH CHECK (app_sees_finance() AND app_can_see_branch(branch_id));

DROP POLICY assets_branch ON assets;
CREATE POLICY assets_branch ON assets FOR ALL
  USING (app_sees_finance() AND app_can_see_branch(branch_id) AND app_is_live(deleted_at))
  WITH CHECK (app_sees_finance() AND app_can_see_branch(branch_id));
