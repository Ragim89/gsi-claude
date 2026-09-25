-- =====================================================================================
-- PHASE 8 (3/3): Payments as their own entity, accounts payable, overdue reminder hooks.
--
-- Until now "payment" was not a record, only a side-effect: InvoicesService.pay() updated
-- invoices.amount_paid and posted straight to the ledger. That flow keeps working exactly as
-- it did (see PaymentsService.create() in the API) — this migration only adds what it never
-- had: a payment as a thing with its own id, method and reference; the ability to split one
-- payment across several invoices or leave part of it unallocated (an on-account payment, or
-- an overpayment); and the same idea in reverse for expenses, so a recorded cost is not
-- silently assumed paid the moment it is entered.
--
-- The accumulated-depreciation asset group was added the same way in 005_assets.sql: a plain
-- ALTER TYPE, with the new value never referenced again in this same file (Postgres refuses
-- to use a new enum value inside the transaction that added it).
-- =====================================================================================

CREATE TYPE payment_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE payment_method AS ENUM ('bank_transfer', 'cash', 'card', 'cheque', 'other');
CREATE TYPE expense_payment_status AS ENUM ('unpaid', 'partially_paid', 'paid');

-- The liability side of "we owe a supplier"; 'receivable' already covers what a client owes us.
ALTER TYPE account_group ADD VALUE IF NOT EXISTS 'payable';

-- ---------- payments -------------------------------------------------------------------
CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id    uuid NOT NULL REFERENCES branches(id),
  direction    payment_direction NOT NULL,
  client_id    uuid,              -- inbound: who paid us
  supplier     text,              -- outbound: who we paid (free text, same convention as expenses.supplier)
  method       payment_method NOT NULL DEFAULT 'bank_transfer',
  reference    text,              -- bank reference, cheque number, transaction id
  currency     char(3) NOT NULL,
  amount       numeric(14, 2) NOT NULL CHECK (amount > 0),
  payment_date date NOT NULL DEFAULT current_date,
  notes        text,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, branch_id),
  FOREIGN KEY (client_id, branch_id) REFERENCES clients (id, branch_id) ON DELETE RESTRICT,
  CHECK ((direction = 'inbound' AND client_id IS NOT NULL) OR (direction = 'outbound' AND client_id IS NULL))
);
CREATE INDEX payments_branch_idx ON payments (branch_id, payment_date DESC);
CREATE INDEX payments_client_idx ON payments (client_id) WHERE client_id IS NOT NULL;

