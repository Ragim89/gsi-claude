-- ---------------------------------------------------------------------------------------
-- 008. Role-based access control with granular permissions, and scope-aware isolation.
--
-- Until now an action was allowed by naming roles in the code (`@Roles('supervisor','admin')`)
-- and repeating the same lists inside SQL policies and in the web app. Adding a role meant
-- editing a dozen places, and nobody could answer "what may a lab manager actually do?".
--
-- From here on:
--   * a permission is a verb the system understands  (job.approve, invoice.pay, audit.read);
--   * a role is a named set of permissions plus a scope (global / country / office / own);
--   * a user has one or more roles; the effective scope is the broadest of them.
--
-- Row-Level Security keeps doing what it did — deciding which ROWS exist for the caller — but
-- it now reads the scope instead of a role name, so a country manager sees their country and
-- an inspector still sees only their own jobs.
-- ---------------------------------------------------------------------------------------

CREATE TYPE access_scope AS ENUM ('global', 'country', 'office', 'own');

CREATE TABLE permissions (
  code        text PRIMARY KEY,
  category    text NOT NULL,
  description text NOT NULL
);

CREATE TABLE roles (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  scope       access_scope NOT NULL DEFAULT 'office',
  /** System roles are part of the product and cannot be deleted from the admin screen. */
  is_system   boolean NOT NULL DEFAULT true,
  /** The value of users.role this role corresponds to, for roles that predate this table. */
  legacy_role user_role,
  sort_order  integer NOT NULL DEFAULT 100,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER roles_updated_at BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

CREATE TABLE role_permissions (
  role_code       text NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE user_roles (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_code   text NOT NULL REFERENCES roles(code) ON DELETE RESTRICT,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  uuid REFERENCES users(id),
  PRIMARY KEY (user_id, role_code)
);
CREATE INDEX user_roles_role_idx ON user_roles (role_code);

-- ---------- Catalogue -----------------------------------------------------------------

INSERT INTO permissions (code, category, description) VALUES
  ('job.read',          'operations', 'See inspection jobs'),
  ('job.create',        'operations', 'Create inspection jobs'),
  ('job.update',        'operations', 'Edit job details'),
  ('job.assign',        'operations', 'Assign a job to an inspector'),
  ('job.start',         'operations', 'Start field work on a job'),
  ('job.submit',        'operations', 'Submit completed field work for review'),
  ('job.approve',       'operations', 'Approve a job and issue its report'),
  ('job.cancel',        'operations', 'Cancel or return a job'),
  ('job.delete',        'operations', 'Delete a job that was never started'),
  ('checklist.update',  'operations', 'Fill in checklist answers'),
  ('media.upload',      'operations', 'Attach photos to checklist items'),
  ('media.delete',      'operations', 'Remove an attached photo'),
  ('client.read',       'crm',        'See clients'),
  ('client.create',     'crm',        'Create clients'),
  ('client.update',     'crm',        'Edit clients'),
  ('client.archive',    'crm',        'Archive a client'),
  ('report.read',       'documents',  'See issued reports'),
  ('report.download',   'documents',  'Download report PDFs'),
  ('report.preview',    'documents',  'Preview a draft report before approval'),
  ('finance.read',      'finance',    'See financial data'),
  ('dashboard.read',    'finance',    'See the finance dashboard'),
  ('invoice.create',    'finance',    'Create invoices'),
  ('invoice.issue',     'finance',    'Issue invoices'),
  ('invoice.pay',       'finance',    'Register payments'),
  ('invoice.cancel',    'finance',    'Cancel invoices'),
  ('invoice.delete',    'finance',    'Delete a draft invoice'),
  ('expense.create',    'finance',    'Record expenses'),
  ('expense.delete',    'finance',    'Delete an expense'),
  ('fx.manage',         'finance',    'Maintain exchange rates'),
  ('asset.read',        'assets',     'See company assets'),
  ('asset.create',      'assets',     'Register assets'),
  ('asset.update',      'assets',     'Edit or dispose of assets'),
  ('asset.delete',      'assets',     'Delete an asset'),
  ('asset.depreciate',  'assets',     'Run monthly depreciation'),
  ('reference.read',    'reference',  'See commodities and ports'),
  ('reference.manage',  'reference',  'Maintain commodities and ports'),
  ('branch.read',       'admin',      'See office details'),
  ('branch.manage',     'admin',      'Edit office requisites'),
  ('org.manage',        'admin',      'Manage organisation, countries and departments'),
  ('user.read',         'admin',      'See users'),
  ('user.manage',       'admin',      'Create and edit users'),
  ('role.manage',       'admin',      'Assign roles and permissions'),
  ('audit.read',        'admin',      'Read the audit log'),
  ('export.run',        'data',       'Export data'),
  ('import.run',        'data',       'Import data from spreadsheets');

INSERT INTO roles (code, name, description, scope, legacy_role, sort_order) VALUES
  ('admin',              'System administrator', 'Full access across the group',                  'global',  'admin',              10),
  ('cfo',                'Group CFO',            'Consolidated finance across the group',         'global',  'cfo',                20),
  ('country_manager',    'Country manager',      'Everything within one country',                 'country', NULL,                 30),
  ('office_manager',     'Office manager',       'Everything within one office',                  'office',  'supervisor',         40),
  ('supervisor',         'Supervisor',           'Operations and report approval in one office',  'office',  'supervisor',         50),
  ('operations',         'Operations',           'Planning and dispatching jobs',                 'office',  'supervisor',         60),
  ('finance_controller', 'Finance controller',   'Invoices, costs and assets of one office',      'office',  'finance_controller', 70),
  ('sales',              'Sales',                'Clients and quotations',                        'office',  NULL,                 80),
  ('report_reviewer',    'Report reviewer',      'Reviews and approves reports',                  'office',  'supervisor',         90),
  ('lab_manager',        'Laboratory manager',   'Laboratory work and result approval',           'office',  'lab_technician',    100),
  ('lab_analyst',        'Laboratory analyst',   'Enters test results',                           'office',  'lab_technician',    110),
  ('inspector',          'Inspector',            'Field work on assigned jobs',                   'own',     'inspector',         120),
  ('sampler',            'Sampler',              'Sampling on assigned jobs',                     'own',     NULL,                130),
  ('viewer',             'Viewer',               'Read-only access to one office',                'office',  NULL,                140),
  ('client',             'Client',               'Own reports only (client portal)',              'own',     'client',            150);

-- Role → permissions. Written as sets rather than one row per pair: the intent stays readable.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'admin', code FROM permissions;

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'cfo', code FROM permissions
WHERE code IN ('job.read','client.read','report.read','report.download','finance.read','dashboard.read',
               'asset.read','reference.read','branch.read','user.read','audit.read','export.run','fx.manage');

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'country_manager', code FROM permissions
WHERE code NOT IN ('user.manage','role.manage','org.manage','reference.manage','invoice.delete','job.delete','asset.delete');

INSERT INTO role_permissions (role_code, permission_code)
SELECT r.code, p.code FROM roles r, permissions p
WHERE r.code IN ('office_manager','supervisor')
  AND p.code IN ('job.read','job.create','job.update','job.assign','job.start','job.submit','job.approve',
                 'job.cancel','job.delete','checklist.update','media.upload','media.delete',
                 'client.read','client.create','client.update','client.archive',
                 'report.read','report.download','report.preview',
                 'finance.read','dashboard.read','asset.read','reference.read','branch.read','user.read',
                 'export.run','import.run');

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'operations', code FROM permissions
WHERE code IN ('job.read','job.create','job.update','job.assign','job.cancel','client.read','client.create',
               'client.update','report.read','report.download','reference.read','branch.read','export.run');

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'finance_controller', code FROM permissions
WHERE code IN ('job.read','client.read','report.read','report.download','finance.read','dashboard.read',
               'invoice.create','invoice.issue','invoice.pay','invoice.cancel','invoice.delete',
               'expense.create','expense.delete','fx.manage',
               'asset.read','asset.create','asset.update','asset.delete','asset.depreciate',
               'reference.read','branch.read','export.run','import.run');

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'sales', code FROM permissions
WHERE code IN ('client.read','client.create','client.update','job.read','job.create','report.read',
               'report.download','reference.read','export.run');

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'report_reviewer', code FROM permissions
WHERE code IN ('job.read','job.approve','job.cancel','client.read','report.read','report.download',
               'report.preview','reference.read');

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'lab_manager', code FROM permissions
WHERE code IN ('job.read','client.read','report.read','report.download','reference.read','export.run');

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'lab_analyst', code FROM permissions
WHERE code IN ('job.read','client.read','reference.read');

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'inspector', code FROM permissions
WHERE code IN ('job.read','job.start','job.submit','checklist.update','media.upload','media.delete',
               'client.read','report.read','reference.read');

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'sampler', code FROM permissions
WHERE code IN ('job.read','job.start','checklist.update','media.upload','client.read','reference.read');

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'viewer', code FROM permissions
WHERE code IN ('job.read','client.read','report.read','reference.read','branch.read');

INSERT INTO role_permissions (role_code, permission_code)
VALUES ('client', 'report.read'), ('client', 'report.download');

-- Everyone keeps exactly the access they had: their enum role becomes an assigned role.
INSERT INTO user_roles (user_id, role_code)
SELECT u.id, r.code
FROM users u
JOIN roles r ON r.legacy_role = u.role
WHERE r.code IN ('admin', 'cfo', 'supervisor', 'finance_controller', 'inspector', 'lab_analyst', 'client')
ON CONFLICT DO NOTHING;

-- ---------- Access context ------------------------------------------------------------
-- The API sets these per transaction, next to app.user_id / app.branch_id / app.role.

CREATE FUNCTION app_country_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.country_id', true), '')::uuid $$;

/**
 * Effective scope. Falls back to the old role mapping when a caller still presents a token
 * issued before this migration, so a deployment does not log everyone out.
 */
CREATE OR REPLACE FUNCTION app_scope() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.scope', true), ''),
    CASE
      WHEN app_role() IN ('admin', 'cfo') THEN 'global'
      WHEN app_role() = 'inspector' THEN 'own'
      WHEN app_role() IS NOT NULL THEN 'office'
    END
  )
$$;

/** Permissions arrive as ",job.read,job.create," — wrapped so a plain substring match is exact. */
CREATE FUNCTION app_has_perm(p_code text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(strpos(current_setting('app.permissions', true), ',' || p_code || ',') > 0, false)
$$;

/**
 * Whether the caller may touch rows belonging to an office. SECURITY DEFINER because the
 * country lookup reads `branches`, which is itself protected by a policy that calls this
 * function — without it the policy would recurse.
 */
CREATE FUNCTION app_can_see_branch(p_branch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE app_scope()
    WHEN 'global' THEN true
    WHEN 'country' THEN EXISTS (
      SELECT 1 FROM branches b WHERE b.id = p_branch AND b.country_id = app_country_id()
    )
    ELSE p_branch = app_branch_id()
  END
$$;

CREATE OR REPLACE FUNCTION app_is_hq() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app_scope() = 'global' $$;

/** Finance visibility is now a permission; the role list remains only for legacy tokens. */
CREATE OR REPLACE FUNCTION app_sees_finance() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN COALESCE(current_setting('app.permissions', true), '') <> '' THEN app_has_perm('finance.read')
    ELSE COALESCE(app_role() IN ('finance_controller', 'supervisor', 'cfo', 'admin'), false)
  END
$$;

REVOKE ALL ON FUNCTION app_can_see_branch(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_can_see_branch(uuid), app_has_perm(text), app_country_id() TO gsi_app;

-- ---------- Policies rewritten in terms of scope and permissions ----------------------

DROP POLICY branches_read ON branches;
DROP POLICY branches_admin ON branches;
CREATE POLICY branches_read ON branches FOR SELECT USING (app_can_see_branch(id));
CREATE POLICY branches_manage ON branches FOR ALL
  USING (app_has_perm('branch.manage') AND app_can_see_branch(id))
  WITH CHECK (app_has_perm('branch.manage') AND app_can_see_branch(id));

DROP POLICY users_read ON users;
DROP POLICY users_admin ON users;
CREATE POLICY users_read ON users FOR SELECT USING (app_can_see_branch(branch_id));
CREATE POLICY users_manage ON users FOR ALL
  USING (app_has_perm('user.manage') AND app_can_see_branch(branch_id))
  WITH CHECK (app_has_perm('user.manage') AND app_can_see_branch(branch_id));

DROP POLICY clients_branch ON clients;
CREATE POLICY clients_branch ON clients FOR ALL
  USING (app_can_see_branch(branch_id))
  WITH CHECK (app_can_see_branch(branch_id));

-- "Own" scope (inspector, sampler) means only the jobs assigned to that person.
DROP POLICY jobs_branch ON inspection_jobs;
CREATE POLICY jobs_branch ON inspection_jobs FOR ALL
  USING (app_can_see_branch(branch_id)
         AND (app_scope() <> 'own' OR assigned_inspector_id = app_user_id()))
  WITH CHECK (app_can_see_branch(branch_id));

DROP POLICY checklist_branch ON job_checklist_items;
CREATE POLICY checklist_branch ON job_checklist_items FOR ALL
  USING (app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM inspection_jobs j WHERE j.id = job_checklist_items.job_id))
  WITH CHECK (app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM inspection_jobs j WHERE j.id = job_checklist_items.job_id));

DROP POLICY media_branch ON media_attachments;
CREATE POLICY media_branch ON media_attachments FOR ALL
  USING (app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM inspection_jobs j WHERE j.id = media_attachments.job_id))
  WITH CHECK (app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM inspection_jobs j WHERE j.id = media_attachments.job_id));

