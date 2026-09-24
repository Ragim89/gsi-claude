-- ---------------------------------------------------------------------------------------
-- 011. CRM: the people at a client, and the contracts the work is done under.
--
-- A client was one row with a single contact field. In practice an inspection company talks
-- to several people at each client — operations, documentation, accounts — and every job is
-- performed under a contract that sets the services, the tariff and the payment terms.
--
-- Jobs already carried a free-text `contract_no`. That text stays (not every job has a
-- contract on file), and a job can now also point at the contract record itself.
-- ---------------------------------------------------------------------------------------

CREATE TABLE client_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL REFERENCES branches(id),
  client_id   uuid NOT NULL,
  full_name   text NOT NULL,
  position    text,
  email       text,
  phone       text,
  /** The person to write to by default; at most one per client. */
  is_primary  boolean NOT NULL DEFAULT false,
  notes       text,
  deleted_at  timestamptz,
  deleted_by  uuid REFERENCES users(id),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, branch_id),
  FOREIGN KEY (client_id, branch_id) REFERENCES clients (id, branch_id) ON DELETE CASCADE
);
CREATE TRIGGER client_contacts_updated_at BEFORE UPDATE ON client_contacts
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE INDEX client_contacts_client_idx ON client_contacts (client_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX client_contacts_primary_idx ON client_contacts (client_id)
  WHERE is_primary AND deleted_at IS NULL;

CREATE TYPE contract_status AS ENUM ('draft', 'active', 'suspended', 'expired', 'terminated');

CREATE TABLE contracts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id          uuid NOT NULL REFERENCES branches(id),
  client_id          uuid NOT NULL,
  /** The client's or our own reference — whatever the parties call this contract. */
  contract_no        text NOT NULL,
  title              text,
  status             contract_status NOT NULL DEFAULT 'draft',
  signed_on          date,
  valid_from         date,
  valid_to           date,
  currency           char(3),
  /** Contract value, where one is agreed; many inspection contracts are tariff-based. */
  value_amount       numeric(14, 2),
  /** Days from invoice date to due date; used as the default when invoicing this client. */
  payment_terms_days integer CHECK (payment_terms_days >= 0),
  incoterms          text,
  /** Services this contract covers, as service_type values. */
  services           text[],
  commodity_id       uuid REFERENCES commodities(id),
  notes              text,
  /** The signed document itself, in object storage. */
  file_storage_key   text,
  file_name          text,
  file_size          integer,
  deleted_at         timestamptz,
  deleted_by         uuid REFERENCES users(id),
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, branch_id),
  FOREIGN KEY (client_id, branch_id) REFERENCES clients (id, branch_id) ON DELETE RESTRICT,
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE TRIGGER contracts_updated_at BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE INDEX contracts_client_idx ON contracts (client_id) WHERE deleted_at IS NULL;
CREATE INDEX contracts_branch_idx ON contracts (branch_id, status) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX contracts_no_idx ON contracts (branch_id, client_id, contract_no)
  WHERE deleted_at IS NULL;

-- A job may be performed under a contract. The composite key keeps both in the same office.
ALTER TABLE inspection_jobs
  ADD COLUMN contract_id uuid,
  ADD CONSTRAINT jobs_contract_fk FOREIGN KEY (contract_id, branch_id)
      REFERENCES contracts (id, branch_id) ON DELETE SET NULL;
CREATE INDEX jobs_contract_ref_idx ON inspection_jobs (contract_id) WHERE contract_id IS NOT NULL;

-- Child rows inherit the office of their client, like every other child table.
CREATE FUNCTION trg_inherit_client_branch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.branch_id IS NULL THEN
    SELECT branch_id INTO NEW.branch_id FROM clients WHERE id = NEW.client_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER client_contacts_branch BEFORE INSERT ON client_contacts
  FOR EACH ROW EXECUTE FUNCTION trg_inherit_client_branch();
CREATE TRIGGER contracts_branch BEFORE INSERT ON contracts
  FOR EACH ROW EXECUTE FUNCTION trg_inherit_client_branch();

-- ---------- Row-Level Security --------------------------------------------------------
ALTER TABLE client_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts       ENABLE ROW LEVEL SECURITY;

CREATE POLICY client_contacts_branch ON client_contacts FOR ALL
  USING (app_can_see_branch(branch_id) AND app_is_live(deleted_at)
         AND EXISTS (SELECT 1 FROM clients c WHERE c.id = client_contacts.client_id))
  WITH CHECK (app_can_see_branch(branch_id));

CREATE POLICY contracts_branch ON contracts FOR ALL
  USING (app_can_see_branch(branch_id) AND app_is_live(deleted_at)
         AND EXISTS (SELECT 1 FROM clients c WHERE c.id = contracts.client_id))
  WITH CHECK (app_can_see_branch(branch_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON client_contacts, contracts TO gsi_app;

-- ---------- Permissions ---------------------------------------------------------------
INSERT INTO permissions (code, category, description) VALUES
  ('contract.read',   'crm', 'See contracts'),
  ('contract.manage', 'crm', 'Create, edit and archive contracts');

-- A contract carries commercial terms — value, tariff, payment days — so seeing a client is
-- deliberately not enough: field and laboratory roles are left out.
INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'contract.read' FROM roles
WHERE code IN ('admin', 'cfo', 'country_manager', 'office_manager', 'supervisor', 'operations',
               'finance_controller', 'sales', 'report_reviewer', 'viewer')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'contract.manage' FROM roles
WHERE code IN ('admin', 'country_manager', 'office_manager', 'supervisor', 'operations', 'sales')
ON CONFLICT DO NOTHING;
