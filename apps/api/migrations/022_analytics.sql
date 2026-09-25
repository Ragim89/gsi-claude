-- ---------------------------------------------------------------------------------------
-- 022. PHASE 9 — Analytics permissions.
--
-- No new tables. Every analytics query reads inspection_jobs, inspections, samples,
-- test_requests, test_results and report_versions exactly as they already stand, scoped by
-- the same Row-Level Security every other module already relies on (app_can_see_branch,
-- the 'own' branch on inspections/samples) — a field role querying the analytics endpoints
-- gets back only their own rows, an office manager their office, a country manager their
-- country. This migration only adds the two permissions the new controller checks and grants
-- them to the roles the plan names.
--
-- 'admin' and 'country_manager' do not pick up new permissions automatically — their catalogue
-- membership was a one-time SELECT at migration 008, not a standing rule — so, like every
-- later phase, they are granted explicitly below alongside the roles the plan actually names.
-- ---------------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------------------
-- reports has no index on job_id — every other foreign key on it does (branch, client,
-- inspection, sample), this one does not. EXPLAIN ANALYZE on the turnaround query (job →
-- report, per job) showed a sequential scan of reports for each of 999 seeded jobs, ~95ms of
-- a ~220ms query; adding this index took it to a plan that no longer seq-scans reports at
-- all. Job → report is also how the job detail page's documents tab and the job finance
-- summary already look a report up, so this is not analytics-only.
-- ---------------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS reports_job_idx ON reports (job_id) WHERE deleted_at IS NULL;

INSERT INTO permissions (code, category, description) VALUES
  ('analytics.read',     'analytics', 'View operational analytics: jobs, turnaround, executive summary'),
  ('analytics.workload', 'analytics', 'View team and laboratory workload breakdown')
ON CONFLICT DO NOTHING;

-- Base analytics access: every role with day-to-day operational visibility. RLS narrows what
-- each of them actually sees — an inspector's 'own' scope turns the same endpoint into "my
-- turnaround", not the group's.
INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'analytics.read' FROM roles
WHERE code IN ('admin', 'cfo', 'country_manager', 'office_manager', 'supervisor', 'operations',
               'report_reviewer', 'lab_manager', 'lab_analyst', 'inspector', 'sampler')
ON CONFLICT DO NOTHING;

-- Workload breaks down other people's counts (who is busy, who finished what), so it stays
-- with roles that manage a team rather than every role that works on one.
INSERT INTO role_permissions (role_code, permission_code)
SELECT code, 'analytics.workload' FROM roles
WHERE code IN ('admin', 'cfo', 'country_manager', 'office_manager', 'supervisor', 'operations', 'lab_manager')
ON CONFLICT DO NOTHING;
