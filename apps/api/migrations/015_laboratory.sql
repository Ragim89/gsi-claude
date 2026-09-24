-- ---------------------------------------------------------------------------------------
-- 015. Laboratory information management.
--
-- What already existed (and is reused, not duplicated):
--   * `laboratories` — created in PHASE 5, with its own administration screen. This migration
--     extends it rather than adding a second one.
--   * `commodities.lab_methods` — a curated `text[]` of the analyses each commodity is tested
--     for: 33 distinct names across 37 commodities, entered long before this phase. That list
--     is the test catalogue, and the seed builds `lab_tests` from it. Inventing a parallel list
--     of analyses beside it would have been the "second competing module" the brief warns of.
--   * `job_priority` — the same low/normal/high/urgent a job already uses; a laboratory queue
--     does not need a fourth word for "urgent".
--   * `next_doc_number` — deliberately NOT used. A test request is identified by its sample
--     number and its test code (TR-SMP-2026-00003 · moisture); a second public number would be
--     one more thing to print, quote and get wrong for no gain. See docs/API.md.
--   * `media_attachments` — instrument printouts and worksheets are attachments like any other.
--
-- What is new: the catalogue, the methods and their versions, the specifications a result is
-- judged against, the request that carries one analysis through the laboratory, and the result
-- itself — with revisions, because an approved result is never edited in place.
--
-- Existing data: no test results are invented. Every numeric checklist item in the database has
-- an empty value (964 of them), so there is nothing to reconstruct a historic analysis from.
-- ---------------------------------------------------------------------------------------

-- ---------- Vocabularies ------------------------------------------------------------------
/** Not every laboratory result is a number: a pesticide screen passes or fails. */
CREATE TYPE lab_result_type AS ENUM ('numeric', 'text', 'boolean', 'qualitative', 'pass_fail');

CREATE TYPE test_request_status AS ENUM (
  'requested', 'assigned', 'in_progress', 'result_entered', 'under_review',
  'approved', 'released', 'on_hold', 'rejected', 'cancelled'
);

/**
 * Whether a result met the specification it was judged against. `not_evaluated` is a real
 * answer, not a gap: plenty of analyses are recorded without a limit to compare them to.
 */
CREATE TYPE spec_evaluation AS ENUM ('within_spec', 'out_of_spec', 'not_evaluated');

CREATE TYPE instrument_status AS ENUM ('active', 'maintenance', 'out_of_service', 'retired');

-- ---------- Units -------------------------------------------------------------------------
/**
 * A small controlled list. Free text would give "%" , "percent" and "pct" inside a year, and a
 * result whose unit nobody can group by is a result nobody can chart. Conversion between units
 * is deliberately not attempted here.
 */
CREATE TABLE lab_units (
  code       text PRIMARY KEY,
  name       jsonb NOT NULL,
  kind       text NOT NULL DEFAULT 'other',
  sort_order integer NOT NULL DEFAULT 100
);

INSERT INTO lab_units (code, name, kind, sort_order) VALUES
  ('%',      '{"en":"per cent","ru":"процент","tr":"yüzde"}',                 'fraction', 10),
  ('ppm',    '{"en":"parts per million","ru":"частей на миллион","tr":"ppm"}','fraction', 20),
  ('mg/kg',  '{"en":"mg per kg","ru":"мг/кг","tr":"mg/kg"}',                  'fraction', 30),
  ('g/kg',   '{"en":"g per kg","ru":"г/кг","tr":"g/kg"}',                     'fraction', 40),
  ('kg/hl',  '{"en":"kg per hectolitre","ru":"кг/гл","tr":"kg/hl"}',          'density',  50),
  ('g/cm3',  '{"en":"g per cm³","ru":"г/см³","tr":"g/cm³"}',                  'density',  60),
  ('g/l',    '{"en":"g per litre","ru":"г/л","tr":"g/l"}',                    'density',  70),
  ('degC',   '{"en":"°C","ru":"°C","tr":"°C"}',                               'temperature', 80),
  ('s',      '{"en":"seconds","ru":"секунды","tr":"saniye"}',                 'time',     90),
  ('mm',     '{"en":"millimetres","ru":"мм","tr":"mm"}',                      'length',  100),
  ('count',  '{"en":"count","ru":"штук","tr":"adet"}',                        'count',   110),
  ('cfu/g',  '{"en":"CFU per g","ru":"КОЕ/г","tr":"KOB/g"}',                  'count',   120);