-- What a payment was applied to. A payment may be split across several invoices (or
-- expenses), and need not be fully allocated at all — the unapplied remainder is simply
-- `payments.amount - SUM(payment_allocations.amount)`, read live rather than stored, so there
-- is exactly one place that number can be wrong.
CREATE TABLE payment_allocations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL,
  payment_id  uuid NOT NULL,
  invoice_id  uuid,
  expense_id  uuid,
  amount      numeric(14, 2) NOT NULL CHECK (amount > 0),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (payment_id, branch_id) REFERENCES payments (id, branch_id) ON DELETE CASCADE,
  FOREIGN KEY (invoice_id, branch_id) REFERENCES invoices (id, branch_id) ON DELETE RESTRICT,
  FOREIGN KEY (expense_id, branch_id) REFERENCES expenses (id, branch_id) ON DELETE RESTRICT,
  -- Exactly one target: an inbound payment allocates to an invoice, an outbound one to an expense.
  CHECK ((invoice_id IS NOT NULL) <> (expense_id IS NOT NULL))
);
CREATE INDEX payment_allocations_payment_idx ON payment_allocations (payment_id);
CREATE INDEX payment_allocations_invoice_idx ON payment_allocations (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX payment_allocations_expense_idx ON payment_allocations (expense_id) WHERE expense_id IS NOT NULL;

CREATE FUNCTION trg_inherit_payment_branch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.branch_id := (SELECT p.branch_id FROM payments p WHERE p.id = NEW.payment_id);
  RETURN NEW;
END $$;
CREATE TRIGGER payment_allocations_branch BEFORE INSERT ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION trg_inherit_payment_branch();

-- ---------- accounts payable for expenses -----------------------------------------------
-- Existing rows keep meaning exactly what the code already assumed of them (expenses.service.ts,
-- "ASSUMPTION: expenses are recorded as paid immediately"): the default is 'paid', so nothing
-- about a single historical expense changes. Only a newly created on-account expense starts
-- 'unpaid' and waits for an outbound payment.
ALTER TABLE expenses ADD COLUMN payment_status expense_payment_status NOT NULL DEFAULT 'paid';
CREATE INDEX expenses_unpaid_idx ON expenses (branch_id, expense_date)
  WHERE payment_status <> 'paid' AND deleted_at IS NULL;

-- ---------- overdue reminders: a hook, not a send ---------------------------------------
-- No notification/e-mail adapter exists yet (PHASE 10). This only records that someone chased
-- an overdue invoice — who, when, what was said — which is the seam PHASE 10 wires an actual
-- send into. It is deliberately append-only, like every other history table.
CREATE TABLE invoice_reminders (
  id          bigserial PRIMARY KEY,
  invoice_id  uuid NOT NULL,
  branch_id   uuid NOT NULL,
  note        text,
  sent_by     uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (invoice_id, branch_id) REFERENCES invoices (id, branch_id) ON DELETE CASCADE
);
CREATE INDEX invoice_reminders_invoice_idx ON invoice_reminders (invoice_id, created_at DESC);

-- ---------- Row-Level Security -----------------------------------------------------------
ALTER TABLE payments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_reminders   ENABLE ROW LEVEL SECURITY;

CREATE POLICY payments_branch ON payments FOR ALL
  USING (app_has_perm('payment.read') AND app_can_see_branch(branch_id))
  WITH CHECK (app_has_perm('payment.read') AND app_can_see_branch(branch_id));

CREATE POLICY payment_allocations_branch ON payment_allocations FOR ALL
  USING (app_has_perm('payment.read') AND app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_allocations.payment_id))
  WITH CHECK (app_has_perm('payment.read') AND app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM payments p WHERE p.id = payment_allocations.payment_id));

CREATE POLICY invoice_reminders_read ON invoice_reminders FOR SELECT
  USING (app_sees_finance() AND app_can_see_branch(branch_id));
CREATE POLICY invoice_reminders_insert ON invoice_reminders FOR INSERT
  WITH CHECK (app_has_perm('invoice.remind') AND app_can_see_branch(branch_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON payments, payment_allocations TO gsi_app;
GRANT SELECT, INSERT ON invoice_reminders TO gsi_app;
GRANT USAGE, SELECT ON SEQUENCE invoice_reminders_id_seq TO gsi_app;

-- ---------- Permissions --------------------------------------------------------------------
INSERT INTO permissions (code, category, description) VALUES
  ('payment.read',     'finance', 'See payments'),
  ('payment.create',   'finance', 'Register a payment received from a client'),
  ('payment.allocate', 'finance', 'Apply a payment to invoices, or move it between them'),
  ('expense.pay',      'finance', 'Register a payment made against an on-account expense'),
  ('invoice.remind',   'finance', 'Log an overdue-invoice reminder')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'payment.read' FROM roles
WHERE code IN ('admin', 'cfo', 'country_manager', 'office_manager', 'supervisor',
               'finance_controller', 'sales')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT roles.code, v.code FROM roles,
  (VALUES ('payment.create'), ('payment.allocate'), ('expense.pay')) AS v(code)
WHERE roles.code IN ('admin', 'country_manager', 'finance_controller')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'invoice.remind' FROM roles
WHERE code IN ('admin', 'country_manager', 'office_manager', 'supervisor', 'finance_controller', 'sales')
ON CONFLICT DO NOTHING;
