import { Injectable } from '@nestjs/common';
import {
  AuthUser,
  JobsAnalytics,
  JobStatus,
  LaboratoryWorkloadRow,
  ServiceType,
  TurnaroundAnalytics,
  TurnaroundStage,
  WorkloadAnalytics,
  WorkloadRow,
} from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * PHASE 9 — Operational analytics.
 *
 * No new tables: every number here is read straight from inspection_jobs, inspections,
 * samples, test_requests, test_results and report_versions — the same rows the operational
 * modules already write. Row-Level Security scopes every query exactly as it scopes those
 * modules' own list endpoints (docs/DATABASE.md), so an inspector with 'own' scope calling
 * these endpoints gets back their own work, not the group's — there is no separate
 * "personal analytics" endpoint, the same SQL just resolves to a smaller set of rows.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly db: DbService) {}

  async jobs(user: AuthUser, from?: string, to?: string, branchId?: string, countryId?: string): Promise<JobsAnalytics> {
    const p = period(from, to, branchId, countryId);
    return this.db.tx(user, async (tx) => {
      const [monthly, byBranch, byCountry, byClient, byService, byStatus] = await Promise.all([
        this.jobsMonthly(tx, p),
        this.jobsByBranch(tx, p),
        this.jobsByCountry(tx, p),
        this.jobsByClient(tx, p),
        this.jobsByService(tx, p),
        this.jobsByStatus(tx, p),
      ]);
      return {
        period: { from: p.from, to: p.to },
        totals: { jobCount: monthly.reduce((s, m) => s + m.count, 0) },
        monthly,
        byBranch,
        byCountry,
        byClient,
        byService,
        byStatus,
        generatedAt: new Date().toISOString(),
      };
    });
  }

  private async jobsMonthly(tx: Tx, p: Period) {
    const rows = await tx.many<{ month: string; count: number }>(
      `WITH months AS (
         SELECT date_trunc('month', m)::date AS m_start
         FROM generate_series(date_trunc('month', $1::date), date_trunc('month', $2::date), interval '1 month') m
       )
       SELECT to_char(months.m_start, 'YYYY-MM') AS month, count(j.id)::int AS count
       FROM months
       LEFT JOIN inspection_jobs j ON date_trunc('month', j.created_at)::date = months.m_start
         AND ($3::uuid IS NULL OR j.branch_id = $3::uuid)
         AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM branches b WHERE b.id = j.branch_id AND b.country_id = $4::uuid))
       GROUP BY months.m_start ORDER BY months.m_start`,
      [p.from, p.to, p.branchId, p.countryId],
    );
    return rows.map((r) => ({ month: r.month, count: n(r.count) }));
  }

  private async jobsByBranch(tx: Tx, p: Period) {
    const rows = await tx.many<Record<string, unknown>>(
      `SELECT b.id AS "branchId", b.code AS "branchCode", b.country, b.city, count(j.id)::int AS count
       FROM branches b
       LEFT JOIN inspection_jobs j ON j.branch_id = b.id AND j.created_at::date BETWEEN $1::date AND $2::date
       WHERE ($3::uuid IS NULL OR b.id = $3::uuid) AND ($4::uuid IS NULL OR b.country_id = $4::uuid)
       GROUP BY b.id, b.code, b.country, b.city
       HAVING count(j.id) > 0
       ORDER BY count DESC`,
      [p.from, p.to, p.branchId, p.countryId],
    );
    return withShare(rows.map((r) => ({
      key: String(r.branchId), branchId: String(r.branchId), branchCode: String(r.branchCode),
      country: String(r.country), city: String(r.city), count: n(r.count),
    })));
  }

  private async jobsByCountry(tx: Tx, p: Period) {
    const rows = await tx.many<{ country: string; count: number }>(
      `SELECT b.country, count(j.id)::int AS count
       FROM branches b
       LEFT JOIN inspection_jobs j ON j.branch_id = b.id AND j.created_at::date BETWEEN $1::date AND $2::date
       WHERE ($3::uuid IS NULL OR b.id = $3::uuid) AND ($4::uuid IS NULL OR b.country_id = $4::uuid)
       GROUP BY b.country
       HAVING count(j.id) > 0
       ORDER BY count DESC`,
      [p.from, p.to, p.branchId, p.countryId],
    );
    return withShare(rows.map((r) => ({ key: r.country, country: r.country, count: n(r.count) })));
  }

  private async jobsByClient(tx: Tx, p: Period) {
    const rows = await tx.many<{ clientId: string; key: string; count: number }>(
      `SELECT c.id AS "clientId", c.name AS key, count(*)::int AS count
       FROM inspection_jobs j
       JOIN branches b ON b.id = j.branch_id
       JOIN clients c ON c.id = j.client_id
       WHERE j.created_at::date BETWEEN $1::date AND $2::date
         AND ($3::uuid IS NULL OR j.branch_id = $3::uuid) AND ($4::uuid IS NULL OR b.country_id = $4::uuid)
       GROUP BY c.id, c.name ORDER BY count DESC LIMIT 10`,
      [p.from, p.to, p.branchId, p.countryId],
    );
    return withShare(rows.map((r) => ({ key: r.key, clientId: r.clientId, count: n(r.count) })));
  }

  private async jobsByService(tx: Tx, p: Period) {
    const rows = await tx.many<{ key: string; count: number }>(
      `SELECT j.type::text AS key, count(*)::int AS count
       FROM inspection_jobs j
       JOIN branches b ON b.id = j.branch_id
       WHERE j.created_at::date BETWEEN $1::date AND $2::date
         AND ($3::uuid IS NULL OR j.branch_id = $3::uuid) AND ($4::uuid IS NULL OR b.country_id = $4::uuid)
       GROUP BY j.type ORDER BY count DESC`,
      [p.from, p.to, p.branchId, p.countryId],
    );
    return withShare(rows.map((r) => ({ key: r.key as ServiceType, count: n(r.count) })));
  }

  private async jobsByStatus(tx: Tx, p: Period) {
    const rows = await tx.many<{ status: string; count: number }>(
      `SELECT j.status::text AS status, count(*)::int AS count
       FROM inspection_jobs j
       JOIN branches b ON b.id = j.branch_id
       WHERE j.created_at::date BETWEEN $1::date AND $2::date
         AND ($3::uuid IS NULL OR j.branch_id = $3::uuid) AND ($4::uuid IS NULL OR b.country_id = $4::uuid)
       GROUP BY j.status ORDER BY count DESC`,
      [p.from, p.to, p.branchId, p.countryId],
    );
    return rows.map((r) => ({ status: r.status as JobStatus, count: n(r.count) }));
  }

  // ---------------------------------------------------------------------------------------
  // Turnaround: five stages, each the calendar-day gap between two events already recorded
  // elsewhere. Computed per job in one query, then reduced to avg/median/p90 in JS so a stage
  // with no qualifying jobs honestly reports null rather than an average of zero rows.
  // ---------------------------------------------------------------------------------------

  async turnaround(user: AuthUser, from?: string, to?: string, branchId?: string, countryId?: string): Promise<TurnaroundAnalytics> {
    const p = period(from, to, branchId, countryId);
    return this.db.tx(user, async (tx) => {
      const [rows, monthly] = await Promise.all([this.turnaroundRows(tx, p), this.turnaroundMonthly(tx, p)]);
      const stage = (key: TurnaroundStage['key'], values: number[]): TurnaroundStage => {
        const clean = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
        return {
          key,
          sampleSize: clean.length,
          avgDays: clean.length ? round2(clean.reduce((s, v) => s + v, 0) / clean.length) : null,
          medianDays: percentile(clean, 0.5),
          p90Days: percentile(clean, 0.9),
        };
      };
      return {
        period: { from: p.from, to: p.to },
        stages: [
          stage('jobToInspection', rows.map((r) => r.jobToInspection).filter(isNum)),
          stage('inspectionToLab', rows.map((r) => r.inspectionToLab).filter(isNum)),
          stage('labToReleased', rows.map((r) => r.labToReleased).filter(isNum)),
          stage('releasedToReport', rows.map((r) => r.releasedToReport).filter(isNum)),
          stage('jobToReport', rows.map((r) => r.jobToReport).filter(isNum)),
        ],
        monthly,
        generatedAt: new Date().toISOString(),
      };
    });
  }

  private async turnaroundRows(tx: Tx, p: Period) {
    const rows = await tx.many<Record<string, unknown>>(
      `WITH job_events AS MATERIALIZED (
         -- MATERIALIZED: report_issued below is read twice in the final SELECT (releasedToReport
         -- and jobToReport); without it Postgres inlines this CTE and re-runs that correlated
         -- subquery once per reference. Each LATERAL below touches its tables exactly once per
         -- job instead of once per stage — measured with EXPLAIN ANALYZE against the seeded
         -- 999 jobs, this cut the query from ~220ms to ~90ms.
         SELECT j.id AS job_id, j.created_at AS job_created,
                insp.start_at AS insp_start, insp.end_at AS insp_end,
                lab.received_at AS lab_received, lab.requested_at AS lab_requested, lab.released_at AS lab_released,
                rep.issued_at AS report_issued
         FROM inspection_jobs j
         JOIN branches b ON b.id = j.branch_id
         LEFT JOIN LATERAL (
           SELECT min(i.actual_start) AS start_at, min(i.actual_end) AS end_at
           FROM inspections i WHERE i.job_id = j.id
         ) insp ON true
         LEFT JOIN LATERAL (
           -- MIN/MAX are unaffected by the row duplication this join produces (one row per
           -- sample × test_request × test_result), so one pass over the three tables answers
           -- all three timestamps instead of three separate scans.
           SELECT min(s.received_at) FILTER (WHERE s.received_at IS NOT NULL) AS received_at,
                  min(tr.requested_at) AS requested_at,
                  max(tres.released_at) FILTER (WHERE tres.is_current AND tres.released_at IS NOT NULL) AS released_at
           FROM samples s
           LEFT JOIN test_requests tr ON tr.sample_id = s.id
           LEFT JOIN test_results tres ON tres.test_request_id = tr.id
           WHERE s.job_id = j.id
         ) lab ON true
         LEFT JOIN LATERAL (
           SELECT max(rv.issued_at) AS issued_at
           FROM reports r JOIN report_versions rv ON rv.report_id = r.id
           WHERE r.job_id = j.id AND rv.issued_at IS NOT NULL
         ) rep ON true
         WHERE j.created_at::date BETWEEN $1::date AND $2::date
           AND ($3::uuid IS NULL OR j.branch_id = $3::uuid) AND ($4::uuid IS NULL OR b.country_id = $4::uuid)
       )
       SELECT
         EXTRACT(EPOCH FROM (insp_start - job_created)) / 86400.0 AS "jobToInspection",
         EXTRACT(EPOCH FROM (lab_received - insp_end)) / 86400.0 AS "inspectionToLab",
         EXTRACT(EPOCH FROM (lab_released - lab_requested)) / 86400.0 AS "labToReleased",
         EXTRACT(EPOCH FROM (report_issued - lab_released)) / 86400.0 AS "releasedToReport",
         EXTRACT(EPOCH FROM (report_issued - job_created)) / 86400.0 AS "jobToReport"
       FROM job_events`,
      [p.from, p.to, p.branchId, p.countryId],
    );
    return rows.map((r) => ({
      jobToInspection: r.jobToInspection === null ? null : Number(r.jobToInspection),
      inspectionToLab: r.inspectionToLab === null ? null : Number(r.inspectionToLab),
      labToReleased: r.labToReleased === null ? null : Number(r.labToReleased),
      releasedToReport: r.releasedToReport === null ? null : Number(r.releasedToReport),
      jobToReport: r.jobToReport === null ? null : Number(r.jobToReport),
    }));
  }

  private async turnaroundMonthly(tx: Tx, p: Period) {
    const rows = await tx.many<{ month: string; avg_days: number | null; n: number }>(
      `WITH months AS (
         SELECT date_trunc('month', m)::date AS m_start
         FROM generate_series(date_trunc('month', $1::date), date_trunc('month', $2::date), interval '1 month') m
       )
       SELECT to_char(months.m_start, 'YYYY-MM') AS month,
              avg(EXTRACT(EPOCH FROM (rv.issued_at - j.created_at)) / 86400.0)::float8 AS avg_days,
              count(rv.id)::int AS n
       FROM months
       LEFT JOIN (
         report_versions rv
         JOIN reports r ON r.id = rv.report_id
         JOIN inspection_jobs j ON j.id = r.job_id
         JOIN branches b ON b.id = j.branch_id
       ) ON date_trunc('month', rv.issued_at)::date = months.m_start
         AND rv.issued_at IS NOT NULL
         AND ($3::uuid IS NULL OR j.branch_id = $3::uuid) AND ($4::uuid IS NULL OR b.country_id = $4::uuid)
       GROUP BY months.m_start ORDER BY months.m_start`,
      [p.from, p.to, p.branchId, p.countryId],
    );
    return rows.map((r) => ({
      month: r.month,
      avgDays: r.avg_days === null ? null : round2(n(r.avg_days)),
      sampleSize: n(r.n),
    }));
  }

  // ---------------------------------------------------------------------------------------
  // Workload: who is carrying what, right now (active) and what they finished in the period
  // (completed). Sourced from the same assignment and attribution columns the operational
  // modules already write (job_assignments, test_requests, report_versions) — nothing here
  // is a new concept, only a new way of counting it.
  // ---------------------------------------------------------------------------------------

  async workload(user: AuthUser, from?: string, to?: string, branchId?: string, countryId?: string): Promise<WorkloadAnalytics> {
    const p = period(from, to, branchId, countryId);
    return this.db.tx(user, async (tx) => {
      const [inspectors, samplers, labAnalysts, laboratories, reviewers] = await Promise.all([
        this.assignmentWorkload(tx, p, ['lead_inspector', 'inspector']),
        this.assignmentWorkload(tx, p, ['sampler']),
        this.labAnalystWorkload(tx, p),
        this.laboratoryWorkload(tx, p),
        this.reviewerWorkload(tx, p),
      ]);
      return {
        period: { from: p.from, to: p.to },
        inspectors,
        samplers,
        labAnalysts,
        laboratories,
        reviewers,
        generatedAt: new Date().toISOString(),
      };
    });
  }

  /** Inspectors and samplers: who is on the job (job_assignments), active vs finished. */
  private async assignmentWorkload(tx: Tx, p: Period, roles: string[]): Promise<WorkloadRow[]> {
    const rows = await tx.many<Record<string, unknown>>(
      `SELECT u.id AS "userId", u.full_name AS name, b.code AS "branchCode",
              count(*) FILTER (WHERE j.status NOT IN ('completed','invoiced','closed','cancelled'))::int AS active,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM job_status_history h
                WHERE h.job_id = j.id AND h.to_status = 'completed' AND h.created_at::date BETWEEN $1::date AND $2::date
              ))::int AS completed
       FROM job_assignments ja
       JOIN inspection_jobs j ON j.id = ja.job_id
       JOIN users u ON u.id = ja.user_id
       JOIN branches b ON b.id = j.branch_id
       WHERE ja.removed_at IS NULL AND ja.role::text = ANY($5::text[])
         AND ($3::uuid IS NULL OR j.branch_id = $3::uuid) AND ($4::uuid IS NULL OR b.country_id = $4::uuid)
       GROUP BY u.id, u.full_name, b.code
       HAVING count(*) FILTER (WHERE j.status NOT IN ('completed','invoiced','closed','cancelled')) > 0
           OR count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM job_status_history h
                WHERE h.job_id = j.id AND h.to_status = 'completed' AND h.created_at::date BETWEEN $1::date AND $2::date
              )) > 0
       ORDER BY active DESC, completed DESC
       LIMIT 100`,
      [p.from, p.to, p.branchId, p.countryId, roles],
    );
    return rows.map((r) => ({
      userId: String(r.userId), name: String(r.name), branchCode: String(r.branchCode),
      active: n(r.active), completed: n(r.completed),
    }));
  }

  private async labAnalystWorkload(tx: Tx, p: Period): Promise<WorkloadRow[]> {
    const rows = await tx.many<Record<string, unknown>>(
      `SELECT u.id AS "userId", u.full_name AS name, b.code AS "branchCode",
              count(DISTINCT tr.id) FILTER (WHERE tr.status NOT IN ('released','rejected','cancelled'))::int AS active,
              count(DISTINCT tr.id) FILTER (WHERE EXISTS (
                SELECT 1 FROM test_results tres WHERE tres.test_request_id = tr.id AND tres.analyst_id = u.id
                  AND tres.entered_at::date BETWEEN $1::date AND $2::date
              ))::int AS completed
       FROM test_requests tr
       JOIN users u ON u.id = tr.assigned_analyst_id
       JOIN branches b ON b.id = tr.branch_id
       WHERE ($3::uuid IS NULL OR tr.branch_id = $3::uuid) AND ($4::uuid IS NULL OR b.country_id = $4::uuid)
       GROUP BY u.id, u.full_name, b.code
       HAVING count(DISTINCT tr.id) FILTER (WHERE tr.status NOT IN ('released','rejected','cancelled')) > 0
           OR count(DISTINCT tr.id) FILTER (WHERE EXISTS (
                SELECT 1 FROM test_results tres WHERE tres.test_request_id = tr.id AND tres.analyst_id = u.id
                  AND tres.entered_at::date BETWEEN $1::date AND $2::date
              )) > 0
       ORDER BY active DESC, completed DESC
       LIMIT 100`,
      [p.from, p.to, p.branchId, p.countryId],
    );
    return rows.map((r) => ({
      userId: String(r.userId), name: String(r.name), branchCode: String(r.branchCode),
      active: n(r.active), completed: n(r.completed),
    }));
  }

  private async laboratoryWorkload(tx: Tx, p: Period): Promise<LaboratoryWorkloadRow[]> {
    const rows = await tx.many<Record<string, unknown>>(
      `SELECT l.id AS "laboratoryId", l.name AS name,
              count(DISTINCT tr.id) FILTER (WHERE tr.status NOT IN ('released','rejected','cancelled'))::int AS active,
              count(DISTINCT tr.id) FILTER (WHERE tr.status = 'released' AND EXISTS (
                SELECT 1 FROM test_results tres WHERE tres.test_request_id = tr.id AND tres.is_current
                  AND tres.released_at::date BETWEEN $1::date AND $2::date
              ))::int AS completed
       FROM test_requests tr
       JOIN laboratories l ON l.id = tr.laboratory_id
       JOIN branches b ON b.id = tr.branch_id
       WHERE ($3::uuid IS NULL OR tr.branch_id = $3::uuid) AND ($4::uuid IS NULL OR l.country_id = $4::uuid)
       GROUP BY l.id, l.name
       HAVING count(DISTINCT tr.id) FILTER (WHERE tr.status NOT IN ('released','rejected','cancelled')) > 0
           OR count(DISTINCT tr.id) FILTER (WHERE tr.status = 'released' AND EXISTS (
                SELECT 1 FROM test_results tres WHERE tres.test_request_id = tr.id AND tres.is_current
                  AND tres.released_at::date BETWEEN $1::date AND $2::date
              )) > 0
       ORDER BY active DESC, completed DESC`,
      [p.from, p.to, p.branchId, p.countryId],
    );
    return rows.map((r) => ({ laboratoryId: String(r.laboratoryId), name: String(r.name), active: n(r.active), completed: n(r.completed) }));
  }

  /** A reviewer's own pending changes-requested items, and decisions they made in the period. */
  private async reviewerWorkload(tx: Tx, p: Period): Promise<WorkloadRow[]> {
    const rows = await tx.many<Record<string, unknown>>(
      `SELECT u.id AS "userId", u.full_name AS name, b.code AS "branchCode",
              count(*) FILTER (WHERE rv.status = 'changes_requested')::int AS active,
              count(*) FILTER (WHERE rv.reviewed_at::date BETWEEN $1::date AND $2::date)::int AS completed
       FROM report_versions rv
       JOIN users u ON u.id = rv.reviewed_by
       JOIN branches b ON b.id = rv.branch_id
       WHERE ($3::uuid IS NULL OR rv.branch_id = $3::uuid) AND ($4::uuid IS NULL OR b.country_id = $4::uuid)
       GROUP BY u.id, u.full_name, b.code
       HAVING count(*) FILTER (WHERE rv.status = 'changes_requested') > 0
           OR count(*) FILTER (WHERE rv.reviewed_at::date BETWEEN $1::date AND $2::date) > 0
       ORDER BY active DESC, completed DESC
       LIMIT 100`,
      [p.from, p.to, p.branchId, p.countryId],
    );
    return rows.map((r) => ({
      userId: String(r.userId), name: String(r.name), branchCode: String(r.branchCode),
      active: n(r.active), completed: n(r.completed),
    }));
  }
}

interface Period {
  from: string;
  to: string;
  branchId: string | null;
  countryId: string | null;
}

function period(from: string | undefined, to: string | undefined, branchId?: string, countryId?: string): Period {
  return {
    from: from ?? defaultFrom(),
    to: to ?? new Date().toISOString().slice(0, 10),
    branchId: branchId ?? null,
    countryId: countryId ?? null,
  };
}

function defaultFrom(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 11);
  return d.toISOString().slice(0, 10);
}

function withShare<T extends { count: number }>(rows: T[]): (T & { share: number })[] {
  const total = rows.reduce((s, r) => s + r.count, 0);
  return rows.map((r) => ({ ...r, share: total > 0 ? round2((r.count / total) * 100) : 0 }));
}

function isNum(v: number | null): v is number {
  return v !== null && Number.isFinite(v);
}

/** Linear-interpolation percentile over an already-sorted array. */
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  if (sorted.length === 1) return round2(sorted[0]);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return round2(sorted[lo]);
  const frac = idx - lo;
  return round2(sorted[lo] + (sorted[hi] - sorted[lo]) * frac);
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
