/**
 * PHASE 7 — the states a document can be in.
 *
 * Alone in its own migration for a reason PostgreSQL insists on: a value added to an enum
 * cannot be *used* until the transaction that added it has committed, and everything else in
 * this phase — the verification function, the policies — needs to name these. So they are
 * declared here and used from 017 onwards.
 *
 * `draft`, `issued` and `revoked` already existed and keep their meaning. `revoked` predates
 * the workflow and means what `cancelled` now means; it stays because rows carry it and
 * renaming a value nobody benefits from renaming would only break the queries that read it.
 */
ALTER TYPE report_status ADD VALUE IF NOT EXISTS 'under_review'      AFTER 'draft';
ALTER TYPE report_status ADD VALUE IF NOT EXISTS 'changes_requested' AFTER 'under_review';
ALTER TYPE report_status ADD VALUE IF NOT EXISTS 'approved'          AFTER 'changes_requested';
ALTER TYPE report_status ADD VALUE IF NOT EXISTS 'superseded'        AFTER 'issued';
ALTER TYPE report_status ADD VALUE IF NOT EXISTS 'cancelled'         AFTER 'superseded';
