import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser, HQ_ROLES, Invoice, InvoiceLine, InvoiceStatus } from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { LedgerService } from './ledger.service';

const INVOICE_COLUMNS = `
  i.id, i.branch_id AS "branchId", b.code AS "branchCode", i.client_id AS "clientId", c.name AS "clientName",
  i.job_id AS "jobId", j.job_number AS "jobNumber", j.type AS "serviceType", i.invoice_number AS "invoiceNumber",
  i.status, i.currency, i.amount_net::float8 AS "amountNet", i.tax_rate::float8 AS "taxRate",
  i.tax_amount::float8 AS "taxAmount", i.amount_total::float8 AS "amountTotal",
  i.amount_paid::float8 AS "amountPaid", (i.amount_total - i.amount_paid)::float8 AS "amountDue",
  to_char(i.issue_date, 'YYYY-MM-DD') AS "issueDate", to_char(i.due_date, 'YYYY-MM-DD') AS "dueDate",
  i.paid_at AS "paidAt", i.notes, i.created_at AS "createdAt",
  CASE WHEN i.status IN ('issued', 'partially_paid') AND i.due_date IS NOT NULL
       THEN (current_date - i.due_date) END AS "daysOverdue"`;

const INVOICE_FROM = `
  invoices i
  JOIN branches b ON b.id = i.branch_id
  JOIN clients c ON c.id = i.client_id
  LEFT JOIN inspection_jobs j ON j.id = i.job_id`;

export interface InvoiceLineInput {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface CreateInvoiceInput {
  clientId: string;
  jobId?: string | null;
  lines: InvoiceLineInput[];
  taxRate?: number;
  issueDate?: string;
  dueDate?: string | null;
  notes?: string | null;
  currency?: string;
}

/**
 * Client billing (docs/01-architecture.md, module 6). Issuing an invoice or registering a
 * payment writes to the ledger straight away, which is what makes the dashboard live.
 */
@Injectable()
export class InvoicesService {
  constructor(private readonly db: DbService, private readonly ledger: LedgerService) {}

  list(user: AuthUser, f: { status?: InvoiceStatus; clientId?: string; overdue?: boolean }) {
    return this.db.tx(user, (tx) =>
      tx.many<Invoice>(
        `SELECT ${INVOICE_COLUMNS} FROM ${INVOICE_FROM}
         WHERE ($1::invoice_status IS NULL OR i.status = $1::invoice_status)
           AND ($2::uuid IS NULL OR i.client_id = $2::uuid)
           AND ($3::boolean IS NOT TRUE OR (i.status IN ('issued','partially_paid') AND i.due_date < current_date))
         ORDER BY i.issue_date DESC, i.invoice_number DESC
         LIMIT 500`,
        [f.status ?? null, f.clientId ?? null, f.overdue ?? null],
      ),
    );
  }

  get(user: AuthUser, id: string) {
    return this.db.tx(user, (tx) => this.load(tx, id));
  }

  private async load(tx: Tx, id: string): Promise<Invoice> {
    const inv = await tx.one<Invoice>(`SELECT ${INVOICE_COLUMNS} FROM ${INVOICE_FROM} WHERE i.id = $1`, [id]);
    if (!inv) throw new NotFoundException('Invoice not found');
    inv.lines = await tx.many<InvoiceLine>(
      `SELECT id, invoice_id AS "invoiceId", description, quantity::float8 AS quantity,
              unit_price::float8 AS "unitPrice", amount::float8 AS amount, sort_order AS "sortOrder"
       FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order`,
      [id],
    );
    return inv;
  }

  create(user: AuthUser, input: CreateInvoiceInput) {
    if (!input.lines?.length) throw new BadRequestException('At least one invoice line is required');
    return this.db.tx(user, async (tx) => {
      const client = await tx.one<{ branch_id: string; currency: string }>(
        `SELECT c.branch_id, b.currency FROM clients c JOIN branches b ON b.id = c.branch_id WHERE c.id = $1`,
        [input.clientId],
      );
      if (!client) throw new NotFoundException('Client not found');

      const net = input.lines.reduce((s, l) => s + round2(l.quantity * l.unitPrice), 0);
      const taxRate = input.taxRate ?? 0;
      const tax = round2((net * taxRate) / 100);
      const issueDate = input.issueDate ?? today();

      const row = await tx.one<{ id: string }>(
        `INSERT INTO invoices (branch_id, client_id, job_id, invoice_number, currency, amount_net, tax_rate,
                               tax_amount, amount_total, issue_date, due_date, notes, created_by)
         VALUES ($1, $2, $3, next_doc_number($1, 'I'), $4, $5, $6, $7, $8, $9::date, $10::date, $11, $12)
         RETURNING id`,
        [client.branch_id, input.clientId, input.jobId ?? null, input.currency ?? client.currency, net, taxRate,
         tax, round2(net + tax), issueDate, input.dueDate ?? null, input.notes ?? null, user.id],
      );
      await tx.exec(
        `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price, sort_order)
         SELECT $1, l.description, l.quantity, l.unit_price, l.ord
         FROM jsonb_to_recordset($2::jsonb) AS l(description text, quantity numeric, unit_price numeric, ord int)`,
        [row!.id, JSON.stringify(input.lines.map((l, i) => ({
          description: l.description, quantity: l.quantity, unit_price: l.unitPrice, ord: (i + 1) * 10,
        })))],
      );
      return this.load(tx, row!.id);
    });
  }

