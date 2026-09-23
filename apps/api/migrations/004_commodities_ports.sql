-- =====================================================================================
-- Reference data: commodities (the cultures inspected and analysed) and ports / locations,
-- plus the contract number and a numeric volume on inspection jobs.
--
-- Both references are group-wide (not per branch): the same wheat or lentils are inspected
-- in Istanbul and in Novorossiysk, and reporting must compare like with like. They are
-- readable by every authenticated user and writable by admins.
-- =====================================================================================

CREATE TYPE commodity_group AS ENUM (
  'cereals', 'pulses', 'oilseeds', 'vegetable_oils', 'meals_cakes', 'fertilizers', 'other'
);

CREATE TABLE commodities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,            -- short stable key, e.g. 'wheat_milling'
  "group"     commodity_group NOT NULL DEFAULT 'other',
  -- Localised names: {"en": "Milling wheat", "ru": "Пшеница продовольственная", "tr": "..."}
  name        jsonb NOT NULL,
  hs_code     text,                            -- customs tariff code, when known
  -- Laboratory methods usually run for this commodity (docs/01, LIMS module).
  -- ASSUMPTION: an indicative list until GSI confirms its methodology per commodity.
  lab_methods text[] NOT NULL DEFAULT '{}',
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 100,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commodities_group_idx ON commodities ("group", sort_order);

CREATE TABLE ports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,            -- UN/LOCODE where known, e.g. 'TRDRC'
  name        text NOT NULL,
  country     char(2) NOT NULL,
  /** Terminal, elevator or warehouse rather than a sea port. */
  is_inland   boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ports_country_idx ON ports (country, name);

-- ---------- inspection_jobs: structured commodity, port, contract and volume -----------
ALTER TABLE inspection_jobs
  ADD COLUMN commodity_id   uuid REFERENCES commodities(id),
  ADD COLUMN port_id        uuid REFERENCES ports(id),
  ADD COLUMN contract_no    text,
  ADD COLUMN quantity_value numeric(14, 3) CHECK (quantity_value >= 0),
  ADD COLUMN quantity_unit  text NOT NULL DEFAULT 'MT';

-- `commodity`, `location` and `quantity` stay as free text: they carry what the client wrote
-- on the nomination, while the new columns carry the values we filter and report on.
CREATE INDEX jobs_commodity_idx ON inspection_jobs (commodity_id);
CREATE INDEX jobs_port_idx ON inspection_jobs (port_id);
CREATE INDEX jobs_contract_idx ON inspection_jobs (contract_no);
CREATE INDEX jobs_quantity_idx ON inspection_jobs (quantity_value);

-- ---------- Row-Level Security --------------------------------------------------------
ALTER TABLE commodities ENABLE ROW LEVEL SECURITY;
ALTER TABLE ports       ENABLE ROW LEVEL SECURITY;

CREATE POLICY commodities_read ON commodities FOR SELECT USING (app_role() IS NOT NULL);
CREATE POLICY commodities_admin ON commodities FOR ALL
  USING (app_role() = 'admin') WITH CHECK (app_role() = 'admin');

CREATE POLICY ports_read ON ports FOR SELECT USING (app_role() IS NOT NULL);
CREATE POLICY ports_admin ON ports FOR ALL
  USING (app_role() = 'admin') WITH CHECK (app_role() = 'admin');

GRANT SELECT, INSERT, UPDATE, DELETE ON commodities, ports TO gsi_app;