DROP POLICY reports_branch ON reports;
CREATE POLICY reports_branch ON reports FOR ALL
  USING (app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM inspection_jobs j WHERE j.id = reports.job_id))
  WITH CHECK (app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM inspection_jobs j WHERE j.id = reports.job_id));

DROP POLICY invoices_branch ON invoices;
CREATE POLICY invoices_branch ON invoices FOR ALL
  USING (app_sees_finance() AND app_can_see_branch(branch_id))
  WITH CHECK (app_sees_finance() AND app_can_see_branch(branch_id));

DROP POLICY invoice_lines_branch ON invoice_lines;
CREATE POLICY invoice_lines_branch ON invoice_lines FOR ALL
  USING (app_sees_finance() AND app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_lines.invoice_id))
  WITH CHECK (app_sees_finance() AND app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = invoice_lines.invoice_id));

DROP POLICY expenses_branch ON expenses;
CREATE POLICY expenses_branch ON expenses FOR ALL
  USING (app_sees_finance() AND app_can_see_branch(branch_id))
  WITH CHECK (app_sees_finance() AND app_can_see_branch(branch_id));

DROP POLICY ledger_branch ON ledger_entries;
CREATE POLICY ledger_branch ON ledger_entries FOR ALL
  USING (app_sees_finance() AND app_can_see_branch(branch_id))
  WITH CHECK (app_sees_finance() AND app_can_see_branch(branch_id));

