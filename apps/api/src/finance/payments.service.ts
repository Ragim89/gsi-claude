import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser, Payment, PaymentDirection, PaymentMethod } from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { LedgerService } from './ledger.service';
import { AuditService } from '../common/audit.service';
import { round2, today } from './invoices.service';

const PAYMENT_COLUMNS = `
  p.id, p.branch_id AS "branchId", b.code AS "branchCode", p.direction, p.client_id AS "clientId",
  c.name AS "clientName", p.supplier, p.method, p.reference, p.currency, p.amount::float8 AS amount,
  to_char(p.payment_date, 'YYYY-MM-DD') AS "paymentDate", p.notes, p.created_by AS "createdBy",
  u.full_name AS "createdByName", p.created_at AS "createdAt",
  COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa WHERE pa.payment_id = p.id), 0)::float8 AS "allocatedAmount"`;

const PAYMENT_FROM = `
  payments p
  JOIN branches b ON b.id = p.branch_id
  LEFT JOIN clients c ON c.id = p.client_id
  LEFT JOIN users u ON u.id = p.created_by`;

export interface AllocationInput {
  invoiceId?: string;
  expenseId?: string;
  amount: number;
}

export interface CreatePaymentInput {
  branchId: string;
  direction: PaymentDirection;
  clientId?: string | null;
  supplier?: string | null;
  method?: PaymentMethod;
  reference?: string | null;
  currency: string;
  amount: number;
  paymentDate?: string;
  notes?: string | null;
  /** Need not cover the whole amount: the remainder is left on account (inbound only). */
  allocations?: AllocationInput[];
}