-- ---------- Test catalogue ----------------------------------------------------------------
CREATE TABLE lab_tests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  name         jsonb NOT NULL,
  category     text NOT NULL DEFAULT 'general',
  description  text,
  default_unit text REFERENCES lab_units(code),
  result_type  lab_result_type NOT NULL DEFAULT 'numeric',
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 100,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER lab_tests_updated_at BEFORE UPDATE ON lab_tests
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE INDEX lab_tests_active_idx ON lab_tests (category, sort_order) WHERE is_active;

-- ---------- Methods, and their versions ---------------------------------------------------
/**
 * A method says *how* an analysis is done: which standard, to what limits, under whose
 * accreditation. Methods change — a standard is revised, a limit of detection improves — and a
 * result taken last year must go on saying which version produced it. `version` is bumped by a
 * trigger whenever anything substantive changes, and every result stores a snapshot of the
 * method as it was at the moment of entry. Editing a method therefore cannot rewrite history.
 */
CREATE TABLE test_methods (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_test_id           uuid NOT NULL REFERENCES lab_tests(id) ON DELETE RESTRICT,
  code                  text NOT NULL UNIQUE,
  name                  text NOT NULL,
  /** ISO 712:2009, GAFTA 130, AOCS Ac 2-41, internal SOP… whatever the laboratory works to. */
  standard_reference    text,
  description           text,
  default_unit          text REFERENCES lab_units(code),
  detection_limit       numeric(18, 6),
  quantification_limit  numeric(18, 6),
  /** Free text on purpose: accreditation status is not ours to compute. */
  accreditation_scope   text,
  version               integer NOT NULL DEFAULT 1,
  effective_from        date NOT NULL DEFAULT current_date,
  retired_at            date,
  is_active             boolean NOT NULL DEFAULT true,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (retired_at IS NULL OR retired_at >= effective_from),
  CHECK (quantification_limit IS NULL OR detection_limit IS NULL OR quantification_limit >= detection_limit)
);
CREATE TRIGGER test_methods_updated_at BEFORE UPDATE ON test_methods
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

/** Bumping the version is the database's job, not a thing a service must remember to do. */
CREATE FUNCTION trg_bump_method_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name
     OR NEW.standard_reference IS DISTINCT FROM OLD.standard_reference
     OR NEW.default_unit IS DISTINCT FROM OLD.default_unit
     OR NEW.detection_limit IS DISTINCT FROM OLD.detection_limit
     OR NEW.quantification_limit IS DISTINCT FROM OLD.quantification_limit
     OR NEW.accreditation_scope IS DISTINCT FROM OLD.accreditation_scope THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER test_methods_version BEFORE UPDATE ON test_methods
  FOR EACH ROW EXECUTE FUNCTION trg_bump_method_version();

CREATE INDEX test_methods_test_idx ON test_methods (lab_test_id) WHERE is_active;

-- ---------- Specifications ----------------------------------------------------------------
/**
 * The limits a result is judged against, from the most specific source available.
 *
 * Resolution order — contract, then client, then commodity, then the bare default. The first
 * row that matches wins; ties inside a level are broken by the later `effective_from`. The
 * order lives in `app_resolve_specification` so the API, the report and any future rule engine
 * all answer the same question the same way.
 */
