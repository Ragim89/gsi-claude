import { Injectable } from '@nestjs/common';
import { AuthUser, JobFinanceLine, JobFinanceSummary } from '@gsi/shared-types';
import { DbService } from '../db/db.service';
import { round2 } from './invoices.service';
import { config } from '../config';

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * Revenue, cost and margin for one job (PHASE 8).
 *
 * Deliberately reads `invoices`/`expenses` already linked by `job_id` — there is no separate
 * cost ledger, per the instruction not to duplicate what `expenses` already records. Each
 * line is converted to the consolidation currency at its own document date's rate
 * (`fx_rate_on`), the same snapshot convention already used by the rest of this module —
 * "multi-currency margin" means exactly what it already means for the dashboard.
 */
@Injectable()
export class JobFinanceService {
  constructor(private readonly db: DbService) {}

  async summary(user: AuthUser, jobId: string): Promise<JobFinanceSummary> {
    const base = config.consolidationCurrency;
    return this.db.tx(user, async (tx) => {
      const [revenueRows, costRows] = await Promise.all([
        tx.many<Record<string, unknown>>(
          `SELECT i.id, to_char(i.issue_date, 'YYYY-MM-DD') AS date, i.invoice_number AS description,
                  i.currency, i.amount_net::float8 AS amount,
                  (i.amount_net * fx_rate_on(i.currency, $2, i.issue_date))::float8 AS "amountBase"
           FROM invoices i
           WHERE i.job_id = $1 AND i.deleted_at IS NULL AND i.status NOT IN ('draft', 'cancelled')
           ORDER BY i.issue_date`,
          [jobId, base],
        ),
        tx.many<Record<string, unknown>>(
          `SELECT e.id, to_char(e.expense_date, 'YYYY-MM-DD') AS date, e.description,
                  e.currency, e.amount::float8 AS amount,
                  (e.amount * fx_rate_on(e.currency, $2, e.expense_date))::float8 AS "amountBase"
           FROM expenses e
           WHERE e.job_id = $1 AND e.deleted_at IS NULL
           ORDER BY e.expense_date`,
          [jobId, base],
        ),
      ]);

      const revenueLines: JobFinanceLine[] = revenueRows.map((r) => ({
        id: String(r.id), kind: 'invoice', date: String(r.date), description: String(r.description),
        currency: String(r.currency), amount: round2(n(r.amount)), amountBase: round2(n(r.amountBase)),
      }));
      const costLines: JobFinanceLine[] = costRows.map((r) => ({
        id: String(r.id), kind: 'expense', date: String(r.date), description: String(r.description),
        currency: String(r.currency), amount: round2(n(r.amount)), amountBase: round2(n(r.amountBase)),
      }));

      const revenueBase = round2(revenueLines.reduce((s, l) => s + l.amountBase, 0));
      const costsBase = round2(costLines.reduce((s, l) => s + l.amountBase, 0));
      const marginBase = round2(revenueBase - costsBase);

      return {
        jobId,
        baseCurrency: base,
        revenueBase,
        costsBase,
        marginBase,
        marginPct: revenueBase > 0 ? round2((marginBase / revenueBase) * 100) : null,
        revenueLines,
        costLines,
      };
    });
  }
}