  /** Draft → issued: revenue and receivable hit the ledger. */
  issue(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const inv = await this.lock(tx, id);
      if (inv.status !== 'draft') throw new ConflictException(`Invoice is already ${inv.status}`);
      await tx.exec(`UPDATE invoices SET status = 'issued' WHERE id = $1`, [id]);
      await this.ledger.post(tx, user, {
        branchId: inv.branch_id,
        currency: inv.currency,
        date: inv.issue_date,
        sourceType: 'invoice',
        sourceId: id,
        description: `Invoice ${inv.invoice_number}`,
        legs: [
          { account: 'ar.trade', group: 'receivable', debit: Number(inv.amount_total) },
          { account: 'revenue.services', group: 'revenue', credit: Number(inv.amount_net) },
          ...(Number(inv.tax_amount) > 0
            ? [{ account: 'tax.output_vat', group: 'tax' as const, credit: Number(inv.tax_amount) }]
            : []),
        ],
      });
      return this.load(tx, id);
    });
  }

  /** Registers a (partial) payment: cash up, receivable down. */
  pay(user: AuthUser, id: string, amount: number, paidOn?: string) {
    if (!(amount > 0)) throw new BadRequestException('Payment amount must be positive');
    return this.db.tx(user, async (tx) => {
      const inv = await this.lock(tx, id);
      if (!['issued', 'partially_paid'].includes(inv.status)) {
        throw new ConflictException(`Cannot register a payment for an invoice in status ${inv.status}`);
      }
      const due = round2(Number(inv.amount_total) - Number(inv.amount_paid));
      const paid = round2(Math.min(amount, due));
      const fullyPaid = paid >= due - 0.01;
      await tx.exec(
        `UPDATE invoices SET amount_paid = amount_paid + $2,
                             status = CASE WHEN $3 THEN 'paid'::invoice_status ELSE 'partially_paid'::invoice_status END,
                             paid_at = CASE WHEN $3 THEN now() ELSE paid_at END
         WHERE id = $1`,
        [id, paid, fullyPaid],
      );
      await this.ledger.post(tx, user, {
        branchId: inv.branch_id,
        currency: inv.currency,
        date: paidOn ?? today(),
        sourceType: 'payment',
        sourceId: id,
        description: `Payment for ${inv.invoice_number}`,
        legs: [
          { account: 'cash.bank', group: 'cash', debit: paid },
          { account: 'ar.trade', group: 'receivable', credit: paid },
        ],
      });
      return this.load(tx, id);
    });
  }

  cancel(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const inv = await this.lock(tx, id);
      if (inv.status === 'paid') throw new ConflictException('A paid invoice cannot be cancelled');
      if (inv.status !== 'draft') {
        // Keep the audit trail: reverse the postings instead of deleting them.
        await this.ledger.reverse(tx, user, 'invoice', id, today());
      }
      await tx.exec(`UPDATE invoices SET status = 'cancelled' WHERE id = $1`, [id]);
      return this.load(tx, id);
    });
  }

  remove(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const inv = await this.lock(tx, id);
      if (inv.status !== 'draft') throw new ConflictException('Only draft invoices can be deleted');
      await tx.exec('DELETE FROM invoices WHERE id = $1', [id]);
    });
  }

  private async lock(tx: Tx, id: string) {
    const inv = await tx.one<{
      branch_id: string; currency: string; status: InvoiceStatus; invoice_number: string;
      amount_total: string; amount_paid: string; amount_net: string; tax_amount: string; issue_date: string;
    }>(
      `SELECT branch_id, currency, status, invoice_number, amount_total, amount_paid, amount_net, tax_amount,
              to_char(issue_date, 'YYYY-MM-DD') AS issue_date
       FROM invoices WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!inv) throw new NotFoundException('Invoice not found');
    return inv;
  }
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export const isHq = (user: AuthUser) => HQ_ROLES.includes(user.role);