CREATE TABLE test_specifications (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_test_id             uuid NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
  test_method_id          uuid REFERENCES test_methods(id) ON DELETE SET NULL,
  commodity_id            uuid REFERENCES commodities(id) ON DELETE CASCADE,
  client_id               uuid REFERENCES clients(id) ON DELETE CASCADE,
  contract_id             uuid REFERENCES contracts(id) ON DELETE CASCADE,
  min_value               numeric(18, 6),
  max_value               numeric(18, 6),
  target_value            numeric(18, 6),
  unit                    text REFERENCES lab_units(code),
  qualitative_requirement text,
  notes                   text,
  effective_from          date NOT NULL DEFAULT current_date,
  effective_to            date,
  is_active               boolean NOT NULL DEFAULT true,
  created_by              uuid REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value),
  /** A specification that says nothing cannot judge anything. */
  CHECK (min_value IS NOT NULL OR max_value IS NOT NULL OR target_value IS NOT NULL
         OR qualitative_requirement IS NOT NULL)
);
CREATE TRIGGER test_specifications_updated_at BEFORE UPDATE ON test_specifications
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE INDEX test_spec_test_idx ON test_specifications (lab_test_id) WHERE is_active;
CREATE INDEX test_spec_commodity_idx ON test_specifications (commodity_id) WHERE commodity_id IS NOT NULL;
CREATE INDEX test_spec_client_idx ON test_specifications (client_id) WHERE client_id IS NOT NULL;
CREATE INDEX test_spec_contract_idx ON test_specifications (contract_id) WHERE contract_id IS NOT NULL;

/**
 * Picks the specification that applies, most specific first. SECURITY DEFINER because it is
 * consulted while writing a result, and the specification table has a policy of its own.
 */
CREATE FUNCTION app_resolve_specification(
  p_test uuid, p_method uuid, p_commodity uuid, p_client uuid, p_contract uuid, p_on date
) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id
  FROM test_specifications s
  WHERE s.is_active
    AND s.lab_test_id = p_test
    AND (s.test_method_id IS NULL OR s.test_method_id = p_method)
    AND s.effective_from <= p_on
    AND (s.effective_to IS NULL OR s.effective_to >= p_on)
    AND (s.contract_id IS NULL OR s.contract_id = p_contract)
    AND (s.client_id IS NULL OR s.client_id = p_client)
    AND (s.commodity_id IS NULL OR s.commodity_id = p_commodity)
  ORDER BY
    (s.contract_id IS NOT NULL) DESC,
    (s.client_id IS NOT NULL) DESC,
    (s.commodity_id IS NOT NULL) DESC,
    (s.test_method_id IS NOT NULL) DESC,
    s.effective_from DESC
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION app_resolve_specification(uuid, uuid, uuid, uuid, uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_specification(uuid, uuid, uuid, uuid, uuid, date) TO gsi_app;

-- ---------- Instruments -------------------------------------------------------------------
/**
 * Enough to say which instrument produced a reading and whether its calibration is overdue.
 * Calibration management proper is not built here, and nothing is blocked by an overdue
 * instrument: the laboratory is warned and the fact is recorded on the result.
 */
CREATE TABLE lab_instruments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  laboratory_id       uuid NOT NULL REFERENCES laboratories(id) ON DELETE CASCADE,
  code                text NOT NULL UNIQUE,
  name                text NOT NULL,
  manufacturer        text,
  model               text,
  serial_number       text,
  status              instrument_status NOT NULL DEFAULT 'active',
  calibration_due_at  date,
  notes               text,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER lab_instruments_updated_at BEFORE UPDATE ON lab_instruments
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE INDEX lab_instruments_lab_idx ON lab_instruments (laboratory_id) WHERE status = 'active';

-- ---------- Test requests -----------------------------------------------------------------
/**
 * One analysis on one sample, carried from "somebody asked for it" to "the laboratory has
 * released the answer". A sample has as many of these as it has analyses.
 *
 * No document number of its own: a request is named by its sample and its test, which is how
 * the laboratory refers to it out loud.
 */
CREATE TABLE test_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id          uuid NOT NULL REFERENCES branches(id),
  sample_id          uuid NOT NULL,
  laboratory_id      uuid NOT NULL REFERENCES laboratories(id),
  lab_test_id        uuid NOT NULL REFERENCES lab_tests(id),
  test_method_id     uuid NOT NULL REFERENCES test_methods(id),
  specification_id   uuid REFERENCES test_specifications(id),
  status             test_request_status NOT NULL DEFAULT 'requested',
  status_before_hold test_request_status,
  priority           job_priority NOT NULL DEFAULT 'normal',
  requested_by       uuid REFERENCES users(id),
  requested_at       timestamptz NOT NULL DEFAULT now(),
  assigned_analyst_id uuid REFERENCES users(id),
  assigned_by        uuid REFERENCES users(id),
  assigned_at        timestamptz,
  started_at         timestamptz,
  due_at             timestamptz,
  instructions       text,
  cancel_reason      text,
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, branch_id),
  FOREIGN KEY (sample_id, branch_id) REFERENCES samples (id, branch_id) ON DELETE CASCADE
);
CREATE TRIGGER test_requests_updated_at BEFORE UPDATE ON test_requests
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER test_requests_version BEFORE UPDATE ON test_requests
  FOR EACH ROW EXECUTE FUNCTION trg_bump_version();

