-- ---------------------------------------------------------------------------------------
-- 007. Organisational hierarchy: organisation → country → office → department.
--
-- The platform was built around a flat list of branches. A group with several offices in one
-- country (Istanbul and Mersin, Astana and Almaty) cannot be described that way, and neither
-- can a country manager who should see their country but not the group.
--
-- `branches` keeps its name and every row: a branch IS an office — the legal entity with its
-- own letterhead, currency and accounting. What is added above it is the country it belongs
-- to, and below it the departments inside it. No data is moved, so nothing that works today
-- stops working.
-- ---------------------------------------------------------------------------------------

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  legal_name  text,
  /** Currency the group consolidates into; per-office currencies live on branches. */
  base_currency char(3) NOT NULL DEFAULT 'EUR',
  website     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

CREATE TABLE countries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  /** ISO 3166-1 alpha-2, the same code the branches already carry. */
  code             char(2) NOT NULL,
  name             text NOT NULL,
  /** Default language and time zone for offices opened in this country. */
  locale           text,
  timezone         text,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (id, organization_id)
);
CREATE TRIGGER countries_updated_at BEFORE UPDATE ON countries
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- An office belongs to a country; the country belongs to the organisation.
ALTER TABLE branches
  ADD COLUMN organization_id uuid REFERENCES organizations(id),
  ADD COLUMN country_id      uuid REFERENCES countries(id),
  ADD COLUMN is_active       boolean NOT NULL DEFAULT true;

-- Backfill: one organisation, one country per distinct country code already in use.
INSERT INTO organizations (code, name, legal_name, base_currency, website)
VALUES ('GSI', 'General Survey Inspection', 'General Survey Inspection Group — legal name TBC', 'EUR', 'https://gsi.example')
ON CONFLICT (code) DO NOTHING;

INSERT INTO countries (organization_id, code, name, locale, timezone)
SELECT o.id, b.country, b.country, min(b.locale), min(b.timezone)
FROM branches b CROSS JOIN organizations o
WHERE o.code = 'GSI'
GROUP BY o.id, b.country
ON CONFLICT (organization_id, code) DO NOTHING;

UPDATE branches b
SET organization_id = c.organization_id,
    country_id      = c.id
FROM countries c
WHERE c.code = b.country AND b.country_id IS NULL;

-- Country names are ISO codes after the backfill; give the known ones their real names.
UPDATE countries SET name = v.name FROM (VALUES
  ('TR', 'Türkiye'), ('RO', 'România'), ('UA', 'Україна'), ('UZ', 'Oʻzbekiston'),
  ('KZ', 'Қазақстан'), ('AE', 'United Arab Emirates'), ('IT', 'Italia'), ('RU', 'Россия')
) AS v(code, name) WHERE countries.code = v.code;

/**
 * Every office belongs somewhere, and the country code is already on the row — so the link is
 * derived rather than demanded. Opening an office in a country the group has not worked in
 * before creates that country; the alternative is every insert path (seed, import, admin
 * screen) having to know about the hierarchy.
 */
CREATE FUNCTION trg_branch_hierarchy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_org uuid;
BEGIN
  IF NEW.organization_id IS NULL THEN
    SELECT id INTO v_org FROM organizations ORDER BY code LIMIT 1;
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'no organization exists yet';
    END IF;
    NEW.organization_id := v_org;
  END IF;

  IF NEW.country_id IS NULL THEN
    SELECT id INTO NEW.country_id FROM countries
    WHERE organization_id = NEW.organization_id AND code = NEW.country;
    IF NEW.country_id IS NULL THEN
      INSERT INTO countries (organization_id, code, name, locale, timezone)
      VALUES (NEW.organization_id, NEW.country, NEW.country, NEW.locale, NEW.timezone)
      RETURNING id INTO NEW.country_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER branches_hierarchy BEFORE INSERT OR UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION trg_branch_hierarchy();

ALTER TABLE branches
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN country_id SET NOT NULL;

CREATE INDEX branches_country_idx ON branches (country_id);

/** Departments inside an office: operations, laboratory, finance, administration. */
CREATE TYPE department_kind AS ENUM ('operations', 'laboratory', 'finance', 'administration', 'sales', 'other');

CREATE TABLE departments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id  uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  code       text NOT NULL,
  name       text NOT NULL,
  kind       department_kind NOT NULL DEFAULT 'other',
  head_user_id uuid,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, code),
  UNIQUE (id, branch_id),
  FOREIGN KEY (head_user_id, branch_id) REFERENCES users (id, branch_id) ON DELETE SET NULL
);
CREATE TRIGGER departments_updated_at BEFORE UPDATE ON departments
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE INDEX departments_branch_idx ON departments (branch_id);

-- A user works in an office and, optionally, in one of its departments.
ALTER TABLE users
  ADD COLUMN department_id uuid,
  ADD CONSTRAINT users_department_fk FOREIGN KEY (department_id, branch_id)
      REFERENCES departments (id, branch_id) ON DELETE SET NULL;

-- ---------- Row-Level Security --------------------------------------------------------
-- Reference-like tables: visible to every authenticated user (an office user needs to see
-- which country it belongs to), writable only by administrators. The policies are rewritten
-- in 008 once permissions exist.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE countries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments   ENABLE ROW LEVEL SECURITY;

CREATE POLICY organizations_read ON organizations FOR SELECT USING (app_role() IS NOT NULL);
CREATE POLICY organizations_admin ON organizations FOR ALL
  USING (app_role() = 'admin') WITH CHECK (app_role() = 'admin');

CREATE POLICY countries_read ON countries FOR SELECT USING (app_role() IS NOT NULL);
CREATE POLICY countries_admin ON countries FOR ALL
  USING (app_role() = 'admin') WITH CHECK (app_role() = 'admin');

CREATE POLICY departments_read ON departments FOR SELECT
  USING (app_is_hq() OR branch_id = app_branch_id());
CREATE POLICY departments_admin ON departments FOR ALL
  USING (app_role() = 'admin') WITH CHECK (app_role() = 'admin');

GRANT SELECT, INSERT, UPDATE, DELETE ON organizations, countries, departments TO gsi_app;