DROP POLICY agg_branch ON finance_daily_agg;
CREATE POLICY agg_branch ON finance_daily_agg FOR SELECT
  USING (app_sees_finance() AND app_can_see_branch(branch_id));

DROP POLICY fx_write ON fx_rates;
CREATE POLICY fx_write ON fx_rates FOR ALL
  USING (app_has_perm('fx.manage')) WITH CHECK (app_has_perm('fx.manage'));

DROP POLICY assets_branch ON assets;
CREATE POLICY assets_branch ON assets FOR ALL
  USING (app_sees_finance() AND app_can_see_branch(branch_id))
  WITH CHECK (app_sees_finance() AND app_can_see_branch(branch_id));

DROP POLICY asset_depr_branch ON asset_depreciation;
CREATE POLICY asset_depr_branch ON asset_depreciation FOR ALL
  USING (app_sees_finance() AND app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM assets a WHERE a.id = asset_depreciation.asset_id))
  WITH CHECK (app_sees_finance() AND app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM assets a WHERE a.id = asset_depreciation.asset_id));

DROP POLICY commodities_admin ON commodities;
CREATE POLICY commodities_manage ON commodities FOR ALL
  USING (app_has_perm('reference.manage')) WITH CHECK (app_has_perm('reference.manage'));

DROP POLICY ports_admin ON ports;
CREATE POLICY ports_manage ON ports FOR ALL
  USING (app_has_perm('reference.manage')) WITH CHECK (app_has_perm('reference.manage'));

