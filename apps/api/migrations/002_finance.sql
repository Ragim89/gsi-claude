-- =====================================================================================
-- Finance & billing (docs/01-architecture.md modules 6–7, docs/03-finance-dashboard.md)
--
-- Every money row carries branch_id and the same Row-Level Security rules as MVP-1.
-- Amounts are stored twice: in the branch's accounting currency AND converted to the
-- group consolidation currency at the fx rate of the posting date ("хранить сумму в
-- валюте филиала И в валюте консолидации").
--
-- ASSUMPTION: the consolidation currency is EUR (docs/01 suggests "EUR или USD", GSI has
-- not confirmed). It is configurable through CONSOLIDATION_CURRENCY on the API.
-- =====================================================================================

CREATE TYPE invoice_status AS ENUM ('draft', 'issued', 'partially_paid', 'paid', 'cancelled');
CREATE TYPE expense_category AS ENUM (
  'salary', 'travel', 'subcontractor', 'lab_materials', 'equipment', 'office', 'other'
);
-- Minimal chart-of-account grouping needed by the dashboard. A per-branch chart of
-- accounts mapped onto the group plan (docs/01) comes with the accounting integration.
CREATE TYPE account_group AS ENUM ('revenue', 'expense', 'receivable', 'cash', 'tax');

-- ---------- fx_rates -----------------------------------------------------------------
-- Group-wide reference data: readable by every authenticated user, writable by HQ.
CREATE TABLE fx_rates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  currency       char(3) NOT NULL,           -- branch accounting currency
  base_currency  char(3) NOT NULL,           -- consolidation currency
  rate           numeric(20, 10) NOT NULL CHECK (rate > 0),  -- 1 currency = rate base
  rate_date      date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (currency, base_currency, rate_date)
);
CREATE INDEX fx_rates_lookup_idx ON fx_rates (currency, base_currency, rate_date DESC);

-- Latest rate on or before a date; 1.0 when the branch already uses the base currency.
CREATE FUNCTION fx_rate_on(p_currency char(3), p_base char(3), p_date date)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_currency = p_base THEN 1::numeric ELSE (
    SELECT r.rate FROM fx_rates r
    WHERE r.currency = p_currency AND r.base_currency = p_base AND r.rate_date <= p_date
    ORDER BY r.rate_date DESC LIMIT 1
  ) END
$$;

-- ---------- invoices -----------------------------------------------------------------
CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  client_id       uuid NOT NULL,
  job_id          uuid,                       -- invoice raised for an inspection job
  invoice_number  text NOT NULL UNIQUE,
  status          invoice_status NOT NULL DEFAULT 'draft',
  currency        char(3) NOT NULL,           -- branch accounting currency
  amount_net      numeric(14, 2) NOT NULL DEFAULT 0,
  tax_rate        numeric(5, 2) NOT NULL DEFAULT 0,   -- VAT/KDV per country
  tax_amount      numeric(14, 2) NOT NULL DEFAULT 0,
  amount_total    numeric(14, 2) NOT NULL DEFAULT 0,
  amount_paid     numeric(14, 2) NOT NULL DEFAULT 0,
  issue_date      date NOT NULL DEFAULT current_date,
  due_date        date,
  paid_at         timestamptz,
  notes           text,
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, branch_id),
  FOREIGN KEY (client_id, branch_id) REFERENCES clients (id, branch_id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id, branch_id) REFERENCES inspection_jobs (id, branch_id) ON DELETE SET NULL,
  CHECK (amount_paid >= 0 AND amount_paid <= amount_total + 0.01)
);
CREATE INDEX invoices_branch_status_idx ON invoices (branch_id, status, issue_date DESC);
CREATE INDEX invoices_client_idx ON invoices (client_id);
CREATE INDEX invoices_due_idx ON invoices (due_date) WHERE status IN ('issued', 'partially_paid');
CREATE TRIGGER invoices_updated_at BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

CREATE TABLE invoice_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL,
  invoice_id  uuid NOT NULL,
  description text NOT NULL,
  quantity    numeric(12, 3) NOT NULL DEFAULT 1,
  unit_price  numeric(14, 2) NOT NULL DEFAULT 0,
  amount      numeric(14, 2) GENERATED ALWAYS AS (round(quantity * unit_price, 2)) STORED,
  sort_order  integer NOT NULL DEFAULT 0,
  FOREIGN KEY (invoice_id, branch_id) REFERENCES invoices (id, branch_id) ON DELETE CASCADE
);
CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (invoice_id);

CREATE FUNCTION trg_inherit_invoice_branch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.branch_id := (SELECT i.branch_id FROM invoices i WHERE i.id = NEW.invoice_id);
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_lines_branch BEFORE INSERT ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION trg_inherit_invoice_branch();

