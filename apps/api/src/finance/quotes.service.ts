import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser, Quote, QuoteAction, QuoteLine, QuoteStatus } from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../common/audit.service';
import { QuoteWorkflowService } from './quote-workflow.service';
import { InvoicesService, round2, today } from './invoices.service';

const QUOTE_COLUMNS = `
  q.id, q.branch_id AS "branchId", b.code AS "branchCode", q.client_id AS "clientId", c.name AS "clientName",
  q.job_id AS "jobId", j.job_number AS "jobNumber", q.quote_number AS "quoteNumber", q.status, q.currency,
  q.amount_net::float8 AS "amountNet", q.tax_rate::float8 AS "taxRate", q.tax_amount::float8 AS "taxAmount",
  q.amount_total::float8 AS "amountTotal", to_char(q.issue_date, 'YYYY-MM-DD') AS "issueDate",
  to_char(q.valid_until, 'YYYY-MM-DD') AS "validUntil", q.sent_at AS "sentAt", q.decided_at AS "decidedAt",
  q.decision_note AS "decisionNote", q.notes, q.version, q.created_at AS "createdAt", q.updated_at AS "updatedAt",
  q.deleted_at AS "deletedAt"`;

const QUOTE_FROM = `
  quotes q
  JOIN branches b ON b.id = q.branch_id
  JOIN clients c ON c.id = q.client_id
  LEFT JOIN inspection_jobs j ON j.id = q.job_id`;

export interface QuoteLineInput {
  serviceId?: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface CreateQuoteInput {
  clientId: string;
  jobId?: string | null;
  lines: QuoteLineInput[];
  taxRate?: number;
  issueDate?: string;
  validUntil?: string | null;
  notes?: string | null;
  currency?: string;
}

/** Quotes (PHASE 8): the commercial offer that precedes an invoice. */
@Injectable()
export class QuotesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly workflow: QuoteWorkflowService,
    private readonly invoices: InvoicesService,
  ) {}

  list(user: AuthUser, f: { status?: QuoteStatus; clientId?: string; branchId?: string }) {
    return this.db.tx(user, (tx) =>
      tx.many<Quote>(
        `SELECT ${QUOTE_COLUMNS} FROM ${QUOTE_FROM}
         WHERE ($1::quote_status IS NULL OR q.status = $1::quote_status)
           AND ($2::uuid IS NULL OR q.client_id = $2::uuid)
           AND ($3::uuid IS NULL OR q.branch_id = $3::uuid)
           AND q.deleted_at IS NULL
         ORDER BY q.issue_date DESC, q.quote_number DESC
         LIMIT 500`,
        [f.status ?? null, f.clientId ?? null, f.branchId ?? null],
      ),
    );
  }

  async get(user: AuthUser, id: string): Promise<Quote> {
    return this.db.tx(user, async (tx) => {
      const quote = await this.load(tx, id);
      quote.actions = this.workflow.available(user, quote);
      return quote;
    });
  }

  private async load(tx: Tx, id: string): Promise<Quote> {
    const quote = await tx.one<Quote>(`SELECT ${QUOTE_COLUMNS} FROM ${QUOTE_FROM} WHERE q.id = $1 AND q.deleted_at IS NULL`, [id]);
    if (!quote) throw new NotFoundException('Quote not found');
    quote.lines = await tx.many<QuoteLine>(
      `SELECT ql.id, ql.quote_id AS "quoteId", ql.service_id AS "serviceId", s.code AS "serviceCode",
              ql.description, ql.quantity::float8 AS quantity, ql.unit_price::float8 AS "unitPrice",
              ql.amount::float8 AS amount, ql.sort_order AS "sortOrder"
       FROM quote_lines ql LEFT JOIN services s ON s.id = ql.service_id
       WHERE ql.quote_id = $1 ORDER BY ql.sort_order`,
      [id],
    );
    return quote;
  }

  create(user: AuthUser, input: CreateQuoteInput) {
    if (!input.lines?.length) throw new BadRequestException('At least one quote line is required');
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
        `INSERT INTO quotes (branch_id, client_id, job_id, quote_number, currency, amount_net, tax_rate,
                             tax_amount, amount_total, issue_date, valid_until, notes, created_by)
         VALUES ($1, $2, $3, next_doc_number($1, 'Q'), $4, $5, $6, $7, $8, $9::date, $10::date, $11, $12)
         RETURNING id`,
        [client.branch_id, input.clientId, input.jobId ?? null, input.currency ?? client.currency, net, taxRate,
         tax, round2(net + tax), issueDate, input.validUntil ?? null, input.notes ?? null, user.id],
      );
      await tx.exec(
        `INSERT INTO quote_lines (quote_id, service_id, description, quantity, unit_price, sort_order)
         SELECT $1, l.service_id, l.description, l.quantity, l.unit_price, l.ord
         FROM jsonb_to_recordset($2::jsonb)
           AS l(service_id uuid, description text, quantity numeric, unit_price numeric, ord int)`,
        [row!.id, JSON.stringify(input.lines.map((l, i) => ({
          service_id: l.serviceId ?? null, description: l.description, quantity: l.quantity,
          unit_price: l.unitPrice, ord: (i + 1) * 10,
        })))],
      );
      return this.load(tx, row!.id);
    });
  }

  async transition(user: AuthUser, id: string, action: QuoteAction, reason?: string | null) {
    return this.db.tx(user, async (tx) => {
      const quote = await this.load(tx, id);
      await this.workflow.apply(tx, user, quote, action, { reason });
      return this.load(tx, id);
    });
  }

  /** Drafts are archived, never destroyed — the number was allocated and stays accounted for. */
  remove(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const quote = await this.load(tx, id);
      if (quote.status !== 'draft') throw new ConflictException('Only a draft quote can be deleted');
      await tx.exec('UPDATE quotes SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [id, user.id]);
      await this.audit.record(tx, user, {
        action: 'quote.delete', entityType: 'quote', entityId: id, entityLabel: quote.quoteNumber,
        branchId: quote.branchId, before: { status: quote.status },
      });
    }, { includeArchived: true });
  }

  /**
   * Copies an accepted quote's lines into a new draft invoice.
   *
   * Two separate transactions (this one reads the quote, `InvoicesService.create` writes the
   * invoice): there is nothing here that must be atomic with the quote itself — the quote's
   * status and number stay exactly what they are either way, so a failed invoice creation
   * leaves nothing inconsistent behind.
   */
  async createInvoice(user: AuthUser, id: string) {
    const quote = await this.get(user, id);
    if (quote.status !== 'accepted') {
      throw new ConflictException('Only an accepted quote can be turned into an invoice');
    }
    return this.invoices.create(user, {
      clientId: quote.clientId,
      jobId: quote.jobId,
      currency: quote.currency,
      taxRate: quote.taxRate,
      lines: (quote.lines ?? []).map((l) => ({
        description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
      })),
    });
  }
}
