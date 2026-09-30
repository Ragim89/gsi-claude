-- =====================================================================================
-- 029. Multi-service inspection requests.
--
-- Until now a job was one client + one service `type`. Operations needs one client + one
-- contract → several billable services on the same request (e.g. draft survey + sampling +
-- analysis in one job). This does not touch `inspection_jobs.type` or anything that reads
-- it — a job with zero `job_lines` rows is exactly the job that exists today. A job with
-- rows is the new multi-service path; the two are told apart by whether `job_lines` has
-- anything for that job, not by a new column or flag.
--
-- Shape and RLS copied from `quote_lines` (020_finance_quotes.sql) — the codebase's own
-- multi-line-item-with-a-service pattern — rather than inventing a second one. `price_id`
-- is the price snapshot: the line remembers which `prices` row it was resolved from, but
-- `unit_price`/`currency` are copied onto the line itself so the amount never changes if
-- that price is later deactivated or superseded.
-- =====================================================================================

CREATE TABLE job_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   uuid NOT NULL,
  job_id      uuid NOT NULL,
  service_id  uuid REFERENCES services(id) ON DELETE SET NULL,
  price_id    uuid REFERENCES prices(id) ON DELETE SET NULL,
  description text NOT NULL,
  quantity    numeric(12, 3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price  numeric(14, 2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  currency    char(3) NOT NULL,
  amount      numeric(14, 2) GENERATED ALWAYS AS (round(quantity * unit_price, 2)) STORED,
  sort_order  integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, branch_id) REFERENCES inspection_jobs (id, branch_id) ON DELETE CASCADE
);
CREATE INDEX job_lines_job_idx ON job_lines (job_id);

CREATE FUNCTION trg_inherit_job_line_branch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.branch_id := (SELECT j.branch_id FROM inspection_jobs j WHERE j.id = NEW.job_id);
  RETURN NEW;
END $$;
CREATE TRIGGER job_lines_branch BEFORE INSERT ON job_lines
  FOR EACH ROW EXECUTE FUNCTION trg_inherit_job_line_branch();

-- ---------- Row-Level Security --------------------------------------------------------
ALTER TABLE job_lines ENABLE ROW LEVEL SECURITY;

-- Same audience as the job itself: whoever can read the job can read (and, with job.update,
-- write) its lines. No new permission code — a job line is part of the job resource.
CREATE POLICY job_lines_branch ON job_lines FOR ALL
  USING (app_has_perm('job.read') AND app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM inspection_jobs j WHERE j.id = job_lines.job_id))
  WITH CHECK (app_has_perm('job.read') AND app_can_see_branch(branch_id)
         AND EXISTS (SELECT 1 FROM inspection_jobs j WHERE j.id = job_lines.job_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON job_lines TO gsi_app;
