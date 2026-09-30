import { Injectable } from '@nestjs/common';
import {
  ArAgingBucket,
  AuthUser,
  BranchFinanceRow,
  BreakdownSlice,
  CashFlowPoint,
  FinanceDashboard,
  MonthlyPoint,
  OperationalKpis,
} from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { config } from '../config';

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * Real-time group dashboard (docs/03-finance-dashboard.md).
 *
 * Reads the incrementally maintained `finance_daily_agg` rather than rescanning the ledger,
 * so a refresh costs a handful of indexed aggregates even with years of postings.
 * Row-Level Security does the scoping: a branch finance controller gets their own branch,
 * CFO/admin get the whole group — the SQL below is identical for both.
 *
 * Sign convention in the ledger: amount_base is (debit − credit), so revenue is negative
 * and expenses are positive; they are flipped here for presentation.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly db: DbService) {}

  /**
   * `branchId` narrows an HQ view to a single legal entity ("каждую точку отдельно").
   * For branch users it changes nothing — RLS already limits them to their own branch.
   *
   * Currency: with no branch filter this is the group view, expressed in the consolidation
   * currency exactly as before (every leg converted at its own posting date's rate — the
   * existing, real FX mechanism, never a blanket live re-conversion). With a single branch
   * selected there is nothing to consolidate, so every figure is expressed in that branch's
   * own currency instead — its `amount_local` where the source is the pre-aggregated
   * `finance_daily_agg` (exact, no conversion at all, since a branch posts in its own
   * currency), or a fresh `fx_rate_on(..., branchCurrency, ...)` where the source is read live
   * (invoices/expenses/assets, which may carry an explicit foreign-currency override).
   */
  async build(user: AuthUser, from?: string, to?: string, branchId?: string): Promise<FinanceDashboard> {
    const period = {
      from: from ?? defaultFrom(),
      to: to ?? new Date().toISOString().slice(0, 10),
      branchId: branchId ?? null,
    };

    return this.db.tx(user, async (tx) => {
      const base = await this.resolveDisplayCurrency(tx, period.branchId);
      const single = period.branchId !== null;

      const [branches, monthly, cashFlow, revenueByService, revenueByClient, expensesByCategory, aging, kpis, overdue,
             payable, unallocated, quotePipeline] =
        await Promise.all([
          this.branches(tx, period, base),
          this.monthly(tx, period, base),
          this.cashFlow(tx, period, base),
          this.revenueByService(tx, period, base),
          this.revenueByClient(tx, period, base),
          this.expensesByCategory(tx, period, base),
          this.arAging(tx, base, period.branchId),
          this.kpis(tx, period),
          this.overdueTotal(tx, base, period.branchId),
          this.payableTotal(tx, base, period.branchId, single),
          this.unallocatedCash(tx, base, period.branchId),
          this.quotePipeline(tx, base, period.branchId),
        ]);

      // Net book value of the fixed assets, so "capitalisation" is not just liquid assets.
      // Live fx_rate_on against the resolved display currency — the real mechanism, not a
      // symbol swap; returns null (excluded from the sum) rather than a fabricated rate when
      // no pair is on file, exactly like every other live conversion in this file.
      const assets = await tx.one<{ nbv: number }>(
        `SELECT COALESCE(SUM((acquisition_cost - accumulated) * fx_rate_on(currency, $1, current_date)), 0)::float8 AS nbv
         FROM assets WHERE status NOT IN ('disposed', 'written_off')
           AND ($2::uuid IS NULL OR branch_id = $2::uuid)`,
        [base, period.branchId],
      );
      const assetsBase = round2(n(assets?.nbv));

      const revenueBase = sum(branches, single ? 'revenueLocal' : 'revenueBase');
      const expenseBase = sum(branches, single ? 'expenseLocal' : 'expenseBase');
      const cashBase = sum(branches, single ? 'cashLocal' : 'cashBase');
      const receivableBase = sum(branches, single ? 'receivableLocal' : 'receivableBase');
      const profitBase = round2(revenueBase - expenseBase);

      return {
        baseCurrency: base,
        period: { from: period.from, to: period.to },
        totals: {
          // "Капитализация группы" = cash + receivables + net book value of fixed assets.
          // ASSUMPTION: this is net asset value, not equity or a company valuation; liabilities
          // arrive with the accounting integration and the label must be confirmed with the CFO.
          capitalizationBase: round2(cashBase + receivableBase + assetsBase),
          assetsBase,
          revenueBase,
          expenseBase,
          profitBase,
          marginPct: revenueBase > 0 ? round2((profitBase / revenueBase) * 100) : null,
          cashBase,
          receivableBase,
          overdueBase: overdue,
          payableBase: payable,
          unallocatedCashBase: unallocated,
        },
        branches,
        monthly,
        cashFlow,
        revenueByService,
        revenueByClient,
        expensesByCategory,
        arAging: aging,
        quotePipeline,
        kpis,
        generatedAt: new Date().toISOString(),
      };
    });
  }

  /** The consolidation currency for a group view, or the selected branch's own currency when
   *  there is exactly one branch in view — there is nothing to consolidate for a single branch,
   *  so its own books are the honest answer, not a currency it doesn't trade in. */
  private async resolveDisplayCurrency(tx: Tx, branchId: string | null): Promise<string> {
    if (!branchId) return config.consolidationCurrency;
    const row = await tx.one<{ currency: string }>('SELECT currency FROM branches WHERE id = $1', [branchId]);
    return row?.currency ?? config.consolidationCurrency;
  }

  private async branches(tx: Tx, p: Period, _base: string): Promise<BranchFinanceRow[]> {
    const rows = await tx.many<Record<string, unknown>>(
      `SELECT b.id AS "branchId", b.code AS "branchCode", b.country, b.city, b.currency,
              COALESCE(-SUM(a.amount_base) FILTER (WHERE a.account_group = 'revenue'
                       AND a.entry_date BETWEEN $1::date AND $2::date), 0)::float8 AS "revenueBase",
              COALESCE(SUM(a.amount_base) FILTER (WHERE a.account_group = 'expense'
                       AND a.entry_date BETWEEN $1::date AND $2::date), 0)::float8 AS "expenseBase",
              COALESCE(-SUM(a.amount_local) FILTER (WHERE a.account_group = 'revenue'
                       AND a.entry_date BETWEEN $1::date AND $2::date), 0)::float8 AS "revenueLocal",
              COALESCE(SUM(a.amount_local) FILTER (WHERE a.account_group = 'expense'
                       AND a.entry_date BETWEEN $1::date AND $2::date), 0)::float8 AS "expenseLocal",
              COALESCE(SUM(a.amount_base) FILTER (WHERE a.account_group = 'cash'), 0)::float8 AS "cashBase",
              COALESCE(SUM(a.amount_base) FILTER (WHERE a.account_group = 'receivable'), 0)::float8 AS "receivableBase",
              COALESCE(SUM(a.amount_local) FILTER (WHERE a.account_group = 'cash'), 0)::float8 AS "cashLocal",
              COALESCE(SUM(a.amount_local) FILTER (WHERE a.account_group = 'receivable'), 0)::float8 AS "receivableLocal",
              (SELECT count(*) FROM inspection_jobs j
                WHERE j.branch_id = b.id AND j.created_at::date BETWEEN $1::date AND $2::date)::int AS "jobCount"
       FROM branches b
       LEFT JOIN finance_daily_agg a ON a.branch_id = b.id
       WHERE ($3::uuid IS NULL OR b.id = $3::uuid)
       GROUP BY b.id, b.code, b.country, b.city, b.currency
       ORDER BY "revenueBase" DESC, b.code`,
      [p.from, p.to, p.branchId],
    );
    return rows.map((r) => ({
      branchId: String(r.branchId),
      branchCode: String(r.branchCode),
      country: String(r.country),
      city: String(r.city),
      currency: String(r.currency),
      revenueBase: round2(n(r.revenueBase)),
      expenseBase: round2(n(r.expenseBase)),
      profitBase: round2(n(r.revenueBase) - n(r.expenseBase)),
      cashBase: round2(n(r.cashBase)),
      receivableBase: round2(n(r.receivableBase)),
      expenseLocal: round2(n(r.expenseLocal)),
      cashLocal: round2(n(r.cashLocal)),
      receivableLocal: round2(n(r.receivableLocal)),
      netAssetsBase: round2(n(r.cashBase) + n(r.receivableBase)),
      revenueLocal: round2(n(r.revenueLocal)),
      jobCount: n(r.jobCount),
    }));
  }

  /** Local columns are only ever selected when `p.branchId` narrows to one branch — a branch
   *  posts in its own currency, so `amount_local` there needs no conversion at all. */
  private async monthly(tx: Tx, p: Period, _base: string): Promise<MonthlyPoint[]> {
    const single = p.branchId !== null;
    const rows = await tx.many<Record<string, unknown>>(
      `WITH months AS (
         SELECT date_trunc('month', m)::date AS m_start
         FROM generate_series(date_trunc('month', $1::date), date_trunc('month', $2::date), interval '1 month') m
       )
       SELECT to_char(months.m_start, 'YYYY-MM') AS month,
              COALESCE(-SUM(a.amount_base) FILTER (WHERE a.account_group = 'revenue'), 0)::float8 AS "revenueBase",
              COALESCE(SUM(a.amount_base) FILTER (WHERE a.account_group = 'expense'), 0)::float8 AS "expenseBase",
              COALESCE(-SUM(a.amount_local) FILTER (WHERE a.account_group = 'revenue'), 0)::float8 AS "revenueLocal",
              COALESCE(SUM(a.amount_local) FILTER (WHERE a.account_group = 'expense'), 0)::float8 AS "expenseLocal"
       FROM months
       LEFT JOIN finance_daily_agg a ON date_trunc('month', a.entry_date)::date = months.m_start
                                    AND ($3::uuid IS NULL OR a.branch_id = $3::uuid)
       GROUP BY months.m_start
       ORDER BY months.m_start`,
      [p.from, p.to, p.branchId],
    );
    return rows.map((r) => ({
      month: String(r.month),
      revenueBase: round2(n(single ? r.revenueLocal : r.revenueBase)),
      expenseBase: round2(n(single ? r.expenseLocal : r.expenseBase)),
      profitBase: round2(n(single ? r.revenueLocal : r.revenueBase) - n(single ? r.expenseLocal : r.expenseBase)),
    }));
  }

  /** Group view (unchanged): sums the pre-baked `amount_base` column exactly as before — same
   *  query, same behavior, zero regression risk for the case nobody reported as broken. Single
   *  branch: `ledger_entries` keeps each posting's own currency, so it is re-converted live to
   *  that branch's own currency instead of reading a column frozen to the consolidation one.
   *  Two separate queries, each with its own matching params — a shared array sized for the
   *  larger one previously mismatched the smaller query's placeholder count (pg: "bind message
   *  supplies N parameters, but prepared statement requires M"). */
  private async cashFlow(tx: Tx, p: Period, base: string): Promise<CashFlowPoint[]> {
    const rows = p.branchId
      ? await tx.many<Record<string, unknown>>(
          `WITH months AS (
             SELECT date_trunc('month', m)::date AS m_start
             FROM generate_series(date_trunc('month', $1::date), date_trunc('month', $2::date), interval '1 month') m
           )
           SELECT to_char(months.m_start, 'YYYY-MM') AS month,
                  COALESCE(SUM((l.debit - l.credit) * fx_rate_on(l.currency, $4, l.entry_date))
                           FILTER (WHERE l.debit > l.credit), 0)::float8 AS "inflowBase",
                  COALESCE(-SUM((l.debit - l.credit) * fx_rate_on(l.currency, $4, l.entry_date))
                           FILTER (WHERE l.debit < l.credit), 0)::float8 AS "outflowBase"
           FROM months
           LEFT JOIN ledger_entries l
                  ON date_trunc('month', l.entry_date)::date = months.m_start AND l.account_group = 'cash'
                 AND l.branch_id = $3::uuid
           GROUP BY months.m_start
           ORDER BY months.m_start`,
          [p.from, p.to, p.branchId, base],
        )
      : await tx.many<Record<string, unknown>>(
          `WITH months AS (
             SELECT date_trunc('month', m)::date AS m_start
             FROM generate_series(date_trunc('month', $1::date), date_trunc('month', $2::date), interval '1 month') m
           )
           SELECT to_char(months.m_start, 'YYYY-MM') AS month,
                  COALESCE(SUM(l.amount_base) FILTER (WHERE l.amount_base > 0), 0)::float8 AS "inflowBase",
                  COALESCE(-SUM(l.amount_base) FILTER (WHERE l.amount_base < 0), 0)::float8 AS "outflowBase"
           FROM months
           LEFT JOIN ledger_entries l
                  ON date_trunc('month', l.entry_date)::date = months.m_start AND l.account_group = 'cash'
           GROUP BY months.m_start
           ORDER BY months.m_start`,
          [p.from, p.to],
        );
    return rows.map((r) => ({
      month: String(r.month),
      inflowBase: round2(n(r.inflowBase)),
      outflowBase: round2(n(r.outflowBase)),
      netBase: round2(n(r.inflowBase) - n(r.outflowBase)),
    }));
  }

  private revenueByService(tx: Tx, p: Period, base: string) {
    return this.breakdown(
      tx,
      `SELECT COALESCE(j.type::text, 'unassigned') AS key,
              SUM(i.amount_net * fx_rate_on(i.currency, $3, i.issue_date))::float8 AS amount
       FROM invoices i LEFT JOIN inspection_jobs j ON j.id = i.job_id
       WHERE i.status IN ('issued', 'partially_paid', 'paid')
         AND i.issue_date BETWEEN $1::date AND $2::date
         AND ($4::uuid IS NULL OR i.branch_id = $4::uuid)
       GROUP BY 1 ORDER BY amount DESC`,
      [p.from, p.to, base, p.branchId],
    );
  }

  private revenueByClient(tx: Tx, p: Period, base: string) {
    return this.breakdown(
      tx,
      `SELECT c.name AS key, SUM(i.amount_net * fx_rate_on(i.currency, $3, i.issue_date))::float8 AS amount
       FROM invoices i JOIN clients c ON c.id = i.client_id
       WHERE i.status IN ('issued', 'partially_paid', 'paid')
         AND i.issue_date BETWEEN $1::date AND $2::date
         AND ($4::uuid IS NULL OR i.branch_id = $4::uuid)
       GROUP BY 1 ORDER BY amount DESC LIMIT 8`,
      [p.from, p.to, base, p.branchId],
    );
  }

  private expensesByCategory(tx: Tx, p: Period, base: string) {
    return this.breakdown(
      tx,
      `SELECT e.category::text AS key, SUM(e.amount * fx_rate_on(e.currency, $3, e.expense_date))::float8 AS amount
       FROM expenses e
       WHERE e.expense_date BETWEEN $1::date AND $2::date
         AND ($4::uuid IS NULL OR e.branch_id = $4::uuid)
       GROUP BY 1 ORDER BY amount DESC`,
      [p.from, p.to, base, p.branchId],
    );
  }

  private async breakdown(tx: Tx, sql: string, params: unknown[]): Promise<BreakdownSlice[]> {
    const rows = await tx.many<{ key: string; amount: number }>(sql, params);
    const total = rows.reduce((s, r) => s + n(r.amount), 0);
    return rows.map((r) => ({
      key: r.key,
      amountBase: round2(n(r.amount)),
      share: total > 0 ? round2((n(r.amount) / total) * 100) : 0,
    }));
  }

  private async arAging(tx: Tx, base: string, branchId: string | null): Promise<ArAgingBucket[]> {
    const rows = await tx.many<{ bucket: string; amount: number; cnt: number }>(
      `SELECT CASE
                WHEN current_date - COALESCE(due_date, issue_date) <= 30 THEN '0-30'
                WHEN current_date - COALESCE(due_date, issue_date) <= 60 THEN '31-60'
                WHEN current_date - COALESCE(due_date, issue_date) <= 90 THEN '61-90'
                ELSE '90+' END AS bucket,
              SUM((amount_total - amount_paid) * fx_rate_on(currency, $1, issue_date))::float8 AS amount,
              count(*)::int AS cnt
       FROM invoices
       WHERE status IN ('issued', 'partially_paid')
         AND ($2::uuid IS NULL OR branch_id = $2::uuid)
       GROUP BY 1`,
      [base, branchId],
    );
    const order: ArAgingBucket['bucket'][] = ['0-30', '31-60', '61-90', '90+'];
    return order.map((bucket) => {
      const row = rows.find((r) => r.bucket === bucket);
      return { bucket, amountBase: round2(n(row?.amount)), invoiceCount: n(row?.cnt) };
    });
  }

  private async overdueTotal(tx: Tx, base: string, branchId: string | null): Promise<number> {
    const row = await tx.one<{ amount: number }>(
      `SELECT COALESCE(SUM((amount_total - amount_paid) * fx_rate_on(currency, $1, issue_date)), 0)::float8 AS amount
       FROM invoices WHERE status IN ('issued', 'partially_paid') AND due_date < current_date
         AND ($2::uuid IS NULL OR branch_id = $2::uuid)`,
      [base, branchId],
    );
    return round2(n(row?.amount));
  }

  /** Money still owed to suppliers on on-account expenses (PHASE 8). `base` was accepted but
   *  never used — always returned the consolidation-currency figure even for a single branch;
   *  now sums `amount_local` (that branch's own currency, exact, no conversion) instead. */
  private async payableTotal(tx: Tx, _base: string, branchId: string | null, single = false): Promise<number> {
    const row = await tx.one<{ amount: number }>(
      `SELECT COALESCE(-SUM(${single ? 'a.amount_local' : 'a.amount_base'}), 0)::float8 AS amount
       FROM finance_daily_agg a
       WHERE a.account_group = 'payable' AND ($1::uuid IS NULL OR a.branch_id = $1::uuid)`,
      [branchId],
    );
    return round2(n(row?.amount));
  }

  /** Payments received but not yet applied to an invoice (PHASE 8). */
  private async unallocatedCash(tx: Tx, base: string, branchId: string | null): Promise<number> {
    const row = await tx.one<{ amount: number }>(
      `SELECT COALESCE(SUM((p.amount - COALESCE(alloc.sum, 0)) * fx_rate_on(p.currency, $1, p.payment_date)), 0)::float8 AS amount
       FROM payments p
       LEFT JOIN LATERAL (SELECT SUM(pa.amount) AS sum FROM payment_allocations pa WHERE pa.payment_id = p.id) alloc ON true
       WHERE p.direction = 'inbound' AND ($2::uuid IS NULL OR p.branch_id = $2::uuid)
         AND p.amount - COALESCE(alloc.sum, 0) > 0.01`,
      [base, branchId],
    );
    return round2(n(row?.amount));
  }

  /** Open quotes by status — the commercial pipeline (PHASE 8). */
  private async quotePipeline(tx: Tx, base: string, branchId: string | null) {
    const rows = await tx.many<{ status: string; cnt: number; amount: number }>(
      `SELECT q.status::text, count(*)::int AS cnt,
              SUM(q.amount_total * fx_rate_on(q.currency, $1, q.issue_date))::float8 AS amount
       FROM quotes q
       WHERE q.deleted_at IS NULL AND ($2::uuid IS NULL OR q.branch_id = $2::uuid)
       GROUP BY q.status`,
      [base, branchId],
    );
    return rows.map((r) => ({ status: r.status, count: n(r.cnt), amountBase: round2(n(r.amount)) }));
  }

  /** Operational KPIs shown next to the money (docs/03, §"Операционные KPI"). */
  private async kpis(tx: Tx, p: Period): Promise<OperationalKpis> {
    const row = await tx.one<Record<string, unknown>>(
      `SELECT
         (SELECT count(*) FROM inspection_jobs WHERE created_at::date BETWEEN $1::date AND $2::date
            AND ($3::uuid IS NULL OR branch_id = $3::uuid))::int AS jobs,
         (SELECT count(*) FROM inspection_jobs WHERE status = 'approved'
            AND approved_at::date BETWEEN $1::date AND $2::date
            AND ($3::uuid IS NULL OR branch_id = $3::uuid))::int AS approved,
         (SELECT count(*) FROM reports WHERE created_at::date BETWEEN $1::date AND $2::date
            AND ($3::uuid IS NULL OR branch_id = $3::uuid))::int AS reports,
         (SELECT count(*) FROM users WHERE role = 'inspector' AND is_active
            AND ($3::uuid IS NULL OR branch_id = $3::uuid))::int AS inspectors,
         (SELECT avg(EXTRACT(EPOCH FROM (r.created_at - j.created_at)) / 86400)
            FROM reports r JOIN inspection_jobs j ON j.id = r.job_id
           WHERE r.created_at::date BETWEEN $1::date AND $2::date
             AND ($3::uuid IS NULL OR r.branch_id = $3::uuid))::float8 AS avg_days`,
      [p.from, p.to, p.branchId],
    );
    const jobs = n(row?.jobs);
    const inspectors = n(row?.inspectors);
    return {
      jobsInPeriod: jobs,
      jobsApproved: n(row?.approved),
      reportsInPeriod: n(row?.reports),
      activeInspectors: inspectors,
      jobsPerInspector: inspectors > 0 ? round2(jobs / inspectors) : 0,
      avgJobToReportDays: row?.avg_days === null || row?.avg_days === undefined ? null : round2(n(row.avg_days)),
    };
  }
}

interface Period {
  from: string;
  to: string;
  /** null = whole group (or whatever RLS allows). */
  branchId: string | null;
}

function sum<T extends Record<K, number>, K extends keyof T>(rows: T[], key: K): number {
  return round2(rows.reduce((s, r) => s + r[key], 0));
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/** Default period: the last 12 calendar months. */
function defaultFrom(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 11);
  return d.toISOString().slice(0, 10);
}
