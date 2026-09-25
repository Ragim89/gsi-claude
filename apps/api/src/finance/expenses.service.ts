import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser, Expense, ExpenseCategory, ExpenseSummary } from '@gsi/shared-types';
import { DbService } from '../db/db.service';
import { LedgerService } from './ledger.service';
import { AuditService } from '../common/audit.service';
import { round2, today } from './invoices.service';
import { config } from '../config';

const EXPENSE_COLUMNS = `
  e.id, e.branch_id AS "branchId", b.code AS "branchCode", e.category, e.description, e.supplier,
  e.currency, e.amount::float8 AS amount, to_char(e.expense_date, 'YYYY-MM-DD') AS "expenseDate",
  e.job_id AS "jobId", j.job_number AS "jobNumber", e.payment_status AS "paymentStatus",
  CASE WHEN e.payment_status = 'paid' THEN e.amount
       ELSE COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa WHERE pa.expense_id = e.id), 0)
  END::float8 AS "amountPaid",
  e.created_at AS "createdAt"`;

const EXPENSE_FROM = `
  expenses e
  JOIN branches b ON b.id = e.branch_id
  LEFT JOIN inspection_jobs j ON j.id = e.job_id`;

export interface CreateExpenseInput {
  category: ExpenseCategory;
  description: string;
  amount: number;
  supplier?: string | null;
  expenseDate?: string;
  jobId?: string | null;
  branchId?: string;
  currency?: string;
  /**
   * When true, the expense is booked as a payable (`expense` debit / `ap.trade` credit)
   * instead of paid immediately. Defaults to false — the original, unchanged behavior:
   * "expenses are recorded as paid immediately" (see below).
   */
  onAccount?: boolean;
}