CREATE INDEX test_requests_sample_idx   ON test_requests (sample_id);
CREATE INDEX test_requests_lab_idx      ON test_requests (laboratory_id, status);
CREATE INDEX test_requests_analyst_idx  ON test_requests (assigned_analyst_id) WHERE assigned_analyst_id IS NOT NULL;
CREATE INDEX test_requests_status_idx   ON test_requests (branch_id, status);
CREATE INDEX test_requests_due_idx      ON test_requests (due_at) WHERE due_at IS NOT NULL;
CREATE INDEX test_requests_updated_idx  ON test_requests (updated_at DESC);

/**
 * The same analysis by the same method cannot be requested twice on one sample while the first
 * is still alive. A cancelled or rejected request leaves the way clear for a repeat, which is
 * exactly what a repeat is for.
 */
CREATE UNIQUE INDEX test_requests_no_duplicate_idx
  ON test_requests (sample_id, lab_test_id, test_method_id)
  WHERE status NOT IN ('cancelled', 'rejected');

CREATE TABLE test_request_status_history (
  id              bigserial PRIMARY KEY,
  test_request_id uuid NOT NULL REFERENCES test_requests(id) ON DELETE CASCADE,
  branch_id       uuid NOT NULL,
  from_status     test_request_status,
  to_status       test_request_status NOT NULL,
  changed_by      uuid REFERENCES users(id),
  reason          text,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX test_request_history_idx ON test_request_status_history (test_request_id, created_at);

-- ---------- Results -----------------------------------------------------------------------
/**
 * One row per revision. An approved result is never edited: correcting it means a new revision
 * that supersedes the old one, and the old one stays exactly as it was approved — because a
 * report issued last month quoted it, and that report has to go on being true about what it
 * quoted.
 *
 * Numbers are `numeric`, never float. A moisture of 12.40 % that becomes 12.399999 because of
 * binary floating point is a laboratory result somebody will argue about.
 */
CREATE TABLE test_results (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_request_id       uuid NOT NULL REFERENCES test_requests(id) ON DELETE CASCADE,
  branch_id             uuid NOT NULL REFERENCES branches(id),
  revision              integer NOT NULL DEFAULT 1,
  /** Exactly one live revision per request; the rest are history. */
  is_current            boolean NOT NULL DEFAULT true,
  supersedes_result_id  uuid REFERENCES test_results(id),

  result_type           lab_result_type NOT NULL,
  numeric_value         numeric(18, 6),
  text_value            text,
  boolean_value         boolean,
  qualitative_value     text,
  unit                  text REFERENCES lab_units(code),

  /** The method and the limits as they were when this revision was entered. */
  method_snapshot       jsonb NOT NULL,
  specification_snapshot jsonb,
  evaluation            spec_evaluation NOT NULL DEFAULT 'not_evaluated',

  instrument_id         uuid REFERENCES lab_instruments(id),
  /** True when the instrument's calibration was already overdue at entry. Recorded, not blocked. */
  instrument_overdue    boolean NOT NULL DEFAULT false,

  analyst_id            uuid REFERENCES users(id),
  entered_at            timestamptz NOT NULL DEFAULT now(),
  submitted_at          timestamptz,
  reviewed_by           uuid REFERENCES users(id),
  reviewed_at           timestamptz,
  approved_by           uuid REFERENCES users(id),
  approved_at           timestamptz,
  released_by           uuid REFERENCES users(id),
  released_at           timestamptz,
  comments              text,
  review_comment        text,
  amendment_reason      text,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  UNIQUE (test_request_id, revision),
  /** A result has to say something. */
  CHECK (numeric_value IS NOT NULL OR text_value IS NOT NULL OR boolean_value IS NOT NULL
         OR qualitative_value IS NOT NULL),
  /** …and it has to say it in the shape its type promises. */
  CHECK (result_type <> 'numeric'     OR numeric_value IS NOT NULL),
  CHECK (result_type <> 'text'        OR text_value IS NOT NULL),
  CHECK (result_type <> 'boolean'     OR boolean_value IS NOT NULL),
  CHECK (result_type <> 'pass_fail'   OR boolean_value IS NOT NULL),
  CHECK (result_type <> 'qualitative' OR qualitative_value IS NOT NULL)
);
CREATE TRIGGER test_results_updated_at BEFORE UPDATE ON test_results
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER test_results_version BEFORE UPDATE ON test_results
  FOR EACH ROW EXECUTE FUNCTION trg_bump_version();

CREATE UNIQUE INDEX test_results_current_idx ON test_results (test_request_id) WHERE is_current;
CREATE INDEX test_results_analyst_idx ON test_results (analyst_id);
CREATE INDEX test_results_evaluation_idx ON test_results (evaluation) WHERE is_current;
CREATE INDEX test_results_released_idx ON test_results (released_at) WHERE released_at IS NOT NULL;

-- Evidence: instrument printouts, worksheets, chromatograms.
ALTER TABLE media_attachments ADD COLUMN test_result_id uuid REFERENCES test_results(id) ON DELETE SET NULL;
CREATE INDEX media_test_result_idx ON media_attachments (test_result_id);

-- ---------- Row-Level Security ------------------------------------------------------------
/**
 * Laboratory work is visible to the office that owns the sample and to the office that runs the
 * laboratory it was sent to — the same rule PHASE 5 uses for the sample itself, for the same
 * reason: whoever has to do the work has to be able to see it.
 */
ALTER TABLE test_requests               ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_request_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_results                ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_tests                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_methods                ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_specifications         ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_instruments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_units                   ENABLE ROW LEVEL SECURITY;

CREATE POLICY test_requests_visible ON test_requests FOR ALL
  USING (app_can_see_branch(branch_id) OR app_sees_laboratory(laboratory_id))
  WITH CHECK (app_can_see_branch(branch_id) OR app_sees_laboratory(laboratory_id));

CREATE POLICY test_request_history_read ON test_request_status_history FOR SELECT
  USING (EXISTS (SELECT 1 FROM test_requests r WHERE r.id = test_request_status_history.test_request_id));
CREATE POLICY test_request_history_write ON test_request_status_history FOR INSERT WITH CHECK (true);

CREATE POLICY test_results_visible ON test_results FOR ALL
  USING (EXISTS (SELECT 1 FROM test_requests r WHERE r.id = test_results.test_request_id))
  WITH CHECK (EXISTS (SELECT 1 FROM test_requests r WHERE r.id = test_results.test_request_id));

-- Reference data: everyone reads it, `lab.*_manage` writes it.
CREATE POLICY lab_units_read ON lab_units FOR SELECT USING (true);
CREATE POLICY lab_tests_read ON lab_tests FOR SELECT USING (true);
CREATE POLICY lab_tests_manage ON lab_tests FOR ALL
  USING (app_has_perm('lab.method.manage')) WITH CHECK (app_has_perm('lab.method.manage'));
CREATE POLICY test_methods_read ON test_methods FOR SELECT USING (true);
CREATE POLICY test_methods_manage ON test_methods FOR ALL
  USING (app_has_perm('lab.method.manage')) WITH CHECK (app_has_perm('lab.method.manage'));
CREATE POLICY test_spec_read ON test_specifications FOR SELECT USING (true);
CREATE POLICY test_spec_manage ON test_specifications FOR ALL
  USING (app_has_perm('lab.specification.manage')) WITH CHECK (app_has_perm('lab.specification.manage'));
CREATE POLICY lab_instruments_read ON lab_instruments FOR SELECT USING (true);
CREATE POLICY lab_instruments_manage ON lab_instruments FOR ALL
  USING (app_has_perm('lab.instrument.manage')) WITH CHECK (app_has_perm('lab.instrument.manage'));

GRANT SELECT ON lab_units TO gsi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON lab_tests, test_methods, test_specifications,
  lab_instruments, test_requests, test_results TO gsi_app;
-- Append-only, by grant.
GRANT SELECT, INSERT ON test_request_status_history TO gsi_app;
GRANT USAGE, SELECT ON SEQUENCE test_request_status_history_id_seq TO gsi_app;

-- ---------- Permissions -------------------------------------------------------------------
INSERT INTO permissions (code, category, description) VALUES
  ('lab.test.read',            'operations', 'See laboratory tests and results'),
  ('lab.test.request',         'operations', 'Request analyses on a sample'),
  ('lab.test.assign',          'operations', 'Assign an analyst'),
  ('lab.test.start',           'operations', 'Start an analysis'),
  ('lab.result.enter',         'operations', 'Enter a result'),
  ('lab.result.submit',        'operations', 'Submit a result for review'),
  ('lab.result.review',        'operations', 'Technically review a result'),
  ('lab.result.approve',       'operations', 'Approve a result'),
  ('lab.result.release',       'operations', 'Release a result for use in documents'),
  ('lab.result.amend',         'operations', 'Amend an approved result'),
  ('lab.method.read',          'reference',  'See tests and methods'),
  ('lab.method.manage',        'reference',  'Maintain the test catalogue and methods'),
  ('lab.specification.read',   'reference',  'See specifications'),
  ('lab.specification.manage', 'reference',  'Maintain specifications'),
  ('lab.instrument.read',      'reference',  'See laboratory instruments'),
  ('lab.instrument.manage',    'reference',  'Maintain laboratory instruments'),
  /**
   * Approving one's own result. Granted to nobody by the seed, on purpose: the default is that
   * the person who ran the analysis is not the person who signs it off. A one-person laboratory
   * exists and this is how it is served — but by somebody deciding to grant it, not by accident.
   */
  ('lab.result.self_approve',  'operations', 'Approve a result one entered oneself')
ON CONFLICT DO NOTHING;

-- Everyone who can see a sample can see what the laboratory is doing with it.
INSERT INTO role_permissions (role_code, permission_code)
SELECT DISTINCT role_code, v.code FROM role_permissions rp,
  (VALUES ('lab.test.read'), ('lab.method.read'), ('lab.specification.read'),
          ('lab.instrument.read')) AS v(code)
WHERE rp.permission_code = 'sample.read'
ON CONFLICT DO NOTHING;

-- Whoever dispatches samples asks for the analyses.
INSERT INTO role_permissions (role_code, permission_code)
SELECT DISTINCT role_code, 'lab.test.request' FROM role_permissions
WHERE permission_code = 'sample.dispatch'
ON CONFLICT DO NOTHING;

-- The analyst's bench: start the work, enter the result, hand it in. Not review, not approve.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'lab_analyst', v.code FROM (VALUES
  ('lab.test.read'), ('lab.test.start'), ('lab.result.enter'), ('lab.result.submit'),
  ('lab.method.read'), ('lab.specification.read'), ('lab.instrument.read')) AS v(code)
