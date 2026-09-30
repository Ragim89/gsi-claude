-- =====================================================================================
-- 032. Permission for the Capitalization screen.
--
-- No schema change: Capitalization is a read-only aggregation over `ledger_entries` /
-- `finance_daily_agg` (account_group cash/receivable/payable — `payable` already exists as
-- an account_group value since 021_finance_payments.sql, confirmed by reading that file, so
-- no enum change is needed here) plus `assets` net book value. Never a second ledger.
--
-- Granted to exactly the roles that already hold `finance.read` (008_rbac.sql) — the
-- role_permissions INSERTs there ran once against the permissions that existed at the time,
-- so a permission added in a later migration needs its own explicit grant even for roles
-- like `admin`/`country_manager` whose original grant was "everything"/"everything but X".
-- =====================================================================================

INSERT INTO permissions (code, category, description) VALUES
  ('capitalization.read', 'finance', 'See the group/branch capitalization breakdown')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'capitalization.read' FROM roles
WHERE code IN ('admin', 'cfo', 'country_manager', 'office_manager', 'supervisor', 'finance_controller')
ON CONFLICT DO NOTHING;