/** Branch costs (docs/01-architecture.md, module 6). Booking an expense posts to the ledger. */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  list(user: AuthUser, f: { category?: ExpenseCategory; from?: string; to?: string; branchId?: string }) {
    return this.db.tx(user, (tx) =>
      tx.many<Expense>(
        `SELECT ${EXPENSE_COLUMNS} FROM ${EXPENSE_FROM}
         WHERE ($1::expense_category IS NULL OR e.category = $1::expense_category)
           AND ($2::date IS NULL OR e.expense_date >= $2::date)
           AND ($3::date IS NULL OR e.expense_date <= $3::date)
           AND ($4::uuid IS NULL OR e.branch_id = $4::uuid)
           AND e.deleted_at IS NULL
         ORDER BY e.expense_date DESC, e.created_at DESC
         LIMIT 500`,
        [f.category ?? null, f.from ?? null, f.to ?? null, f.branchId ?? null],
      ),
    );
  }

  /**
   * Analytics for the expenses page: totals, monthly trend, mix by category / branch / supplier
   * and the cost ratio against revenue of the same period. Everything is converted to the
   * consolidation currency at the rate of the expense date, and scoped by RLS + the branch filter.
   */
  summary(user: AuthUser, f: { from?: string; to?: string; branchId?: string }): Promise<ExpenseSummary> {
    const base = config.consolidationCurrency;
    const from = f.from ?? defaultFrom();
    const to = f.to ?? today();
    const branchId = f.branchId ?? null;
    const params = [from, to, base, branchId];

    return this.db.tx(user, async (tx) => {
      const [totals, monthly, byCategory, byBranch, bySupplier, largest, revenue] = await Promise.all([
        tx.one<{ amount: number; cnt: number }>(
          `SELECT COALESCE(SUM(e.amount * fx_rate_on(e.currency, $3, e.expense_date)), 0)::float8 AS amount,
                  count(*)::int AS cnt
           FROM expenses e
           WHERE e.expense_date BETWEEN $1::date AND $2::date AND ($4::uuid IS NULL OR e.branch_id = $4::uuid)
             AND e.deleted_at IS NULL`,
          params,
        ),
        tx.many<{ month: string; amount: number }>(
          `WITH months AS (
             SELECT date_trunc('month', m)::date AS m_start
             FROM generate_series(date_trunc('month', $1::date), date_trunc('month', $2::date), interval '1 month') m
           )
           SELECT to_char(months.m_start, 'YYYY-MM') AS month,
                  COALESCE(SUM(e.amount * fx_rate_on(e.currency, $3, e.expense_date)), 0)::float8 AS amount
           FROM months
           LEFT JOIN expenses e ON date_trunc('month', e.expense_date)::date = months.m_start
                               AND ($4::uuid IS NULL OR e.branch_id = $4::uuid)
                               AND e.deleted_at IS NULL
           GROUP BY months.m_start ORDER BY months.m_start`,
          params,
        ),
        tx.many<{ key: string; amount: number; cnt: number }>(
          `SELECT e.category::text AS key,
                  SUM(e.amount * fx_rate_on(e.currency, $3, e.expense_date))::float8 AS amount,
                  count(*)::int AS cnt
           FROM expenses e
           WHERE e.expense_date BETWEEN $1::date AND $2::date AND ($4::uuid IS NULL OR e.branch_id = $4::uuid)
             AND e.deleted_at IS NULL
           GROUP BY 1 ORDER BY amount DESC`,
          params,
        ),
        tx.many<{ branch_id: string; code: string; country: string; currency: string; amount: number }>(
          `SELECT b.id AS branch_id, b.code, b.country, b.currency,
                  SUM(e.amount * fx_rate_on(e.currency, $3, e.expense_date))::float8 AS amount
           FROM expenses e JOIN branches b ON b.id = e.branch_id
           WHERE e.expense_date BETWEEN $1::date AND $2::date AND ($4::uuid IS NULL OR e.branch_id = $4::uuid)
             AND e.deleted_at IS NULL
           GROUP BY b.id, b.code, b.country, b.currency ORDER BY amount DESC`,
          params,
        ),
        tx.many<{ key: string; amount: number }>(
          `SELECT COALESCE(NULLIF(e.supplier, ''), '—') AS key,
                  SUM(e.amount * fx_rate_on(e.currency, $3, e.expense_date))::float8 AS amount
           FROM expenses e
           WHERE e.expense_date BETWEEN $1::date AND $2::date AND ($4::uuid IS NULL OR e.branch_id = $4::uuid)
             AND e.deleted_at IS NULL
           GROUP BY 1 ORDER BY amount DESC LIMIT 8`,
          params,
        ),
        tx.one<{ id: string; description: string; category: ExpenseCategory; amount: number; date: string }>(
          `SELECT e.id, e.description, e.category,
                  (e.amount * fx_rate_on(e.currency, $3, e.expense_date))::float8 AS amount,
                  to_char(e.expense_date, 'YYYY-MM-DD') AS date
           FROM expenses e
           WHERE e.expense_date BETWEEN $1::date AND $2::date AND ($4::uuid IS NULL OR e.branch_id = $4::uuid)
             AND e.deleted_at IS NULL
           ORDER BY amount DESC LIMIT 1`,
          params,
        ),
        // Revenue of the same period, from the incremental aggregate (credit side is negative).
        tx.one<{ amount: number }>(
          `SELECT COALESCE(-SUM(a.amount_base), 0)::float8 AS amount
           FROM finance_daily_agg a
           WHERE a.account_group = 'revenue' AND a.entry_date BETWEEN $1::date AND $2::date
             AND ($3::uuid IS NULL OR a.branch_id = $3::uuid)`,
          [from, to, branchId],
        ),
      ]);

      const total = num(totals?.amount);
      const count = num(totals?.cnt);
      const months = Math.max(1, monthly.length);
      const revenueBase = round2(num(revenue?.amount));
      const share = (v: number) => (total > 0 ? round2((v / total) * 100) : 0);

      return {
        baseCurrency: base,
        period: { from, to },
        totals: {
          amountBase: round2(total),
          count,
          avgPerMonthBase: round2(total / months),
          avgPerExpenseBase: count > 0 ? round2(total / count) : 0,
          costRatioPct: revenueBase > 0 ? round2((total / revenueBase) * 100) : null,
          revenueBase,
        },
        monthly: monthly.map((m) => ({ month: m.month, amountBase: round2(num(m.amount)) })),
        byCategory: byCategory.map((c) => ({
          key: c.key,
          amountBase: round2(num(c.amount)),
          share: share(num(c.amount)),
          count: num(c.cnt),
        })),
        byBranch: byBranch.map((b) => ({
          key: b.code,
          branchId: b.branch_id,
          code: b.code,
          country: b.country,
          currency: b.currency,
          amountBase: round2(num(b.amount)),
          share: share(num(b.amount)),
        })),
        bySupplier: bySupplier.map((s) => ({
          key: s.key,
          amountBase: round2(num(s.amount)),
          share: share(num(s.amount)),
        })),
        largest: largest
          ? {
              id: largest.id,
              description: largest.description,
              category: largest.category,
              amountBase: round2(num(largest.amount)),
              date: largest.date,
            }
          : null,
      };
    });
  }

  create(user: AuthUser, input: CreateExpenseInput) {
    const branchId = user.scope === 'global' && input.branchId ? input.branchId : user.branchId;
    const date = input.expenseDate ?? today();
    return this.db.tx(user, async (tx) => {
      const branch = await tx.one<{ currency: string }>('SELECT currency FROM branches WHERE id = $1', [branchId]);
      if (!branch) throw new NotFoundException('Branch not found');
      const currency = input.currency ?? branch.currency;

      const onAccount = input.onAccount ?? false;
      const row = await tx.one<{ id: string }>(
        `INSERT INTO expenses (branch_id, category, description, supplier, currency, amount, expense_date, job_id,
                               payment_status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9::expense_payment_status, $10) RETURNING id`,
        [branchId, input.category, input.description.trim(), input.supplier ?? null, currency, input.amount,
         date, input.jobId ?? null, onAccount ? 'unpaid' : 'paid', user.id],
      );
      // Default: expenses are recorded as paid immediately (cash accounting), same as always.
      // `onAccount: true` books it as a payable instead; PaymentsService.allocate() pays it off.
      await this.ledger.post(tx, user, {
        branchId,
        currency,
        date,
        sourceType: 'expense',
        sourceId: row!.id,
        description: input.description.trim(),
        legs: onAccount
          ? [
              { account: `expense.${input.category}`, group: 'expense', debit: input.amount },
              { account: 'ap.trade', group: 'payable', credit: input.amount },
            ]
          : [
              { account: `expense.${input.category}`, group: 'expense', debit: input.amount },
              { account: 'cash.bank', group: 'cash', credit: input.amount },
            ],
      });
      return (await tx.one<Expense>(`SELECT ${EXPENSE_COLUMNS} FROM ${EXPENSE_FROM} WHERE e.id = $1`, [row!.id]))!;
    });
  }

  remove(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const row = await tx.one<{ description: string; branch_id: string; amount: string; currency: string }>(
        'SELECT description, branch_id, amount, currency FROM expenses WHERE id = $1 AND deleted_at IS NULL',
        [id],
      );
      if (!row) throw new NotFoundException('Expense not found');
      // Keep the ledger immutable: reverse rather than delete the postings.
      await this.ledger.reverse(tx, user, 'expense', id, today());
      await tx.exec('UPDATE expenses SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [id, user.id]);
      await this.audit.record(tx, user, {
        action: 'expense.delete',
        entityType: 'expense',
        entityId: id,
        entityLabel: row.description,
        branchId: row.branch_id,
        before: { amount: Number(row.amount), currency: row.currency },
      });
    }, { includeArchived: true });
  }
}

function num(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}

/** Default analytics window: the last 12 calendar months. */
function defaultFrom(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 11);
  return d.toISOString().slice(0, 10);
}
