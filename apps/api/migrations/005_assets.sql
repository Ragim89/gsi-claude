-- =====================================================================================
-- Fixed assets and depreciation (docs/01-architecture.md, module 6 "Финансы": branch assets;
-- feeds the group capitalisation metric in docs/03-finance-dashboard.md).
--
-- Every asset belongs to a branch and is protected by the same Row-Level Security as the
-- rest of the finance domain. Depreciation is posted to the ledger month by month, so the
-- P&L and the dashboard pick it up without any separate reporting path.
-- =====================================================================================

CREATE TYPE asset_category AS ENUM (
  'real_estate',          -- office, warehouse, land
  'vehicles',             -- cars, vans, boats
  'lab_equipment',        -- laboratory instruments
  'inspection_equipment', -- draft survey gear, samplers, moisture meters
  'it_equipment',         -- laptops, servers, phones
  'furniture',
  'intangible',           -- software licences, accreditations
  'other'
);

CREATE TYPE asset_status AS ENUM ('in_use', 'in_repair', 'idle', 'disposed', 'written_off');

-- ASSUMPTION: straight-line depreciation only, which is what GSI's asset classes (vehicles,
-- lab instruments, IT) normally use. Declining-balance or per-country tax schedules can be
-- added as another method without touching the postings.
CREATE TYPE depreciation_method AS ENUM ('straight_line', 'none');

-- The accumulated-depreciation side of the posting needs its own account group.
ALTER TYPE account_group ADD VALUE IF NOT EXISTS 'asset';

CREATE TABLE assets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id            uuid NOT NULL REFERENCES branches(id),
  inventory_no         text NOT NULL,
  name                 text NOT NULL,
  category             asset_category NOT NULL DEFAULT 'other',
  status               asset_status NOT NULL DEFAULT 'in_use',
  serial_no            text,
  location             text,
  responsible_user_id  uuid,
  -- Acquisition
  acquisition_date     date NOT NULL,
  acquisition_cost     numeric(14, 2) NOT NULL CHECK (acquisition_cost >= 0),
  currency             char(3) NOT NULL,
  -- Depreciation parameters
  method               depreciation_method NOT NULL DEFAULT 'straight_line',
  useful_life_months   integer CHECK (useful_life_months > 0),
  salvage_value        numeric(14, 2) NOT NULL DEFAULT 0 CHECK (salvage_value >= 0),
  /** Accumulated depreciation to date, in the asset's own currency. */
  accumulated          numeric(14, 2) NOT NULL DEFAULT 0 CHECK (accumulated >= 0),
  /** Month already depreciated (first day of that month), NULL before the first run. */
  depreciated_through  date,
  -- Disposal
  disposed_on          date,
  disposal_amount      numeric(14, 2),
  disposal_note        text,
  photo_key            text,
  notes                text,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, inventory_no),
  UNIQUE (id, branch_id),
  FOREIGN KEY (responsible_user_id, branch_id) REFERENCES users (id, branch_id),
  CHECK (salvage_value <= acquisition_cost),
  CHECK (method = 'none' OR useful_life_months IS NOT NULL)
);
CREATE INDEX assets_branch_status_idx ON assets (branch_id, status, category);
CREATE INDEX assets_acquired_idx ON assets (acquisition_date);
CREATE TRIGGER assets_updated_at BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- One row per asset per month: the depreciation history and the audit trail behind the ledger.
CREATE TABLE asset_depreciation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     uuid NOT NULL,
  asset_id      uuid NOT NULL,
  period        date NOT NULL,                -- first day of the month
  amount        numeric(14, 2) NOT NULL,      -- asset currency
  currency      char(3) NOT NULL,
  amount_base   numeric(14, 2) NOT NULL,      -- consolidation currency at the period rate
  accumulated   numeric(14, 2) NOT NULL,      -- after this period
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, period),
  FOREIGN KEY (asset_id, branch_id) REFERENCES assets (id, branch_id) ON DELETE CASCADE
);
CREATE INDEX asset_depr_period_idx ON asset_depreciation (branch_id, period);

CREATE FUNCTION trg_inherit_asset_branch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.branch_id := (SELECT a.branch_id FROM assets a WHERE a.id = NEW.asset_id);
  RETURN NEW;
END $$;
CREATE TRIGGER asset_depr_branch BEFORE INSERT ON asset_depreciation
  FOR EACH ROW EXECUTE FUNCTION trg_inherit_asset_branch();

-- ---------- Row-Level Security --------------------------------------------------------
ALTER TABLE assets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_depreciation ENABLE ROW LEVEL SECURITY;

-- Same audience as the rest of finance: branch finance controllers and supervisors see their
-- own branch, HQ sees the group, inspectors see nothing.
CREATE POLICY assets_branch ON assets FOR ALL
  USING (app_sees_finance() AND (app_is_hq() OR branch_id = app_branch_id()))
  WITH CHECK (app_sees_finance() AND (app_is_hq() OR branch_id = app_branch_id()));

CREATE POLICY asset_depr_branch ON asset_depreciation FOR ALL
  USING (app_sees_finance() AND (app_is_hq() OR branch_id = app_branch_id())
         AND EXISTS (SELECT 1 FROM assets a WHERE a.id = asset_depreciation.asset_id))
  WITH CHECK (app_sees_finance() AND (app_is_hq() OR branch_id = app_branch_id())
         AND EXISTS (SELECT 1 FROM assets a WHERE a.id = asset_depreciation.asset_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON assets, asset_depreciation TO gsi_app;
