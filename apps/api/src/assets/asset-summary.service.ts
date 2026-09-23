import { Injectable } from '@nestjs/common';
import { AssetSummary, AuthUser } from '@gsi/shared-types';
import { DbService } from '../db/db.service';
import { config } from '../config';

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/** Analytics for the assets page: what the group owns, what it is worth, what it costs monthly. */
@Injectable()
export class AssetSummaryService {
  constructor(private readonly db: DbService) {}

  build(user: AuthUser, f: { from?: string; to?: string; branchId?: string }): Promise<AssetSummary> {
    const base = config.consolidationCurrency;
    const from = f.from ?? defaultFrom();
    const to = f.to ?? new Date().toISOString().slice(0, 10);
    const branchId = f.branchId ?? null;

    return this.db.tx(user, async (tx) => {
      const [totals, periodDepr, byCategory, byBranch, monthly, endingSoon] = await Promise.all([
        tx.one<Record<string, unknown>>(
          `SELECT count(*)::int AS count,
                  count(*) FILTER (WHERE status = 'in_use')::int AS in_use,
                  count(*) FILTER (WHERE status IN ('disposed', 'written_off'))::int AS disposed,
                  count(*) FILTER (WHERE acquisition_cost - accumulated <= salvage_value + 0.01
                                     AND status NOT IN ('disposed', 'written_off'))::int AS fully,
                  COALESCE(SUM(acquisition_cost * fx_rate_on(currency, $1, acquisition_date)), 0)::float8 AS cost,
                  COALESCE(SUM(accumulated * fx_rate_on(currency, $1, current_date)), 0)::float8 AS accumulated,
                  COALESCE(SUM((acquisition_cost - accumulated) * fx_rate_on(currency, $1, current_date))
                           FILTER (WHERE status NOT IN ('disposed', 'written_off')), 0)::float8 AS nbv,
                  COALESCE(SUM(CASE WHEN method = 'straight_line' AND useful_life_months > 0
                                     AND status NOT IN ('disposed', 'written_off')
                                     AND acquisition_cost - accumulated > salvage_value + 0.01
                                    THEN (acquisition_cost - salvage_value) / useful_life_months
                                          * fx_rate_on(currency, $1, current_date) END), 0)::float8 AS monthly
           FROM assets WHERE deleted_at IS NULL AND ($2::uuid IS NULL OR branch_id = $2::uuid)`,
          [base, branchId],
        ),
        tx.one<{ amount: number }>(
          `SELECT COALESCE(SUM(amount_base), 0)::float8 AS amount FROM asset_depreciation
           WHERE period BETWEEN date_trunc('month', $1::date) AND $2::date
             AND ($3::uuid IS NULL OR branch_id = $3::uuid)`,
          [from, to, branchId],
        ),
        tx.many<{ key: string; amount: number; nbv: number; cnt: number }>(
          `SELECT category::text AS key,
                  SUM(acquisition_cost * fx_rate_on(currency, $1, acquisition_date))::float8 AS amount,
                  SUM((acquisition_cost - accumulated) * fx_rate_on(currency, $1, current_date))::float8 AS nbv,
                  count(*)::int AS cnt
           FROM assets
           WHERE deleted_at IS NULL AND status NOT IN ('disposed', 'written_off')
             AND ($2::uuid IS NULL OR branch_id = $2::uuid)
           GROUP BY 1 ORDER BY amount DESC`,
          [base, branchId],
        ),
        tx.many<{ branch_id: string; code: string; country: string; amount: number; cnt: number }>(
          `SELECT b.id AS branch_id, b.code, b.country,
                  SUM((a.acquisition_cost - a.accumulated) * fx_rate_on(a.currency, $1, current_date))::float8 AS amount,
                  count(*)::int AS cnt
           FROM assets a JOIN branches b ON b.id = a.branch_id
           WHERE a.deleted_at IS NULL AND a.status NOT IN ('disposed', 'written_off')
             AND ($2::uuid IS NULL OR a.branch_id = $2::uuid)
           GROUP BY b.id, b.code, b.country ORDER BY amount DESC`,
          [base, branchId],
        ),
        tx.many<{ month: string; depreciation: number; nbv: number }>(
          `WITH months AS (
             SELECT date_trunc('month', m)::date AS m_start
             FROM generate_series(date_trunc('month', $1::date), date_trunc('month', $2::date), interval '1 month') m
           )
           SELECT to_char(months.m_start, 'YYYY-MM') AS month,
                  COALESCE((SELECT SUM(d.amount_base) FROM asset_depreciation d
                            WHERE d.period = months.m_start
                              AND ($3::uuid IS NULL OR d.branch_id = $3::uuid)), 0)::float8 AS depreciation,
                  COALESCE((SELECT SUM(a.acquisition_cost * fx_rate_on(a.currency, $4, a.acquisition_date))
                            FROM assets a
                            WHERE a.deleted_at IS NULL AND a.acquisition_date <= (months.m_start + interval '1 month' - interval '1 day')::date
                              AND (a.disposed_on IS NULL OR a.disposed_on > months.m_start)
                              AND ($3::uuid IS NULL OR a.branch_id = $3::uuid)), 0)::float8
                  - COALESCE((SELECT SUM(d.amount_base) FROM asset_depreciation d
                              JOIN assets a2 ON a2.id = d.asset_id
                              WHERE d.period <= months.m_start
                                AND (a2.disposed_on IS NULL OR a2.disposed_on > months.m_start)
                                AND ($3::uuid IS NULL OR d.branch_id = $3::uuid)), 0)::float8 AS nbv
           FROM months ORDER BY months.m_start`,
          [from, to, branchId, base],
        ),
        tx.many<{ id: string; inventory_no: string; name: string; remaining: number; nbv: number }>(
          `SELECT id, inventory_no, name,
                  GREATEST(0, useful_life_months
                    - floor(accumulated / NULLIF((acquisition_cost - salvage_value) / useful_life_months, 0)))::int AS remaining,
                  ((acquisition_cost - accumulated) * fx_rate_on(currency, $1, current_date))::float8 AS nbv
           FROM assets
           WHERE deleted_at IS NULL AND method = 'straight_line' AND useful_life_months > 0
             AND status NOT IN ('disposed', 'written_off')
             AND acquisition_cost - accumulated > salvage_value + 0.01
             AND ($2::uuid IS NULL OR branch_id = $2::uuid)
             AND GREATEST(0, useful_life_months
                   - floor(accumulated / NULLIF((acquisition_cost - salvage_value) / useful_life_months, 0))) <= 6
           ORDER BY remaining, nbv DESC LIMIT 8`,
          [base, branchId],
        ),
      ]);

      const costTotal = byCategory.reduce((s, c) => s + n(c.amount), 0);
      const nbvTotal = byBranch.reduce((s, b) => s + n(b.amount), 0);

      return {
        baseCurrency: base,
        totals: {
          count: n(totals?.count),
          inUse: n(totals?.in_use),
          disposed: n(totals?.disposed),
          fullyDepreciated: n(totals?.fully),
          acquisitionCostBase: round2(n(totals?.cost)),
          accumulatedBase: round2(n(totals?.accumulated)),
          netBookValueBase: round2(n(totals?.nbv)),
          monthlyDepreciationBase: round2(n(totals?.monthly)),
          periodDepreciationBase: round2(n(periodDepr?.amount)),
        },
        byCategory: byCategory.map((c) => ({
          key: c.key,
          amountBase: round2(n(c.amount)),
          netBookValueBase: round2(n(c.nbv)),
          count: n(c.cnt),
          share: costTotal > 0 ? round2((n(c.amount) / costTotal) * 100) : 0,
        })),
        byBranch: byBranch.map((b) => ({
          key: b.code,
          branchId: b.branch_id,
          code: b.code,
          country: b.country,
          count: n(b.cnt),
          amountBase: round2(n(b.amount)),
          share: nbvTotal > 0 ? round2((n(b.amount) / nbvTotal) * 100) : 0,
        })),
        monthly: monthly.map((m) => ({
          month: m.month,
          depreciationBase: round2(n(m.depreciation)),
          netBookValueBase: round2(Math.max(0, n(m.nbv))),
        })),
        endingSoon: endingSoon.map((a) => ({
          id: a.id,
          inventoryNo: a.inventory_no,
          name: a.name,
          remainingMonths: n(a.remaining),
          netBookValueBase: round2(n(a.nbv)),
        })),
      };
    });
  }
}

/** Default window: the last 12 calendar months. */
function defaultFrom(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 11);
  return d.toISOString().slice(0, 10);
}
