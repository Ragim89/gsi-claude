-- =====================================================================================
-- 031. Instrument purchase price / depreciation, by linking to the existing Assets module.
--
-- `lab_instruments` RLS is `USING (true)` — any authenticated role can read it (inspectors,
-- sales, everyone), which is correct for identity/calibration data but wrong for money.
-- `assets` already has acquisition cost, currency, depreciation method/useful life/salvage
-- value, accumulated depreciation, and is already gated by `app_sees_finance()` — and
-- `asset_category` already has a `lab_equipment` value. Rather than a second financial table
-- with its own depreciation math, an instrument that has purchase data simply *is* an asset
-- (category `lab_equipment`), referenced from the instrument by one nullable pointer.
--
-- That pointer carries no money — reading `lab_instruments.asset_id` tells you an asset
-- exists, not what it cost. The cost only becomes visible through a JOIN to `assets`, and
-- `assets`' own RLS silently returns no row for a caller without finance permission, so the
-- instrument's finance panel is empty for them by construction, not by an application-level
-- permission check that could be forgotten on some future endpoint.
--
-- Nothing about `lab_instruments`' own RLS changes.
-- =====================================================================================

ALTER TABLE lab_instruments
  ADD COLUMN asset_id uuid REFERENCES assets(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX lab_instruments_asset_idx ON lab_instruments (asset_id) WHERE asset_id IS NOT NULL;