DROP POLICY organizations_admin ON organizations;
CREATE POLICY organizations_manage ON organizations FOR ALL
  USING (app_has_perm('org.manage')) WITH CHECK (app_has_perm('org.manage'));

DROP POLICY countries_admin ON countries;
CREATE POLICY countries_manage ON countries FOR ALL
  USING (app_has_perm('org.manage')) WITH CHECK (app_has_perm('org.manage'));

DROP POLICY departments_read ON departments;
DROP POLICY departments_admin ON departments;
CREATE POLICY departments_read ON departments FOR SELECT USING (app_can_see_branch(branch_id));
CREATE POLICY departments_manage ON departments FOR ALL
  USING (app_has_perm('org.manage') AND app_can_see_branch(branch_id))
  WITH CHECK (app_has_perm('org.manage') AND app_can_see_branch(branch_id));

-- ---------- RLS for the RBAC tables themselves ----------------------------------------
ALTER TABLE permissions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles       ENABLE ROW LEVEL SECURITY;

-- The catalogue is not secret: the interface shows role names and what they allow.
CREATE POLICY permissions_read ON permissions FOR SELECT USING (app_role() IS NOT NULL);
CREATE POLICY roles_read ON roles FOR SELECT USING (app_role() IS NOT NULL);
CREATE POLICY role_permissions_read ON role_permissions FOR SELECT USING (app_role() IS NOT NULL);

CREATE POLICY roles_manage ON roles FOR ALL
  USING (app_has_perm('role.manage')) WITH CHECK (app_has_perm('role.manage'));
