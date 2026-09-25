-- =====================================================================================
-- PHASE 8 (1/3): Services catalogue and price list.
--
-- A "service" is a billable line (survey day, sample, lab test, report copy) — a catalogue
-- like `commodities`/`ports`, not branch-scoped, because the same service is sold everywhere.
-- A "price" is what that service costs, and where it costs that: resolution order is
-- contract → client → branch default, the exact order already proven for laboratory norms
-- (`app_resolve_specification` in 015_laboratory.sql). Prices are commercial data: readable
-- only with `pricing.read`, same isolation already applied to `contracts` in PHASE 2.
-- =====================================================================================

CREATE TABLE services (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  -- Localised names, same shape as commodities.name: {"en": "...", "ru": "...", "tr": "..."}
  name         jsonb NOT NULL,
  -- Optional link to the job category this service is normally billed against; used to
  -- pre-select a price when quoting a job, not a constraint on what can be priced.
  service_type service_type,
  unit         text NOT NULL DEFAULT 'unit',   -- e.g. 'day', 'sample', 'shift', 'report', 'ton'
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 100,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX services_active_idx ON services (sort_order) WHERE is_active;
CREATE TRIGGER services_updated_at BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

CREATE TABLE prices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      uuid NOT NULL REFERENCES branches(id),
  service_id     uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  -- The more specific of these that is filled in, the narrower this price applies.
  contract_id    uuid,
  client_id      uuid,
  currency       char(3) NOT NULL,
  unit_price     numeric(14, 2) NOT NULL CHECK (unit_price >= 0),
  effective_from date NOT NULL DEFAULT current_date,
  effective_to   date,
  is_active      boolean NOT NULL DEFAULT true,
  notes          text,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, branch_id),
  FOREIGN KEY (client_id, branch_id) REFERENCES clients (id, branch_id) ON DELETE CASCADE,
  FOREIGN KEY (contract_id, branch_id) REFERENCES contracts (id, branch_id) ON DELETE CASCADE,
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX prices_service_idx ON prices (service_id) WHERE is_active;
CREATE INDEX prices_branch_idx ON prices (branch_id) WHERE is_active;
CREATE INDEX prices_client_idx ON prices (client_id) WHERE client_id IS NOT NULL;
CREATE INDEX prices_contract_idx ON prices (contract_id) WHERE contract_id IS NOT NULL;
CREATE TRIGGER prices_updated_at BEFORE UPDATE ON prices FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

/**
 * Picks the price that applies, most specific first — contract, then client, then the branch
 * default. Same shape as app_resolve_specification: the order lives in one function so the
 * quote builder, the invoice builder and any future rule engine agree on the same answer.
 */
CREATE FUNCTION app_resolve_price(p_service uuid, p_branch uuid, p_client uuid, p_contract uuid, p_on date)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id
  FROM prices p
  WHERE p.is_active
    AND p.service_id = p_service
    AND p.branch_id = p_branch
    AND p.effective_from <= p_on
    AND (p.effective_to IS NULL OR p.effective_to >= p_on)
    AND (p.contract_id IS NULL OR p.contract_id = p_contract)
    AND (p.client_id IS NULL OR p.client_id = p_client)
  ORDER BY
    (p.contract_id IS NOT NULL) DESC,
    (p.client_id IS NOT NULL) DESC,
    p.effective_from DESC
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION app_resolve_price(uuid, uuid, uuid, uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_price(uuid, uuid, uuid, uuid, date) TO gsi_app;

-- ---------- Row-Level Security --------------------------------------------------------
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE prices   ENABLE ROW LEVEL SECURITY;

-- The catalogue of what can be sold is not commercial data (same as commodities/ports).
CREATE POLICY services_read ON services FOR SELECT USING (app_role() IS NOT NULL);
CREATE POLICY services_manage ON services FOR ALL
  USING (app_has_perm('service.manage')) WITH CHECK (app_has_perm('service.manage'));

-- What it costs is commercial data: same isolation as contracts (PHASE 2).
CREATE POLICY prices_read ON prices FOR SELECT
  USING (app_has_perm('pricing.read') AND app_can_see_branch(branch_id));
CREATE POLICY prices_manage ON prices FOR ALL
  USING (app_has_perm('pricing.manage') AND app_can_see_branch(branch_id))
  WITH CHECK (app_has_perm('pricing.manage') AND app_can_see_branch(branch_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON services, prices TO gsi_app;

-- ---------- Permissions ----------------------------------------------------------------
INSERT INTO permissions (code, category, description) VALUES
  ('service.read',    'finance', 'See the service catalogue'),
  ('service.manage',  'finance', 'Maintain the service catalogue'),
  ('pricing.read',    'finance', 'See prices'),
  ('pricing.manage',  'finance', 'Maintain prices')
ON CONFLICT DO NOTHING;

-- The catalogue of what can be sold is not commercial data, same as commodities/ports:
-- whoever reads reference data reads it too. Prices are commercial: whoever already reads
-- finance data reads them, and sales additionally needs them to build quotes.
INSERT INTO role_permissions (role_code, permission_code)
SELECT DISTINCT rp.role_code, 'service.read' FROM role_permissions rp
WHERE rp.permission_code = 'reference.read'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT DISTINCT rp.role_code, 'pricing.read' FROM role_permissions rp
WHERE rp.permission_code = 'finance.read'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT roles.code, 'pricing.read' FROM roles
WHERE roles.code = 'sales'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT DISTINCT rp.role_code, v.code FROM role_permissions rp, (VALUES ('service.manage'), ('pricing.manage')) AS v(code)
WHERE rp.permission_code = 'fx.manage'
ON CONFLICT DO NOTHING;
