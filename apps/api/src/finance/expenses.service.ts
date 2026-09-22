import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser, Expense, ExpenseCategory, HQ_ROLES } from '@gsi/shared-types';
import { DbService } from '../db/db.service';
import { LedgerService } from './ledger.service';
import { today } from './invoices.service';

const EXPENSE_COLUMNS = `
  e.id, e.branch_id AS "branchId", b.code AS "branchCode", e.category, e.description, e.supplier,
  e.currency, e.amount::float8 AS amount, to_char(e.expense_date, 'YYYY-MM-DD') AS "expenseDate",
  e.job_id AS "jobId", j.job_number AS "jobNumber", e.created_at AS "createdAt"`;

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
}

/** Branch costs (docs/01-architecture.md, module 6). Booking an expense posts to the ledger. */
@Injectable()
export class ExpensesService {
  constructor(private readonly db: DbService, private readonly ledger: LedgerService) {}

  list(user: AuthUser, f: { category?: ExpenseCategory; from?: string; to?: string; branchId?: string }) {
    return this.db.tx(user, (tx) =>
      tx.many<Expense>(
        `SELECT ${EXPENSE_COLUMNS} FROM ${EXPENSE_FROM}
         WHERE ($1::expense_category IS NULL OR e.category = $1::expense_category)
           AND ($2::date IS NULL OR e.expense_date >= $2::date)
           AND ($3::date IS NULL OR e.expense_date <= $3::date)
           AND ($4::uuid IS NULL OR e.branch_id = $4::uuid)
         ORDER BY e.expense_date DESC, e.created_at DESC
         LIMIT 500`,
        [f.category ?? null, f.from ?? null, f.to ?? null, f.branchId ?? null],
      ),
    );
  }

  create(user: AuthUser, input: CreateExpenseInput) {
    const branchId = HQ_ROLES.includes(user.role) && input.branchId ? input.branchId : user.branchId;
    const date = input.expenseDate ?? today();
    return this.db.tx(user, async (tx) => {
      const branch = await tx.one<{ currency: string }>('SELECT currency FROM branches WHERE id = $1', [branchId]);
      if (!branch) throw new NotFoundException('Branch not found');
      const currency = input.currency ?? branch.currency;

      const row = await tx.one<{ id: string }>(
        `INSERT INTO expenses (branch_id, category, description, supplier, currency, amount, expense_date, job_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9) RETURNING id`,
        [branchId, input.category, input.description.trim(), input.supplier ?? null, currency, input.amount,
         date, input.jobId ?? null, user.id],
      );
      // ASSUMPTION: expenses are recorded as paid immediately (cash accounting). Accounts
      // payable with a separate payment step arrives with the accounting integration.
      await this.ledger.post(tx, user, {
        branchId,
        currency,
        date,
        sourceType: 'expense',
        sourceId: row!.id,
        description: input.description.trim(),
        legs: [
          { account: `expense.${input.category}`, group: 'expense', debit: input.amount },
          { account: 'cash.bank', group: 'cash', credit: input.amount },
        ],
      });
      return (await tx.one<Expense>(`SELECT ${EXPENSE_COLUMNS} FROM ${EXPENSE_FROM} WHERE e.id = $1`, [row!.id]))!;
    });
  }

  remove(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const exists = await tx.one('SELECT 1 FROM expenses WHERE id = $1', [id]);
      if (!exists) throw new NotFoundException('Expense not found');
      // Keep the ledger immutable: reverse rather than delete the postings.
      await this.ledger.reverse(tx, user, 'expense', id, today());
      await tx.exec('DELETE FROM expenses WHERE id = $1', [id]);
    });
  }
}
