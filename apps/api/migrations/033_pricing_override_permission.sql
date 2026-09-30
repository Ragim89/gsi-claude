-- =====================================================================================
-- 033. Permission for overriding a job line's resolved price.
--
-- Job lines are always priced server-side via app_resolve_price (019_finance_services_pricing.sql,
-- JobsService.createLines) — a caller can never dictate a job line's price. This adds a single,
-- narrowly-scoped exception: an authorized user may supply a manual unit price/currency for a
-- job line instead of (or when there is no) resolved price. Granted to exactly the roles that
-- already hold pricing.manage (whoever has fx.manage — see 019_finance_services_pricing.sql) —
-- the role_permissions INSERTs there ran once against the permissions that existed at the time,
-- so this needs its own explicit grant even for admin/cfo, same note as
-- 032_capitalization_permission.sql.
-- =====================================================================================

INSERT INTO permissions (code, category, description) VALUES
  ('pricing.override', 'finance', 'Manually override a job line''s resolved unit price')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT DISTINCT rp.role_code, 'pricing.override' FROM role_permissions rp
WHERE rp.permission_code = 'fx.manage'
ON CONFLICT DO NOTHING;