ON CONFLICT DO NOTHING;

/**
 * The laboratory manager runs the bench and judges its work: assignment, review, approval and
 * release, plus the reference data. Deliberately not `lab.result.enter` — a manager who needs
 * to run an analysis themselves is given that right explicitly, and then the separation of
 * entry from approval is a decision somebody made rather than an accident of the seed.
 */
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'lab_manager', v.code FROM (VALUES
  ('lab.test.read'), ('lab.test.request'), ('lab.test.assign'), ('lab.test.start'),
  ('lab.result.review'), ('lab.result.approve'), ('lab.result.release'), ('lab.result.amend'),
  ('lab.method.read'), ('lab.method.manage'), ('lab.specification.read'), ('lab.specification.manage'),
  ('lab.instrument.read'), ('lab.instrument.manage')) AS v(code)
ON CONFLICT DO NOTHING;

-- Administrators and the people who run offices and countries see and steer everything —
-- except self-approval, which nobody is given by default.
INSERT INTO role_permissions (role_code, permission_code)
SELECT r.code, p.code FROM roles r, permissions p
WHERE r.code IN ('admin', 'country_manager', 'office_manager')
  AND p.code LIKE 'lab.%' AND p.code <> 'lab.result.self_approve'
ON CONFLICT DO NOTHING;