-- ---------- expenses -----------------------------------------------------------------
CREATE TABLE expenses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     uuid NOT NULL REFERENCES branches(id),
  category      expense_category NOT NULL,
  description   text NOT NULL,
  supplier      text,
  currency      char(3) NOT NULL,
  amount        numeric(14, 2) NOT NULL CHECK (amount >= 0),
  expense_date  date NOT NULL DEFAULT current_date,
  job_id        uuid,                          -- direct cost of an inspection
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, branch_id),
  FOREIGN KEY (job_id, branch_id) REFERENCES inspection_jobs (id, branch_id) ON DELETE SET NULL
);
CREATE INDEX expenses_branch_date_idx ON expenses (branch_id, expense_date DESC);
CREATE TRIGGER expenses_updated_at BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ---------- ledger_entries -----------------------------------------------------------
-- Every financial event (invoice issued, payment received, expense booked) is written
-- here immediately — the basis of the real-time dashboard (docs/03, §"Техническая механика").
CREATE TABLE ledger_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      uuid NOT NULL REFERENCES branches(id),
  entry_date     date NOT NULL DEFAULT current_date,
  account        text NOT NULL,               -- e.g. 'revenue.services', 'ar.trade', 'cash.bank'
  account_group  account_group NOT NULL,
  debit          numeric(14, 2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit         numeric(14, 2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  currency       char(3) NOT NULL,            -- branch currency
  amount_base    numeric(14, 2) NOT NULL,     -- signed (debit - credit) in consolidation currency
  base_currency  char(3) NOT NULL,
  fx_rate        numeric(20, 10) NOT NULL,
  source_type    text NOT NULL,               -- 'invoice' | 'payment' | 'expense'
  source_id      uuid,
  description    text,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_branch_date_idx ON ledger_entries (branch_id, entry_date);
CREATE INDEX ledger_group_date_idx ON ledger_entries (account_group, entry_date);
CREATE INDEX ledger_source_idx ON ledger_entries (source_type, source_id);

-- ---------- incremental dashboard aggregate ------------------------------------------
-- Maintained by a trigger on ledger_entries: the dashboard never rescans the ledger
-- ("агрегаты пересчитываются инкрементально, не полным пересчётом БД").
CREATE TABLE finance_daily_agg (
  branch_id      uuid NOT NULL REFERENCES branches(id),
  entry_date     date NOT NULL,
  account_group  account_group NOT NULL,
  amount_local   numeric(16, 2) NOT NULL DEFAULT 0,   -- signed, branch currency
  amount_base    numeric(16, 2) NOT NULL DEFAULT 0,   -- signed, consolidation currency
  entry_count    integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, entry_date, account_group)
);

CREATE FUNCTION trg_ledger_agg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO finance_daily_agg AS a (branch_id, entry_date, account_group, amount_local, amount_base, entry_count)
  VALUES (NEW.branch_id, NEW.entry_date, NEW.account_group, NEW.debit - NEW.credit, NEW.amount_base, 1)
  ON CONFLICT (branch_id, entry_date, account_group) DO UPDATE
    SET amount_local = a.amount_local + EXCLUDED.amount_local,
        amount_base  = a.amount_base + EXCLUDED.amount_base,
        entry_count  = a.entry_count + 1,
        updated_at   = now();
  -- Wakes up the SSE stream feeding the dashboard (docs/03: event-driven, not polling).
  PERFORM pg_notify('gsi_finance', json_build_object(
    'branchId', NEW.branch_id, 'group', NEW.account_group, 'date', NEW.entry_date,
    'amountBase', NEW.amount_base, 'source', NEW.source_type)::text);
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_agg AFTER INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION trg_ledger_agg();

-- ---------- Row-Level Security --------------------------------------------------------
ALTER TABLE invoices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines     ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_daily_agg ENABLE ROW LEVEL SECURITY;
ALTER TABLE fx_rates          ENABLE ROW LEVEL SECURITY;

-- ASSUMPTION: field inspectors have no business with money; finance data is limited to
-- finance_controller (own branch), supervisor (own branch, read), and HQ (cfo/admin).
CREATE FUNCTION app_sees_finance() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT COALESCE(app_role() IN ('finance_controller', 'supervisor', 'cfo', 'admin'), false) $$;

CREATE POLICY invoices_branch ON invoices FOR ALL
  USING (app_sees_finance() AND (app_is_hq() OR branch_id = app_branch_id()))
  WITH CHECK (app_sees_finance() AND (app_is_hq() OR branch_id = app_branch_id()));

CREATE POLICY invoice_lines_branch ON invoice_lines FOR ALL
  USING (app_sees_finance() AND (app_is_hq() OR branch_id = app_branch_id())
         AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_lines.invoice_id))
  WITH CHECK (app_sees_finance() AND (app_is_hq() OR branch_id = app_branch_id())
         AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_lines.invoice_id));

CREATE POLICY expenses_branch ON expenses FOR ALL
  USING (app_sees_finance() AND (app_is_hq() OR branch_id = app_branch_id()))
  WITH CHECK (app_sees_finance() AND (app_is_hq() OR branch_id = app_branch_id()));

CREATE POLICY ledger_branch ON ledger_entries FOR ALL
  USING (app_sees_finance() AND (app_is_hq() OR branch_id = app_branch_id()))
  WITH CHECK (app_sees_finance() AND (app_is_hq() OR branch_id = app_branch_id()));

CREATE POLICY agg_branch ON finance_daily_agg FOR SELECT
  USING (app_sees_finance() AND (app_is_hq() OR branch_id = app_branch_id()));

CREATE POLICY fx_read ON fx_rates FOR SELECT USING (app_role() IS NOT NULL);
CREATE POLICY fx_write ON fx_rates FOR ALL
  USING (COALESCE(app_role() IN ('cfo', 'admin', 'finance_controller'), false))
  WITH CHECK (COALESCE(app_role() IN ('cfo', 'admin', 'finance_controller'), false));

GRANT SELECT, INSERT, UPDATE, DELETE ON invoices, invoice_lines, expenses, ledger_entries, fx_rates TO gsi_app;
GRANT SELECT ON finance_daily_agg TO gsi_app;
GRANT EXECUTE ON FUNCTION fx_rate_on(char, char, date) TO gsi_app;
