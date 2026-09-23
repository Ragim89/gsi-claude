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
   */
  async build(user: AuthUser, from?: string, to?: string, branchId?: string): Promise<FinanceDashboard> {
    const base = config.consolidationCurrency;
    const period = {
      from: from ?? defaultFrom(),
      to: to ?? new Date().toISOString().slice(0, 10),
      branchId: branchId ?? null,
    };

    return this.db.tx(user, async (tx) => {
      const [branches, monthly, cashFlow, revenueByService, revenueByClient, expensesByCategory, aging, kpis, overdue] =
        await Promise.all([
          this.branches(tx, period, base),
          this.monthly(tx, period),
          this.cashFlow(tx, period),
          this.revenueByService(tx, period, base),
          this.revenueByClient(tx, period, base),
          this.expensesByCategory(tx, period, base),
          this.arAging(tx, base, period.branchId),
          this.kpis(tx, period),
          this.overdueTotal(tx, base, period.branchId),
        ]);

      // Net book value of the fixed assets, so "capitalisation" is not just liquid assets.
      const assets = await tx.one<{ nbv: number }>(
        `SELECT COALESCE(SUM((acquisition_cost - accumulated) * fx_rate_on(currency, $1, current_date)), 0)::float8 AS nbv
         FROM assets WHERE status NOT IN ('disposed', 'written_off')
           AND ($2::uuid IS NULL OR branch_id = $2::uuid)`,
        [base, period.branchId],
      );
      const assetsBase = round2(n(assets?.nbv));

      const revenueBase = sum(branches, 'revenueBase');
      const expenseBase = sum(branches, 'expenseBase');
      const cashBase = sum(branches, 'cashBase');
      const receivableBase = sum(branches, 'receivableBase');
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
        },
        branches,
        monthly,
        cashFlow,
        revenueByService,
        revenueByClient,
        expensesByCategory,
        arAging: aging,
        kpis,
        generatedAt: new Date().toISOString(),
      };
    });
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
              COALESCE(SUM(a.amount_base) FILTER (WHERE a.account_group = 'cash'), 0)::float8 AS "cashBase",
              COALESCE(SUM(a.amount_base) FILTER (WHERE a.account_group = 'receivable'), 0)::float8 AS "receivableBase",
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
      netAssetsBase: round2(n(r.cashBase) + n(r.receivableBase)),
      revenueLocal: round2(n(r.revenueLocal)),
      jobCount: n(r.jobCount),
    }));
  }

  private async monthly(tx: Tx, p: Period): Promise<MonthlyPoint[]> {
    const rows = await tx.many<Record<string, unknown>>(
      `WITH months AS (
         SELECT date_trunc('month', m)::date AS m_start
         FROM generate_series(date_trunc('month', $1::date), date_trunc('month', $2::date), interval '1 month') m
       )
       SELECT to_char(months.m_start, 'YYYY-MM') AS month,
              COALESCE(-SUM(a.amount_base) FILTER (WHERE a.account_group = 'revenue'), 0)::float8 AS "revenueBase",
              COALESCE(SUM(a.amount_base) FILTER (WHERE a.account_group = 'expense'), 0)::float8 AS "expenseBase"
       FROM months
       LEFT JOIN finance_daily_agg a ON date_trunc('month', a.entry_date)::date = months.m_start
                                    AND ($3::uuid IS NULL OR a.branch_id = $3::uuid)
       GROUP BY months.m_start
       ORDER BY months.m_start`,
      [p.from, p.to, p.branchId],
    );
    return rows.map((r) => ({
      month: String(r.month),
      revenueBase: round2(n(r.revenueBase)),
      expenseBase: round2(n(r.expenseBase)),
      profitBase: round2(n(r.revenueBase) - n(r.expenseBase)),
    }));
  }

  private async cashFlow(tx: Tx, p: Period): Promise<CashFlowPoint[]> {
    const rows = await tx.many<Record<string, unknown>>(
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
             AND ($3::uuid IS NULL OR l.branch_id = $3::uuid)
       GROUP BY months.m_start
       ORDER BY months.m_start`,
      [p.from, p.to, p.branchId],
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