/**
 * Payments as their own entity (PHASE 8).
 *
 * `InvoicesService.pay()` still exists and behaves exactly as it always did — it now calls
 * `create()` here with a single, full allocation, which reproduces its original ledger
 * posting (cash.bank / ar.trade, `source_type = 'payment'`) unchanged. What is new is
 * everything this file adds beyond that one case: splitting a payment across invoices,
 * leaving part of it unapplied (on account, or an overpayment), and the mirror of that for
 * an on-account expense (accounts payable).
 *
 * Money that arrives already earmarked for a specific invoice or expense posts straight to
 * `ar.trade` / `ap.trade` (the "direct" case — what `pay()` has always done). Money that
 * arrives with nothing to apply it to yet posts to a clearing account (`ar.unapplied`) and
 * moves out of it later, when `allocate()` is called. An outbound payment has no such
 * clearing step: this system does not yet record supplier prepayments with nothing to apply
 * them to, so an outbound payment must be fully allocated when it is created.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
  ) {}

  list(user: AuthUser, f: { direction?: PaymentDirection; clientId?: string; branchId?: string }) {
    return this.db.tx(user, (tx) =>
      tx.many<Payment>(
        `SELECT ${PAYMENT_COLUMNS} FROM ${PAYMENT_FROM}
         WHERE ($1::payment_direction IS NULL OR p.direction = $1::payment_direction)
           AND ($2::uuid IS NULL OR p.client_id = $2::uuid)
           AND ($3::uuid IS NULL OR p.branch_id = $3::uuid)
         ORDER BY p.payment_date DESC, p.created_at DESC
         LIMIT 500`,
        [f.direction ?? null, f.clientId ?? null, f.branchId ?? null],
      ),
    );
  }

  async get(user: AuthUser, id: string): Promise<Payment> {
    return this.db.tx(user, (tx) => this.load(tx, id));
  }

  private async load(tx: Tx, id: string): Promise<Payment> {
    const payment = await tx.one<Payment>(`SELECT ${PAYMENT_COLUMNS} FROM ${PAYMENT_FROM} WHERE p.id = $1`, [id]);
    if (!payment) throw new NotFoundException('Payment not found');
    payment.allocations = await tx.many(
      `SELECT pa.id, pa.payment_id AS "paymentId", pa.invoice_id AS "invoiceId", i.invoice_number AS "invoiceNumber",
              pa.expense_id AS "expenseId", e.description AS "expenseDescription",
              pa.amount::float8 AS amount, pa.created_at AS "createdAt"
       FROM payment_allocations pa
       LEFT JOIN invoices i ON i.id = pa.invoice_id
       LEFT JOIN expenses e ON e.id = pa.expense_id
       WHERE pa.payment_id = $1 ORDER BY pa.created_at`,
      [id],
    );
    payment.unallocatedAmount = round2(payment.amount - (payment.allocatedAmount ?? 0));
    return payment;
  }

  /** Registers a payment; `create` (not the controller) opens the transaction. */
  async createStandalone(user: AuthUser, input: CreatePaymentInput): Promise<Payment> {
    return this.db.tx(user, async (tx) => {
      const id = await this.create(tx, user, input);
      return this.load(tx, id);
    });
  }

  async create(tx: Tx, user: AuthUser, input: CreatePaymentInput): Promise<string> {
    const allocations = input.allocations ?? [];
    const allocatedTotal = round2(allocations.reduce((s, a) => s + a.amount, 0));
    if (allocatedTotal > input.amount + 0.01) {
      throw new BadRequestException('Allocations cannot exceed the payment amount');
    }
    if (input.direction === 'outbound' && allocatedTotal < input.amount - 0.01) {
      throw new BadRequestException('An outbound payment must be fully allocated to expenses');
    }

    const paymentDate = input.paymentDate ?? today();
    const row = await tx.one<{ id: string }>(
      `INSERT INTO payments (branch_id, direction, client_id, supplier, method, reference, currency, amount,
                             payment_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11) RETURNING id`,
      [
        input.branchId, input.direction, input.clientId ?? null, input.supplier ?? null,
        input.method ?? 'bank_transfer', input.reference ?? null, input.currency, input.amount,
        paymentDate, input.notes ?? null, user.id,
      ],
    );
    const paymentId = row!.id;

    for (const a of allocations) {
      await this.applyAllocation(tx, user, {
        paymentId, branchId: input.branchId, direction: input.direction, currency: input.currency,
        date: paymentDate, invoiceId: a.invoiceId, expenseId: a.expenseId, amount: a.amount, mode: 'direct',
      });
    }

    const remainder = round2(input.amount - allocatedTotal);
    if (remainder > 0.01) {
      // Inbound only (outbound is rejected above): cash received with nothing to apply it to
      // yet — on account, or an overpayment. It still hits the books immediately, just against
      // a clearing account instead of a specific invoice.
      await this.ledger.post(tx, user, {
        branchId: input.branchId,
        currency: input.currency,
        date: paymentDate,
        sourceType: 'payment_on_account',
        sourceId: paymentId,
        description: `Payment on account${input.reference ? ' ' + input.reference : ''}`,
        legs: [
          { account: 'cash.bank', group: 'cash', debit: remainder },
          { account: 'ar.unapplied', group: 'receivable', credit: remainder },
        ],
      });
    }

    await this.audit.record(tx, user, {
      action: input.direction === 'inbound' ? 'payment.receive' : 'payment.pay_out',
      entityType: 'payment',
      entityId: paymentId,
      branchId: input.branchId,
      after: { amount: input.amount, currency: input.currency, allocated: allocatedTotal, unallocated: remainder },
    });

    return paymentId;
  }

  /** Applies (or re-applies) part of an existing payment's unapplied balance. Inbound only. */
  async allocate(user: AuthUser, paymentId: string, target: { invoiceId?: string; expenseId?: string }, amount: number) {
    if (!(amount > 0)) throw new BadRequestException('Allocation amount must be positive');
    return this.db.tx(user, async (tx) => {
      const payment = await tx.one<{ branch_id: string; direction: PaymentDirection; currency: string; amount: string }>(
        `SELECT branch_id, direction, currency, amount FROM payments WHERE id = $1 FOR UPDATE`,
        [paymentId],
      );
      if (!payment) throw new NotFoundException('Payment not found');
      if (payment.direction !== 'inbound') {
        throw new ConflictException('An outbound payment is already fully allocated when it is created');
      }
      const already = await tx.one<{ sum: string }>(
        `SELECT COALESCE(SUM(amount), 0) AS sum FROM payment_allocations WHERE payment_id = $1`,
        [paymentId],
      );
      const unapplied = round2(Number(payment.amount) - Number(already?.sum ?? 0));
      if (amount > unapplied + 0.01) {
        throw new BadRequestException(`Only ${unapplied} ${payment.currency} of this payment is unapplied`);
      }

      await this.applyAllocation(tx, user, {
        paymentId, branchId: payment.branch_id, direction: payment.direction, currency: payment.currency,
        date: today(), invoiceId: target.invoiceId, expenseId: target.expenseId, amount, mode: 'fromClearing',
      });

      await this.audit.record(tx, user, {
        action: 'payment.allocate',
        entityType: 'payment',
        entityId: paymentId,
        branchId: payment.branch_id,
        after: { invoiceId: target.invoiceId ?? null, expenseId: target.expenseId ?? null, amount },
      });

      return this.load(tx, paymentId);
    });
  }

  private async applyAllocation(
    tx: Tx,
    user: AuthUser,
    opts: {
      paymentId: string; branchId: string; direction: PaymentDirection; currency: string; date: string;
      invoiceId?: string; expenseId?: string; amount: number; mode: 'direct' | 'fromClearing';
    },
  ): Promise<void> {
    if (!(opts.amount > 0)) throw new BadRequestException('Allocation amount must be positive');
    if ((opts.invoiceId ? 1 : 0) + (opts.expenseId ? 1 : 0) !== 1) {
      throw new BadRequestException('An allocation targets exactly one invoice or one expense');
    }

    // Validated and applied to the target first, the payment_allocations row written last —
    // otherwise a row inserted before the "how much is still owed" query would count itself.
    const insertAllocation = () =>
      tx.exec(
        `INSERT INTO payment_allocations (payment_id, invoice_id, expense_id, amount, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [opts.paymentId, opts.invoiceId ?? null, opts.expenseId ?? null, opts.amount, user.id],
      );

    if (opts.invoiceId) {
      const inv = await tx.one<{ status: string; amount_total: string; amount_paid: string; invoice_number: string }>(
        `SELECT status, amount_total, amount_paid, invoice_number FROM invoices WHERE id = $1 FOR UPDATE`,
        [opts.invoiceId],
      );
      if (!inv) throw new NotFoundException('Invoice not found');
      if (!['issued', 'partially_paid'].includes(inv.status)) {
        throw new ConflictException(`Cannot allocate a payment to an invoice in status ${inv.status}`);
      }
      const due = round2(Number(inv.amount_total) - Number(inv.amount_paid));
      if (opts.amount > due + 0.01) {
        throw new BadRequestException(`Only ${due} is due on invoice ${inv.invoice_number}`);
      }
      const fullyPaid = opts.amount >= due - 0.01;
      await tx.exec(
        `UPDATE invoices SET amount_paid = amount_paid + $2,
                             status = CASE WHEN $3 THEN 'paid'::invoice_status ELSE 'partially_paid'::invoice_status END,
                             paid_at = CASE WHEN $3 THEN now() ELSE paid_at END
         WHERE id = $1`,
        [opts.invoiceId, opts.amount, fullyPaid],
      );
      await insertAllocation();
      await this.ledger.post(tx, user, {
        branchId: opts.branchId,
        currency: opts.currency,
        date: opts.date,
        sourceType: 'payment',
        sourceId: opts.invoiceId,
        description: `Payment for ${inv.invoice_number}`,
        legs:
          opts.mode === 'direct'
            ? [
                { account: 'cash.bank', group: 'cash', debit: opts.amount },
                { account: 'ar.trade', group: 'receivable', credit: opts.amount },
              ]
            : [
                { account: 'ar.unapplied', group: 'receivable', debit: opts.amount },
                { account: 'ar.trade', group: 'receivable', credit: opts.amount },
              ],
      });
      return;
    }

    // Outbound: paying off an on-account expense. The check above guarantees expenseId is set here.
    const expenseId = opts.expenseId as string;
    const exp = await tx.one<{ amount: string; payment_status: string; description: string }>(
      `SELECT amount, payment_status, description FROM expenses WHERE id = $1 FOR UPDATE`,
      [expenseId],
    );
    if (!exp) throw new NotFoundException('Expense not found');
    if (exp.payment_status === 'paid') {
      throw new ConflictException(`"${exp.description}" is already paid`);
    }
    const paidSoFar = await tx.one<{ sum: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS sum FROM payment_allocations WHERE expense_id = $1`,
      [expenseId],
    );
    const due = round2(Number(exp.amount) - Number(paidSoFar?.sum ?? 0));
    if (opts.amount > due + 0.01) {
      throw new BadRequestException(`Only ${due} is still owed on "${exp.description}"`);
    }
    const fullyPaid = opts.amount >= due - 0.01;
    await tx.exec(
      `UPDATE expenses SET payment_status = $2 WHERE id = $1`,
      [expenseId, fullyPaid ? 'paid' : 'partially_paid'],
    );
    await insertAllocation();
    await this.ledger.post(tx, user, {
      branchId: opts.branchId,
      currency: opts.currency,
      date: opts.date,
      sourceType: 'expense_payment',
      sourceId: expenseId,
      description: `Payment for "${exp.description}"`,
      legs: [
        { account: 'ap.trade', group: 'payable', debit: opts.amount },
        { account: 'cash.bank', group: 'cash', credit: opts.amount },
      ],
    });
  }
}
