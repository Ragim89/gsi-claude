-- =====================================================================================
-- PHASE 8 (2/3): Quotes.
--
-- A quote is a commercial offer, not a legal document: it is disposable and re-sendable,
-- so unlike a report it does not need frozen, immutable revisions — going back to draft and
-- sending again is normal business, not a correction that has to leave a trace of what was
-- printed before. It gets the same shape as an invoice (header + lines) and the same kind of
-- workflow engine as every other lifecycle in this system: one service, one place that writes
-- the status, an append-only history table alongside it.
-- =====================================================================================

CREATE TYPE quote_status AS ENUM ('draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled');

CREATE TABLE quotes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id    uuid NOT NULL REFERENCES branches(id),
  client_id    uuid NOT NULL,
  job_id       uuid,                      -- a quote may be prepared for an existing draft job
  quote_number text NOT NULL UNIQUE,
  status       quote_status NOT NULL DEFAULT 'draft',
  currency     char(3) NOT NULL,
  amount_net   numeric(14, 2) NOT NULL DEFAULT 0,
  tax_rate     numeric(5, 2) NOT NULL DEFAULT 0,
  tax_amount   numeric(14, 2) NOT NULL DEFAULT 0,
  amount_total numeric(14, 2) NOT NULL DEFAULT 0,
  issue_date   date NOT NULL DEFAULT current_date,
  valid_until  date,
  sent_at      timestamptz,
  decided_at   timestamptz,               -- when it was accepted, rejected or expired
  decision_note text,
  notes        text,
  version      integer NOT NULL DEFAULT 1,   -- optimistic locking, same convention as jobs/inspections
  deleted_at   timestamptz,
  deleted_by   uuid REFERENCES users(id),
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, branch_id),
  FOREIGN KEY (client_id, branch_id) REFERENCES clients (id, branch_id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id, branch_id) REFERENCES inspection_jobs (id, branch_id) ON DELETE SET NULL,
  CHECK (valid_until IS NULL OR valid_until >= issue_date)
);
CREATE INDEX quotes_branch_status_idx ON quotes (branch_id, status, issue_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX quotes_client_idx ON quotes (client_id) WHERE deleted_at IS NULL;
CREATE TRIGGER quotes_updated_at BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
-- trg_bump_version() already exists (012_jobs_lifecycle.sql) and is a plain generic trigger.
CREATE TRIGGER quotes_version BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION trg_bump_version();

CREATE TABLE quote_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL,
  quote_id    uuid NOT NULL,
  service_id  uuid REFERENCES services(id) ON DELETE SET NULL,
  description text NOT NULL,
  quantity    numeric(12, 3) NOT NULL DEFAULT 1,
  unit_price  numeric(14, 2) NOT NULL DEFAULT 0,
  amount      numeric(14, 2) GENERATED ALWAYS AS (round(quantity * unit_price, 2)) STORED,
  sort_order  integer NOT NULL DEFAULT 0,
  FOREIGN KEY (quote_id, branch_id) REFERENCES quotes (id, branch_id) ON DELETE CASCADE
);
CREATE INDEX quote_lines_quote_idx ON quote_lines (quote_id);

CREATE FUNCTION trg_inherit_quote_branch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.branch_id := (SELECT q.branch_id FROM quotes q WHERE q.id = NEW.quote_id);
  RETURN NEW;
END $$;
CREATE TRIGGER quote_lines_branch BEFORE INSERT ON quote_lines
  FOR EACH ROW EXECUTE FUNCTION trg_inherit_quote_branch();

CREATE TABLE quote_status_history (
  id          bigserial PRIMARY KEY,
  quote_id    uuid NOT NULL,
  branch_id   uuid NOT NULL,
  from_status quote_status,
  to_status   quote_status NOT NULL,
  changed_by  uuid REFERENCES users(id),
  reason      text,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (quote_id, branch_id) REFERENCES quotes (id, branch_id) ON DELETE CASCADE
);
CREATE INDEX quote_status_history_quote_idx ON quote_status_history (quote_id, created_at);

-- A job may reference the quote it was priced from. Composite key keeps both in the same office.
ALTER TABLE inspection_jobs
  ADD COLUMN quote_id uuid,
  ADD CONSTRAINT jobs_quote_fk FOREIGN KEY (quote_id, branch_id)
      REFERENCES quotes (id, branch_id) ON DELETE SET NULL;
CREATE INDEX jobs_quote_ref_idx ON inspection_jobs (quote_id) WHERE quote_id IS NOT NULL;

-- ---------- Row-Level Security --------------------------------------------------------
ALTER TABLE quotes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_lines          ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_status_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY quotes_branch ON quotes FOR ALL
  USING (app_has_perm('quote.read') AND app_can_see_branch(branch_id) AND app_is_live(deleted_at))
  WITH CHECK (app_has_perm('quote.read') AND app_can_see_branch(branch_id));

CREATE POLICY quote_lines_branch ON quote_lines FOR ALL
  USING (app_has_perm('quote.read') AND app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_lines.quote_id))
  WITH CHECK (app_has_perm('quote.read') AND app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_lines.quote_id));

-- Append-only from the application's point of view: gsi_app gets SELECT/INSERT only.
CREATE POLICY quote_status_history_branch ON quote_status_history FOR SELECT
  USING (app_has_perm('quote.read') AND app_can_see_branch(branch_id));
CREATE POLICY quote_status_history_insert ON quote_status_history FOR INSERT
  WITH CHECK (app_has_perm('quote.read') AND app_can_see_branch(branch_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON quotes, quote_lines TO gsi_app;
GRANT SELECT, INSERT ON quote_status_history TO gsi_app;
GRANT USAGE, SELECT ON SEQUENCE quote_status_history_id_seq TO gsi_app;

-- ---------- Permissions ----------------------------------------------------------------
INSERT INTO permissions (code, category, description) VALUES
  ('quote.read',    'finance', 'See quotes'),
  ('quote.create',  'finance', 'Create quotes'),
  ('quote.update',  'finance', 'Edit a draft quote'),
  ('quote.send',    'finance', 'Send a quote to the client'),
  ('quote.decide',  'finance', 'Record whether a sent quote was accepted, rejected or expired'),
  ('quote.cancel',  'finance', 'Cancel a quote'),
  ('quote.archive', 'finance', 'Archive a quote'),
  ('quote.restore', 'finance', 'Restore an archived quote')
ON CONFLICT DO NOTHING;

-- A quote carries commercial terms, same isolation reasoning as contract.read (PHASE 2):
-- field and laboratory roles are left out.
INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'quote.read' FROM roles
WHERE code IN ('admin', 'cfo', 'country_manager', 'office_manager', 'supervisor', 'operations',
               'finance_controller', 'sales', 'report_reviewer', 'viewer')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT roles.code, v.code FROM roles,
  (VALUES ('quote.create'), ('quote.update'), ('quote.send'), ('quote.decide'), ('quote.cancel')) AS v(code)
WHERE roles.code IN ('admin', 'country_manager', 'office_manager', 'supervisor', 'finance_controller', 'sales')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT roles.code, v.code FROM roles, (VALUES ('quote.archive'), ('quote.restore')) AS v(code)
WHERE roles.code IN ('admin', 'country_manager', 'office_manager', 'supervisor')
ON CONFLICT DO NOTHING;