-- A supervisor asks for analyses and follows them; the laboratory decides.
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'supervisor', v.code FROM (VALUES
  ('lab.test.read'), ('lab.test.request'), ('lab.method.read'), ('lab.specification.read'),
  ('lab.instrument.read')) AS v(code)
ON CONFLICT DO NOTHING;

-- ---------- The test catalogue, built from data that already existed -----------------------
/**
 * These 33 analyses are not invented here: they are the distinct values of
 * `commodities.lab_methods`, curated per commodity in migration 004 and used by the reference
 * screens ever since. All this does is give each of them a row, a translated name, a result
 * type and a default unit, so a request can point at one.
 *
 * Result types are assigned where the analysis plainly is not a number — a salmonella screen
 * is found or not found, a GMO screen passes or fails — and left numeric otherwise.
 */
INSERT INTO lab_tests (code, name, category, result_type, default_unit, sort_order)
SELECT v.code, v.name::jsonb, v.category, v.result_type::lab_result_type, v.default_unit, v.sort_order
FROM (VALUES
  ('moisture',          '{"en":"Moisture","ru":"Влажность","tr":"Nem"}',                                   'physical',   'numeric',     '%',      10),
  ('moisture_volatile', '{"en":"Moisture & volatile matter","ru":"Влага и летучие вещества","tr":"Nem ve uçucu madde"}', 'physical', 'numeric', '%', 15),
  ('protein',           '{"en":"Protein","ru":"Белок","tr":"Protein"}',                                    'chemical',   'numeric',     '%',      20),
  ('gluten',            '{"en":"Wet gluten","ru":"Клейковина","tr":"Yaş gluten"}',                         'chemical',   'numeric',     '%',      30),
  ('oil_content',       '{"en":"Oil content","ru":"Масличность","tr":"Yağ oranı"}',                        'chemical',   'numeric',     '%',      40),
  ('fibre',             '{"en":"Crude fibre","ru":"Сырая клетчатка","tr":"Ham selüloz"}',                   'chemical',   'numeric',     '%',      50),
  ('nitrogen',          '{"en":"Nitrogen","ru":"Азот","tr":"Azot"}',                                       'chemical',   'numeric',     '%',      60),
  ('phosphorus',        '{"en":"Phosphorus","ru":"Фосфор","tr":"Fosfor"}',                                 'chemical',   'numeric',     '%',      70),
  ('biuret',            '{"en":"Biuret","ru":"Биурет","tr":"Biüre"}',                                      'chemical',   'numeric',     '%',      80),
  ('urease',            '{"en":"Urease activity","ru":"Уреазная активность","tr":"Üreaz aktivitesi"}',      'chemical',   'numeric',     'mg/kg',  90),
  ('free_fatty_acids',  '{"en":"Free fatty acids","ru":"Свободные жирные кислоты","tr":"Serbest yağ asitleri"}', 'chemical', 'numeric', '%',     100),
  ('peroxide_value',    '{"en":"Peroxide value","ru":"Перекисное число","tr":"Peroksit değeri"}',           'chemical',   'numeric',     'mg/kg', 110),
  ('erucic_acid',       '{"en":"Erucic acid","ru":"Эруковая кислота","tr":"Erusik asit"}',                  'chemical',   'numeric',     '%',     120),
  ('glucosinolates',    '{"en":"Glucosinolates","ru":"Глюкозинолаты","tr":"Glukozinolatlar"}',              'chemical',   'numeric',     'ppm',   130),
  ('gossypol',          '{"en":"Free gossypol","ru":"Свободный госсипол","tr":"Serbest gossipol"}',         'chemical',   'numeric',     '%',     140),
  ('polarisation',      '{"en":"Polarisation","ru":"Поляризация","tr":"Polarizasyon"}',                     'chemical',   'numeric',     '%',     150),
  ('acidity',           '{"en":"Acidity","ru":"Кислотность","tr":"Asitlik"}',                               'chemical',   'numeric',     '%',     155),
  ('test_weight',       '{"en":"Test weight","ru":"Натура","tr":"Hektolitre ağırlığı"}',                    'physical',   'numeric',     'kg/hl', 160),
  ('falling_number',    '{"en":"Falling number","ru":"Число падения","tr":"Düşme sayısı"}',                 'physical',   'numeric',     's',     170),
  ('vitreousness',      '{"en":"Vitreousness","ru":"Стекловидность","tr":"Camsılık"}',                      'physical',   'numeric',     '%',     180),
  ('screenings',        '{"en":"Screenings","ru":"Отсев","tr":"Elek altı"}',                                'physical',   'numeric',     '%',     190),
  ('granulometry',      '{"en":"Granulometry","ru":"Гранулометрия","tr":"Granülometri"}',                   'physical',   'numeric',     '%',     200),
  ('size_grading',      '{"en":"Size grading","ru":"Калибровка","tr":"Boy eleme"}',                         'physical',   'numeric',     '%',     210),
  ('broken_grains',     '{"en":"Broken grains","ru":"Битое зерно","tr":"Kırık tane"}',                      'physical',   'numeric',     '%',     220),
  ('damaged_grains',    '{"en":"Damaged grains","ru":"Повреждённое зерно","tr":"Zarar görmüş tane"}',        'physical',   'numeric',     '%',     230),
  ('foreign_matter',    '{"en":"Foreign matter","ru":"Сорная примесь","tr":"Yabancı madde"}',               'physical',   'numeric',     '%',     240),
  ('impurities',        '{"en":"Impurities","ru":"Примеси","tr":"Safsızlıklar"}',                           'physical',   'numeric',     '%',     250),
  ('germination',       '{"en":"Germination","ru":"Всхожесть","tr":"Çimlenme"}',                            'biological', 'numeric',     '%',     260),
  ('colour',            '{"en":"Colour","ru":"Цвет","tr":"Renk"}',                                          'physical',   'qualitative', NULL,    270),
  ('aflatoxin',         '{"en":"Aflatoxin","ru":"Афлатоксин","tr":"Aflatoksin"}',                           'safety',     'numeric',     'ppm',   280),
  ('mycotoxins',        '{"en":"Mycotoxins","ru":"Микотоксины","tr":"Mikotoksinler"}',                      'safety',     'numeric',     'ppm',   290),
  ('pesticides',        '{"en":"Pesticide screening","ru":"Скрининг пестицидов","tr":"Pestisit taraması"}',  'safety',     'pass_fail',   NULL,    300),
  ('gmo',               '{"en":"GMO screening","ru":"Скрининг ГМО","tr":"GDO taraması"}',                    'safety',     'pass_fail',   NULL,    310),
  ('salmonella',        '{"en":"Salmonella","ru":"Сальмонелла","tr":"Salmonella"}',                          'biological', 'pass_fail',   NULL,    320)
) AS v(code, name, category, result_type, default_unit, sort_order)
ON CONFLICT (code) DO NOTHING;

-- Anything a deployment has in `lab_methods` that the list above does not cover still gets a
-- row, named after itself, rather than being silently unavailable.
INSERT INTO lab_tests (code, name, category, result_type, sort_order)
SELECT DISTINCT m, jsonb_build_object('en', initcap(replace(m, '_', ' '))), 'general', 'numeric'::lab_result_type, 900
FROM commodities c, unnest(c.lab_methods) AS m
ON CONFLICT (code) DO NOTHING;
