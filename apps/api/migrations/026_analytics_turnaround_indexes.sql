-- ---------------------------------------------------------------------------------------
-- 026. Two indexes for the analytics turnaround query (PHASE 12).
--
-- `EXPLAIN ANALYZE` against the seeded 999 jobs (see scripts/load-test.mjs and the PHASE 12
-- report) showed `GET /analytics/turnaround` doing a sequential scan of `inspections` and of
-- `reports`, once per job (999 loops), despite each table already having a partial index on
-- `job_id ... WHERE deleted_at IS NULL`.
--
-- The reason those partial indexes go unused here is Row-Level Security itself: the visibility
-- policy on both tables filters with `app_is_live(deleted_at)`, a STABLE function
-- (`deleted_at IS NULL OR app_show_archived()`), not the bare `deleted_at IS NULL` the partial
-- index was built with. Postgres cannot prove a function call implies a literal predicate, so
-- it falls back to a full scan under every RLS-filtered query against these two tables, no
-- matter what the application's own WHERE clause says.
--
-- Reaching into the RLS policies themselves to fix that is out of scope for one query — it
-- would touch how every table's soft-delete visibility is enforced. A second, non-partial
-- index on the join column sidesteps the function-vs-literal mismatch instead: it works
-- underneath the RLS filter rather than trying to match it, at the cost of indexing the
-- (tiny number of) archived rows too.
--
-- Measured effect: 90ms -> 27ms for this query against the seeded data (~70% down), by turning
-- two of the three per-job lookups from a 999-row scan repeated 999 times into an index probe.
-- The third (`samples`, ~50 rows) stayed a sequential scan on measurement — the table is small
-- enough that Postgres correctly prefers it over an index, so no index was added for it.
-- ---------------------------------------------------------------------------------------

CREATE INDEX inspections_job_full_idx ON inspections (job_id);
CREATE INDEX reports_job_full_idx ON reports (job_id);