CREATE POLICY role_permissions_manage ON role_permissions FOR ALL
  USING (app_has_perm('role.manage')) WITH CHECK (app_has_perm('role.manage'));

-- Who has which role follows the same visibility as the users themselves.
CREATE POLICY user_roles_read ON user_roles FOR SELECT
  USING (user_id = app_user_id() OR EXISTS (SELECT 1 FROM users u WHERE u.id = user_roles.user_id));
CREATE POLICY user_roles_manage ON user_roles FOR ALL
  USING (app_has_perm('role.manage') AND EXISTS (SELECT 1 FROM users u WHERE u.id = user_roles.user_id))
  WITH CHECK (app_has_perm('role.manage') AND EXISTS (SELECT 1 FROM users u WHERE u.id = user_roles.user_id));

GRANT SELECT ON permissions, roles, role_permissions TO gsi_app;
GRANT INSERT, UPDATE, DELETE ON roles, role_permissions TO gsi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_roles TO gsi_app;

-- ---------- Login needs the user's roles before any context exists ---------------------
DROP FUNCTION IF EXISTS auth_find_user(text, uuid);
CREATE FUNCTION auth_find_user(p_email text, p_id uuid)
RETURNS TABLE (id uuid, branch_id uuid, country_id uuid, role user_role, email text,
               password_hash text, full_name text, locale text, is_active boolean,
               roles text[], scope text, permissions text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH u AS (
    SELECT usr.*, b.country_id
    FROM users usr
    JOIN branches b ON b.id = usr.branch_id
    WHERE (p_email IS NOT NULL AND lower(usr.email) = lower(p_email))
       OR (p_id IS NOT NULL AND usr.id = p_id)
    LIMIT 1
  ),
  assigned AS (
    SELECT r.* FROM roles r
    JOIN user_roles ur ON ur.role_code = r.code
    WHERE ur.user_id = (SELECT id FROM u)
    UNION ALL
    -- A user with no explicit assignment falls back to the role on their user record: the
    -- first role that declares it, so every legacy value resolves to exactly one role.
    SELECT r.* FROM roles r
    WHERE NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = (SELECT id FROM u))
      AND r.legacy_role = (SELECT role FROM u)
      AND r.sort_order = (SELECT min(r2.sort_order) FROM roles r2 WHERE r2.legacy_role = (SELECT role FROM u))
  )
  SELECT u.id, u.branch_id, u.country_id, u.role, u.email, u.password_hash, u.full_name, u.locale,
         u.is_active,
         COALESCE((SELECT array_agg(a.code ORDER BY a.sort_order) FROM assigned a), ARRAY[]::text[]),
         COALESCE((SELECT a.scope::text FROM assigned a
                   ORDER BY array_position(ARRAY['global','country','office','own']::text[], a.scope::text)
                   LIMIT 1), 'own'),
         COALESCE((SELECT array_agg(DISTINCT rp.permission_code)
                   FROM assigned a JOIN role_permissions rp ON rp.role_code = a.code), ARRAY[]::text[])
  FROM u
$$;

REVOKE ALL ON FUNCTION auth_find_user(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user(text, uuid) TO gsi_app;

/**
 * The roles of one user, resolved the same way login resolves them.
 *
 * Read on every request (behind a short-lived cache) rather than trusted from the token, so
 * that taking a role away from someone takes effect in seconds instead of when their access
 * token happens to expire.
 */
CREATE FUNCTION auth_user_roles(p_user uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    NULLIF((SELECT array_agg(ur.role_code ORDER BY ur.role_code) FROM user_roles ur WHERE ur.user_id = p_user),
           ARRAY[]::text[]),
    (SELECT array_agg(r.code) FROM roles r
     WHERE r.legacy_role = (SELECT u.role FROM users u WHERE u.id = p_user)
       AND r.sort_order = (SELECT min(r2.sort_order) FROM roles r2
                           WHERE r2.legacy_role = (SELECT u.role FROM users u WHERE u.id = p_user))),
    ARRAY[]::text[]
  )
$$;

REVOKE ALL ON FUNCTION auth_user_roles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_user_roles(uuid) TO gsi_app;

/**
 * The whole role → permission matrix, for the API to cache. Like login, this is needed
 * before any access context exists, so it runs as the owner.
 */
CREATE FUNCTION rbac_role_matrix()
RETURNS TABLE (code text, scope text, permission_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.code, r.scope::text, rp.permission_code
  FROM roles r
  LEFT JOIN role_permissions rp ON rp.role_code = r.code
$$;

REVOKE ALL ON FUNCTION rbac_role_matrix() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rbac_role_matrix() TO gsi_app;
