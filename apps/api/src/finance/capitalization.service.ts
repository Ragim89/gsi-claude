import { Injectable } from '@nestjs/common';
import { AuthUser, CapitalizationBreakdownRow, CapitalizationLine, CapitalizationSnapshot } from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { config } from '../config';

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Cash + receivables + net fixed assets (after depreciation) − payables − other liabilities.
 *
 * Deliberately not a second ledger: every figure is read straight from the same tables the
 * group dashboard already aggregates — `finance_daily_agg` (fed by `ledger_entries` via
 * `trg_ledger_agg`, 002_finance.sql) for cash/receivable/payable, and `assets` (005_assets.sql,
 * which now also covers laboratory instruments through their `asset_id` link, 031) for net
 * book value. `DashboardService.build()` already computes a first-draft
 * `capitalizationBase = cash + receivable + assetsNBV` with a comment noting liabilities were
 * left out pending this screen — this service is that number's full breakdown, not a parallel
 * calculation of it.
 *
 * "Other liabilities" has no real ledger source yet (the only payable account posted anywhere
 * today is `ap.trade`, `expenses.service.ts`/`payments.service.ts`) — it is reported as zero
 * and `tracked: false` rather than invented, per the "no double counting, only real data"
 * rule. A future accrual/other-liability expense category would feed it.
 *
 * Multi-currency: every line is grouped by branch currency first (`byCurrency`) — the
 * consolidation-currency total (`amountBase`) uses the same `fx_rate_on`/
 * `config.consolidationCurrency` mechanism as the rest of finance, never a silent sum of
 * mismatched currencies.
 */
@Injectable()
export class CapitalizationService {
  private readonly groupCurrency = config.consolidationCurrency;

  constructor(private readonly db: DbService) {}

  /**
   * Currency: group view (no branch) is consolidated exactly as before. A single selected
   * branch has nothing to consolidate, so every line is expressed in that branch's own
   * currency instead of the group's — see DashboardService.build()'s docstring for the same
   * reasoning, reused here rather than re-derived.
   */
  build(user: AuthUser, branchId?: string, onDate?: string): Promise<CapitalizationSnapshot> {
    const asOf = onDate ?? new Date().toISOString().slice(0, 10);
    return this.db.tx(user, async (tx) => {
      const base = branchId
        ? (await tx.one<{ currency: string }>('SELECT currency FROM branches WHERE id = $1', [branchId]))?.currency ??
          this.groupCurrency
        : this.groupCurrency;
      const single = branchId != null;

      const [cash, receivable, payable, netAssets] = await Promise.all([
        this.ledgerGroup(tx, 'cash', branchId, 1, single),
        this.ledgerGroup(tx, 'receivable', branchId, 1, single),
        this.ledgerGroup(tx, 'payable', branchId, -1, single),
        this.netAssets(tx, branchId, base),
      ]);
      const otherLiabilities: CapitalizationLine = {
        key: 'otherLiabilities', amountBase: 0, byCurrency: [], tracked: false,
      };

      const netPositionBase = round2(
        cash.amountBase + receivable.amountBase + netAssets.amountBase
        - payable.amountBase - otherLiabilities.amountBase,
      );

      return {
        baseCurrency: base,
        asOf,
        cash: { ...cash, key: 'cash', tracked: true },
        receivable: { ...receivable, key: 'receivable', tracked: true },
        netAssets: { ...netAssets, key: 'netAssets', tracked: true },
        payable: { ...payable, key: 'payable', tracked: true },
        otherLiabilities,
        netPositionBase,
      };
    });
  }

  /** Cash/receivable/payable, from `finance_daily_agg`, grouped by branch currency. `sign`
   *  flips the debit-minus-credit convention (revenue/expense sign note, dashboard.service.ts)
   *  to a plain positive balance — matches DashboardService.payableTotal()'s own negation.
   *  `amount_base` is frozen to the consolidation currency at posting time (LedgerService.post),
   *  so a single branch reads `amount_local` instead (that branch's own currency — exact, no
   *  conversion needed since the query is already filtered to it) rather than that column. */
  private async ledgerGroup(
    tx: Tx, group: 'cash' | 'receivable' | 'payable', branchId: string | undefined, sign: 1 | -1, single: boolean,
  ): Promise<Omit<CapitalizationLine, 'key' | 'tracked'>> {
    const rows = await tx.many<{ currency: string; amount_local: number; amount_base: number }>(
      `SELECT b.currency, SUM(a.amount_local)::float8 AS amount_local, SUM(a.amount_base)::float8 AS amount_base
       FROM finance_daily_agg a JOIN branches b ON b.id = a.branch_id
       WHERE a.account_group = $1::account_group AND ($2::uuid IS NULL OR a.branch_id = $2::uuid)
       GROUP BY b.currency`,
      [group, branchId ?? null],
    );
    const byCurrency: CapitalizationBreakdownRow[] = rows
      .map((r) => ({ currency: r.currency, amount: round2(sign * n(r.amount_local)) }))
      .filter((r) => Math.abs(r.amount) > 0.005);
    const amountBase = round2(sign * rows.reduce((s, r) => s + n(single ? r.amount_local : r.amount_base), 0));
    return { amountBase, byCurrency };
  }

  /** Net book value of fixed assets — includes laboratory instruments automatically, since
   *  a financially-tracked instrument *is* an `assets` row (category lab_equipment, 031), read
   *  from this one table, never added twice. Live `fx_rate_on` against the resolved display
   *  currency — group view targets the consolidation currency (unchanged), a single branch
   *  targets its own; a row with no rate on file is excluded from the sum, never faked. */
  private async netAssets(
    tx: Tx, branchId: string | undefined, base: string,
  ): Promise<Omit<CapitalizationLine, 'key' | 'tracked'>> {
    const rows = await tx.many<{ currency: string; amount_local: number; amount_base: number }>(
      `SELECT a.currency,
              SUM(a.acquisition_cost - a.accumulated)::float8 AS amount_local,
              SUM((a.acquisition_cost - a.accumulated) * fx_rate_on(a.currency, $1, current_date))::float8 AS amount_base
       FROM assets a
       WHERE a.status NOT IN ('disposed', 'written_off') AND ($2::uuid IS NULL OR a.branch_id = $2::uuid)
       GROUP BY a.currency`,
      [base, branchId ?? null],
    );
    const byCurrency: CapitalizationBreakdownRow[] = rows
      .map((r) => ({ currency: r.currency, amount: round2(n(r.amount_local)) }))
      .filter((r) => Math.abs(r.amount) > 0.005);
    const amountBase = round2(rows.reduce((s, r) => s + n(r.amount_base), 0));
    return { amountBase, byCurrency };
  }
}
