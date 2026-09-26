import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ArAgingBucket,
  AuthUser,
  FiscalSnapshot,
  Invoice,
  InvoiceLine,
  InvoicePayment,
  InvoiceStatus,
  InvoiceSummary,
  LegalEntity,
} from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { LedgerService } from './ledger.service';
import { AuditService } from '../common/audit.service';
import { PaymentsService } from './payments.service';
import { JurisdictionProfileService } from './jurisdiction-profile.service';
import { computeFiscalTotals, resolveTaxCode } from './fiscal-calc';
import { config } from '../config';

const INVOICE_COLUMNS = `
  i.id, i.branch_id AS "branchId", b.code AS "branchCode", i.client_id AS "clientId", c.name AS "clientName",
  i.job_id AS "jobId", j.job_number AS "jobNumber", j.type AS "serviceType", i.invoice_number AS "invoiceNumber",
  i.status, i.currency, i.amount_net::float8 AS "amountNet", i.tax_rate::float8 AS "taxRate",
  i.tax_amount::float8 AS "taxAmount", i.amount_total::float8 AS "amountTotal",
  i.amount_paid::float8 AS "amountPaid", (i.amount_total - i.amount_paid)::float8 AS "amountDue",
  to_char(i.issue_date, 'YYYY-MM-DD') AS "issueDate", to_char(i.due_date, 'YYYY-MM-DD') AS "dueDate",
  i.paid_at AS "paidAt", i.notes, i.created_at AS "createdAt",
  CASE WHEN i.status IN ('issued', 'partially_paid') AND i.due_date IS NOT NULL
       THEN (current_date - i.due_date) END AS "daysOverdue",
  i.legal_entity_id AS "legalEntityId", le.legal_name AS "legalEntityName",
  i.jurisdiction_country_code AS "jurisdictionCountryCode",
  i.jurisdiction_profile_version AS "jurisdictionProfileVersion", i.tax_code AS "taxCode",
  i.is_legacy_fiscal AS "isLegacyFiscal", i.fiscal_snapshot AS "fiscalSnapshot",
  i.esf_status AS "esfStatus", i.esf_registration_number AS "esfRegistrationNumber",
  i.esf_submitted_at AS "esfSubmittedAt", i.esf_registered_at AS "esfRegisteredAt"`;

const INVOICE_FROM = `
  invoices i
  JOIN branches b ON b.id = i.branch_id
  JOIN clients c ON c.id = i.client_id
  LEFT JOIN inspection_jobs j ON j.id = i.job_id
  LEFT JOIN legal_entities le ON le.id = i.legal_entity_id`;

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
  /**
   * Opt-in fiscal path (migration 028): when set, tax is computed from the legal entity's
   * jurisdiction profile instead of the caller-supplied `taxRate`, and the invoice carries an
   * immutable fiscal snapshot once issued. Omitted, this is the exact legacy behavior — same
   * math, same columns, `isLegacyFiscal: true`.
   */
  legalEntityId?: string | null;
  /** A code from the resolved jurisdiction profile's taxCodes, e.g. 'STANDARD' | 'ZERO'. Ignored
   *  (forced to the profile's non-taxable code) when the legal entity is not VAT-registered. */
  taxCode?: string;
}

/**
 * Client billing (docs/01-architecture.md, module 6). Issuing an invoice or registering a
 * payment writes to the ledger straight away, which is what makes the dashboard live.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly db: DbService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly paymentsService: PaymentsService,
    private readonly jurisdictionProfiles: JurisdictionProfileService,
  ) {}

  list(user: AuthUser, f: { status?: InvoiceStatus; clientId?: string; overdue?: boolean; branchId?: string; jobId?: string }) {
    return this.db.tx(user, (tx) =>
      tx.many<Invoice>(
        `SELECT ${INVOICE_COLUMNS} FROM ${INVOICE_FROM}
         WHERE ($1::invoice_status IS NULL OR i.status = $1::invoice_status)
           AND ($2::uuid IS NULL OR i.client_id = $2::uuid)
           AND ($3::boolean IS NOT TRUE OR (i.status IN ('issued','partially_paid') AND i.due_date < current_date))
           AND ($4::uuid IS NULL OR i.branch_id = $4::uuid)
           AND ($5::uuid IS NULL OR i.job_id = $5::uuid)
           AND i.deleted_at IS NULL
         ORDER BY i.issue_date DESC, i.invoice_number DESC
         LIMIT 500`,
        [f.status ?? null, f.clientId ?? null, f.overdue ?? null, f.branchId ?? null, f.jobId ?? null],
      ),
    );
  }

  get(user: AuthUser, id: string) {
    return this.db.tx(user, (tx) => this.load(tx, id));
  }

  /**
   * Analytics for the invoices page: what was invoiced, what came in, what is still owed and
   * who to chase. Consolidated at the fx rate of each document's date; RLS and the branch
   * filter scope it exactly like the list.
   */
  summary(user: AuthUser, f: { from?: string; to?: string; branchId?: string }): Promise<InvoiceSummary> {
    const base = config.consolidationCurrency;
    const from = f.from ?? defaultFrom();
    const to = f.to ?? today();
    const branchId = f.branchId ?? null;
    const p = [from, to, base, branchId];

    return this.db.tx(user, async (tx) => {
      const [totals, collected, outstanding, monthly, byStatus, byClient, aging, topOverdue] = await Promise.all([
        tx.one<{ issued: number; cnt: number; drafts: number; avg_days: number | null }>(
          `SELECT COALESCE(SUM(i.amount_total * fx_rate_on(i.currency, $3, i.issue_date))
                    FILTER (WHERE i.status <> 'draft' AND i.status <> 'cancelled'), 0)::float8 AS issued,
                  count(*) FILTER (WHERE i.status <> 'draft' AND i.status <> 'cancelled')::int AS cnt,
                  count(*) FILTER (WHERE i.status = 'draft')::int AS drafts,
                  avg(i.paid_at::date - i.issue_date) FILTER (WHERE i.status = 'paid')::float8 AS avg_days
           FROM invoices i
           WHERE i.issue_date BETWEEN $1::date AND $2::date AND ($4::uuid IS NULL OR i.branch_id = $4::uuid)
             AND i.deleted_at IS NULL`,
          p,
        ),
        // Cash actually received in the period, from the payment postings.
        tx.one<{ amount: number }>(
          `SELECT COALESCE(SUM(l.amount_base), 0)::float8 AS amount
           FROM ledger_entries l
           WHERE l.source_type = 'payment' AND l.account_group = 'cash' AND l.debit > 0
             AND l.entry_date BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR l.branch_id = $3::uuid)`,
          [from, to, branchId],
        ),
        tx.one<{ outstanding: number; overdue: number }>(
          `SELECT COALESCE(SUM((i.amount_total - i.amount_paid) * fx_rate_on(i.currency, $1, i.issue_date)), 0)::float8 AS outstanding,
                  COALESCE(SUM((i.amount_total - i.amount_paid) * fx_rate_on(i.currency, $1, i.issue_date))
                    FILTER (WHERE i.due_date < current_date), 0)::float8 AS overdue
           FROM invoices i
           WHERE i.status IN ('issued', 'partially_paid') AND ($2::uuid IS NULL OR i.branch_id = $2::uuid)`,
          [base, branchId],
        ),
        tx.many<{ month: string; issued: number; collected: number }>(
          `WITH months AS (
             SELECT date_trunc('month', m)::date AS m_start
             FROM generate_series(date_trunc('month', $1::date), date_trunc('month', $2::date), interval '1 month') m
           )
           SELECT to_char(months.m_start, 'YYYY-MM') AS month,
                  COALESCE((SELECT SUM(i.amount_total * fx_rate_on(i.currency, $3, i.issue_date))
                            FROM invoices i
                            WHERE date_trunc('month', i.issue_date)::date = months.m_start
                              AND i.status <> 'draft' AND i.status <> 'cancelled'
                              AND ($4::uuid IS NULL OR i.branch_id = $4::uuid)), 0)::float8 AS issued,
                  COALESCE((SELECT SUM(l.amount_base) FROM ledger_entries l
                            WHERE date_trunc('month', l.entry_date)::date = months.m_start
                              AND l.source_type = 'payment' AND l.account_group = 'cash' AND l.debit > 0
                              AND ($4::uuid IS NULL OR l.branch_id = $4::uuid)), 0)::float8 AS collected
           FROM months ORDER BY months.m_start`,
          p,
        ),
        tx.many<{ status: InvoiceStatus; cnt: number; amount: number }>(
          `SELECT i.status, count(*)::int AS cnt,
                  SUM(i.amount_total * fx_rate_on(i.currency, $3, i.issue_date))::float8 AS amount
           FROM invoices i
           WHERE i.issue_date BETWEEN $1::date AND $2::date AND ($4::uuid IS NULL OR i.branch_id = $4::uuid)
             AND i.deleted_at IS NULL
           GROUP BY i.status`,
          p,
        ),
        tx.many<{ client_id: string; key: string; amount: number }>(
          `SELECT c.id AS client_id, c.name AS key,
                  SUM(i.amount_total * fx_rate_on(i.currency, $3, i.issue_date))::float8 AS amount
           FROM invoices i JOIN clients c ON c.id = i.client_id
           WHERE i.issue_date BETWEEN $1::date AND $2::date
             AND i.status <> 'draft' AND i.status <> 'cancelled'
             AND ($4::uuid IS NULL OR i.branch_id = $4::uuid)
           GROUP BY c.id, c.name ORDER BY amount DESC LIMIT 8`,
          p,
        ),
        tx.many<{ bucket: string; amount: number; cnt: number }>(
          `SELECT CASE
                    WHEN current_date - COALESCE(due_date, issue_date) <= 30 THEN '0-30'
                    WHEN current_date - COALESCE(due_date, issue_date) <= 60 THEN '31-60'
                    WHEN current_date - COALESCE(due_date, issue_date) <= 90 THEN '61-90'
                    ELSE '90+' END AS bucket,
                  SUM((amount_total - amount_paid) * fx_rate_on(currency, $1, issue_date))::float8 AS amount,
                  count(*)::int AS cnt
           FROM invoices
           WHERE status IN ('issued', 'partially_paid') AND ($2::uuid IS NULL OR branch_id = $2::uuid)
           GROUP BY 1`,
          [base, branchId],
        ),
        tx.many<{
          id: string; invoice_number: string; client_name: string; due: number; currency: string;
          due_base: number; days: number;
        }>(
          `SELECT i.id, i.invoice_number, c.name AS client_name,
                  (i.amount_total - i.amount_paid)::float8 AS due, i.currency,
                  ((i.amount_total - i.amount_paid) * fx_rate_on(i.currency, $1, i.issue_date))::float8 AS due_base,
                  (current_date - i.due_date)::int AS days
           FROM invoices i JOIN clients c ON c.id = i.client_id
           WHERE i.status IN ('issued', 'partially_paid') AND i.due_date < current_date
             AND ($2::uuid IS NULL OR i.branch_id = $2::uuid)
           ORDER BY due_base DESC LIMIT 8`,
          [base, branchId],
        ),
      ]);

      const issuedBase = round2(n(totals?.issued));
      const collectedBase = round2(n(collected?.amount));
      const count = n(totals?.cnt);
      const statusTotal = byStatus.reduce((s, r) => s + n(r.amount), 0);
      const clientTotal = byClient.reduce((s, r) => s + n(r.amount), 0);
      const order: ArAgingBucket['bucket'][] = ['0-30', '31-60', '61-90', '90+'];

      return {
        baseCurrency: base,
        period: { from, to },
        totals: {
          issuedBase,
          collectedBase,
          outstandingBase: round2(n(outstanding?.outstanding)),
          overdueBase: round2(n(outstanding?.overdue)),
          invoiceCount: count,
          avgInvoiceBase: count > 0 ? round2(issuedBase / count) : 0,
          collectionRatePct: issuedBase > 0 ? round2((collectedBase / issuedBase) * 100) : null,
          avgDaysToPay: totals?.avg_days === null || totals?.avg_days === undefined ? null : round2(n(totals.avg_days)),
          draftCount: n(totals?.drafts),
        },
        monthly: monthly.map((m) => ({
          month: m.month,
          issuedBase: round2(n(m.issued)),
          collectedBase: round2(n(m.collected)),
        })),
        byStatus: byStatus.map((r) => ({
          status: r.status,
          count: n(r.cnt),
          amountBase: round2(n(r.amount)),
          share: statusTotal > 0 ? round2((n(r.amount) / statusTotal) * 100) : 0,
        })),
        byClient: byClient.map((r) => ({
          key: r.key,
          clientId: r.client_id,
          amountBase: round2(n(r.amount)),
          share: clientTotal > 0 ? round2((n(r.amount) / clientTotal) * 100) : 0,
        })),
        aging: order.map((bucket) => {
          const row = aging.find((a) => a.bucket === bucket);
          return { bucket, amountBase: round2(n(row?.amount)), invoiceCount: n(row?.cnt) };
        }),
        topOverdue: topOverdue.map((r) => ({
          id: r.id,
          invoiceNumber: r.invoice_number,
          clientName: r.client_name,
          amountDue: round2(n(r.due)),
          currency: r.currency,
          amountDueBase: round2(n(r.due_base)),
          daysOverdue: n(r.days),
        })),
      };
    });
  }

  /**
   * Payment history of one invoice. Since PHASE 8 this is read from `payment_allocations` (the
   * real record of what was applied, whichever way the money arrived); an invoice untouched
   * since before that phase falls back to its ledger postings, exactly as this always worked.
   * A payment made before PHASE 8 and another made after it, on the same invoice, would only
   * show the second here — a display nuance, not a money one: amount_paid and status are
   * correct either way.
   */
  payments(user: AuthUser, id: string): Promise<InvoicePayment[]> {
    const base = config.consolidationCurrency;
    return this.db.tx(user, (tx) =>
      tx.many<InvoicePayment>(
        `SELECT * FROM (
           SELECT to_char(pay.payment_date, 'YYYY-MM-DD') AS date, pa.amount::float8 AS amount, pay.currency,
                  (pa.amount * fx_rate_on(pay.currency, $2, pay.payment_date))::float8 AS "amountBase",
                  u.full_name AS "registeredBy", pay.created_at AS sort_at
           FROM payment_allocations pa
           JOIN payments pay ON pay.id = pa.payment_id
           LEFT JOIN users u ON u.id = pay.created_by
           WHERE pa.invoice_id = $1
           UNION ALL
           SELECT to_char(l.entry_date, 'YYYY-MM-DD') AS date, l.debit::float8 AS amount, l.currency,
                  l.amount_base::float8 AS "amountBase", u2.full_name AS "registeredBy", l.created_at AS sort_at
           FROM ledger_entries l
           LEFT JOIN users u2 ON u2.id = l.created_by
           WHERE l.source_type = 'payment' AND l.source_id = $1 AND l.account_group = 'cash' AND l.debit > 0
             AND NOT EXISTS (SELECT 1 FROM payment_allocations pa2 WHERE pa2.invoice_id = $1)
         ) history
         ORDER BY date, sort_at`,
        [id, base],
      ),
    );
  }

  private async load(tx: Tx, id: string): Promise<Invoice> {
    const inv = await tx.one<Invoice>(
      `SELECT ${INVOICE_COLUMNS} FROM ${INVOICE_FROM} WHERE i.id = $1 AND i.deleted_at IS NULL`,
      [id],
    );
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
      const issueDate = input.issueDate ?? today();

      const fiscal = input.legalEntityId
        ? await this.resolveFiscal(tx, input.legalEntityId, issueDate, input.taxCode, input.lines)
        : null;

      const net = fiscal ? fiscal.totals.subtotalNet : input.lines.reduce((s, l) => s + round2(l.quantity * l.unitPrice), 0);
      const taxRate = fiscal ? fiscal.taxCode.rate : (input.taxRate ?? 0);
      const tax = fiscal ? fiscal.totals.taxAmount : round2((net * taxRate) / 100);
      const total = fiscal ? fiscal.totals.grandTotal : round2(net + tax);
      const currency = input.currency ?? (fiscal ? fiscal.legalEntity.defaultCurrency : client.currency);
      const esfStatus: string = fiscal && fiscal.legalEntity.vatRegistered && fiscal.profile.config.eInvoice.required
        ? 'draft'
        : 'not_required';

      const row = await tx.one<{ id: string }>(
        `INSERT INTO invoices (branch_id, client_id, job_id, invoice_number, currency, amount_net, tax_rate,
                               tax_amount, amount_total, issue_date, due_date, notes, created_by,
                               legal_entity_id, jurisdiction_country_code, jurisdiction_profile_id,
                               jurisdiction_profile_version, tax_code, is_legacy_fiscal, esf_status)
         VALUES ($1, $2, $3, next_doc_number($1, 'I'), $4, $5, $6, $7, $8, $9::date, $10::date, $11, $12,
                 $13, $14, $15, $16, $17, $18, $19::esf_status)
         RETURNING id`,
        [
          client.branch_id, input.clientId, input.jobId ?? null, currency, net, taxRate, tax, total,
          issueDate, input.dueDate ?? null, input.notes ?? null, user.id,
          fiscal?.legalEntity.id ?? null, fiscal?.profile.countryCode ?? null, fiscal?.profile.id ?? null,
          fiscal?.profile.profileVersion ?? null, fiscal?.taxCode.code ?? null, !fiscal, esfStatus,
        ],
      );
      await tx.exec(
        `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price, sort_order)
         SELECT $1, l.description, l.quantity, l.unit_price, l.ord
         FROM jsonb_to_recordset($2::jsonb) AS l(description text, quantity numeric, unit_price numeric, ord int)`,
        [row!.id, JSON.stringify(input.lines.map((l, i) => ({
          description: l.description, quantity: l.quantity, unit_price: l.unitPrice, ord: (i + 1) * 10,
        })))],
      );
      const invoice = await this.load(tx, row!.id);
      await this.audit.record(tx, user, {
        action: 'invoice.create',
        entityType: 'invoice',
        entityId: invoice.id,
        entityLabel: invoice.invoiceNumber,
        branchId: client.branch_id,
        after: {
          status: invoice.status,
          currency: invoice.currency,
          amountTotal: invoice.amountTotal,
          clientId: invoice.clientId,
          jobId: invoice.jobId,
          ...(fiscal ? { legalEntityId: fiscal.legalEntity.id, taxCode: fiscal.taxCode.code } : {}),
        },
      });
      return invoice;
    });
  }

  /** Loads the legal entity and resolves the jurisdiction profile in force on `issueDate` — the
   *  opt-in fiscal path. Throws rather than silently falling back when the country has no
   *  verified profile (compliance_config_required) or the tax code doesn't apply. */
  private async resolveFiscal(
    tx: Tx,
    legalEntityId: string,
    issueDate: string,
    requestedTaxCode: string | undefined,
    lines: InvoiceLineInput[],
  ) {
    const row = await tx.one<{
      id: string; country_code: string; legal_name: string; default_currency: string;
      default_tax_code: string | null; vat_registered: boolean; is_active: boolean;
    }>(
      `SELECT le.id, c.code AS country_code, le.legal_name, le.default_currency, le.default_tax_code,
              le.vat_registered, le.is_active
       FROM legal_entities le JOIN countries c ON c.id = le.country_id
       WHERE le.id = $1`,
      [legalEntityId],
    );
    if (!row) throw new NotFoundException('Legal entity not found');
    if (!row.is_active) throw new BadRequestException('This legal entity is not active');

    const profile = await this.jurisdictionProfiles.resolve(tx, row.country_code, issueDate);
    if (!profile) {
      throw new BadRequestException(
        `No verified fiscal/compliance profile for ${row.country_code} on ${issueDate} ` +
          `(compliance_config_required) — cannot build a fiscal invoice for this legal entity yet.`,
      );
    }
    const legalEntity: Pick<LegalEntity, 'id' | 'defaultCurrency' | 'vatRegistered' | 'defaultTaxCode'> = {
      id: row.id,
      defaultCurrency: row.default_currency,
      vatRegistered: row.vat_registered,
      defaultTaxCode: row.default_tax_code,
    };
    const taxCode = resolveTaxCode(profile.config, legalEntity, requestedTaxCode);
    const totals = computeFiscalTotals(lines, taxCode.rate);
    return { legalEntity, profile, taxCode, totals };
  }

  /** Draft → issued: revenue and receivable hit the ledger, and — for a fiscal invoice — the
   *  immutable snapshot is taken (see buildFiscalSnapshot). */
  issue(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const inv = await this.lock(tx, id);
      if (inv.status !== 'draft') throw new ConflictException(`Invoice is already ${inv.status}`);
      const snapshot = await this.buildFiscalSnapshot(tx, id, inv);
      await tx.exec(
        `UPDATE invoices SET status = 'issued', fiscal_snapshot = $2::jsonb WHERE id = $1`,
        [id, snapshot ? JSON.stringify(snapshot) : null],
      );
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
      await this.audit.record(tx, user, {
        action: 'invoice.issue',
        entityType: 'invoice',
        entityId: id,
        entityLabel: inv.invoice_number,
        branchId: inv.branch_id,
        before: { status: inv.status },
        after: { status: 'issued' },
        metadata: { currency: inv.currency, amountTotal: Number(inv.amount_total) },
      });
      return this.load(tx, id);
    });
  }

  /**
   * Registers a (partial) payment: cash up, receivable down.
   *
   * Unchanged in behavior since before PHASE 8 — same signature, same clamping to what is due,
   * same ledger shape. It now goes through `PaymentsService`, which also gives this payment an
   * id, a method and a reference, and makes it show up in `GET /finance/payments`.
   */
  pay(user: AuthUser, id: string, amount: number, paidOn?: string) {
    if (!(amount > 0)) throw new BadRequestException('Payment amount must be positive');
    return this.db.tx(user, async (tx) => {
      const inv = await this.lock(tx, id);
      if (!['issued', 'partially_paid'].includes(inv.status)) {
        throw new ConflictException(`Cannot register a payment for an invoice in status ${inv.status}`);
      }
      const client = await tx.one<{ client_id: string }>('SELECT client_id FROM invoices WHERE id = $1', [id]);
      const due = round2(Number(inv.amount_total) - Number(inv.amount_paid));
      const paid = round2(Math.min(amount, due));

      await this.paymentsService.create(tx, user, {
        branchId: inv.branch_id,
        direction: 'inbound',
        clientId: client!.client_id,
        currency: inv.currency,
        amount: paid,
        paymentDate: paidOn ?? today(),
        allocations: [{ invoiceId: id, amount: paid }],
      });

      const after = await this.load(tx, id);
      await this.audit.record(tx, user, {
        action: 'invoice.pay',
        entityType: 'invoice',
        entityId: id,
        entityLabel: inv.invoice_number,
        branchId: inv.branch_id,
        before: { status: inv.status, amountPaid: Number(inv.amount_paid) },
        after: { status: after.status, amountPaid: after.amountPaid },
        metadata: { currency: inv.currency, amountApplied: paid },
      });
      return after;
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

  /** Drafts are archived, never destroyed: the number was allocated and stays accounted for. */
  remove(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const inv = await this.lock(tx, id);
      if (inv.status !== 'draft') throw new ConflictException('Only draft invoices can be deleted');
      await tx.exec('UPDATE invoices SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [id, user.id]);
      await this.audit.record(tx, user, {
        action: 'invoice.delete',
        entityType: 'invoice',
        entityId: id,
        entityLabel: inv.invoice_number,
        branchId: inv.branch_id,
        before: { status: inv.status, amountTotal: inv.amount_total },
      });
    }, { includeArchived: true });
  }

  private async lock(tx: Tx, id: string) {
    const inv = await tx.one<{
      branch_id: string; client_id: string; currency: string; status: InvoiceStatus; invoice_number: string;
      amount_total: string; amount_paid: string; amount_net: string; tax_amount: string; tax_rate: string;
      issue_date: string; legal_entity_id: string | null; jurisdiction_profile_id: string | null;
      jurisdiction_profile_version: number | null; jurisdiction_country_code: string | null; tax_code: string | null;
    }>(
      `SELECT branch_id, client_id, currency, status, invoice_number, amount_total, amount_paid, amount_net,
              tax_amount, tax_rate, to_char(issue_date, 'YYYY-MM-DD') AS issue_date,
              legal_entity_id, jurisdiction_profile_id, jurisdiction_profile_version, jurisdiction_country_code, tax_code
       FROM invoices WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!inv) throw new NotFoundException('Invoice not found');
    return inv;
  }

  /**
   * Immutable snapshot taken at ISSUE time (not at creation): legal entity, jurisdiction profile
   * version, seller/buyer fiscal data, per-line net/tax/gross and totals, numbering context, bank
   * and e-invoice details — everything section 7 of the compliance spec asks an invoice to carry
   * forward on its own, so a later edit to the legal entity or a new jurisdiction profile version
   * can never change what an already-issued invoice says it charged.
   */
  private async buildFiscalSnapshot(
    tx: Tx,
    id: string,
    inv: { legal_entity_id: string | null; jurisdiction_profile_id: string | null; jurisdiction_country_code: string | null;
           jurisdiction_profile_version: number | null; tax_code: string | null; tax_rate: string; currency: string;
           issue_date: string; invoice_number: string; client_id: string },
  ): Promise<FiscalSnapshot | null> {
    if (!inv.legal_entity_id || !inv.jurisdiction_profile_id) return null;
    const legalEntity = (await tx.one<{
      legal_name: string; legal_address: string | null; fiscal_identifier_type: string | null;
      fiscal_identifier: string | null; vat_registered: boolean; vat_registration_number: string | null;
      bank_name: string | null; bank_account: string | null; bank_swift: string | null;
    }>(
      `SELECT legal_name, legal_address, fiscal_identifier_type, fiscal_identifier, vat_registered,
              vat_registration_number, bank_name, bank_account, bank_swift
       FROM legal_entities WHERE id = $1`,
      [inv.legal_entity_id],
    ))!;
    const profile = (await tx.one<{ config: import('@gsi/shared-types').JurisdictionProfileConfig; source_notes: string | null }>(
      `SELECT config, source_notes FROM jurisdiction_profiles WHERE id = $1`,
      [inv.jurisdiction_profile_id],
    ))!;
    const buyer = (await tx.one<{ name: string; address: string | null; tax_id: string | null }>(
      `SELECT name, address, tax_id FROM clients WHERE id = $1`,
      [inv.client_id],
    ))!;
    const lineRows = await tx.many<{ description: string; quantity: number; unit_price: number }>(
      `SELECT description, quantity::float8 AS quantity, unit_price::float8 AS unit_price
       FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order`,
      [id],
    );
    const taxRate = Number(inv.tax_rate);
    const totals = computeFiscalTotals(
      lineRows.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unit_price })),
      taxRate,
    );
    const taxCodeDef = profile.config.taxCodes.find((c) => c.code === inv.tax_code);

    return {
      legalEntity: {
        id: inv.legal_entity_id,
        legalName: legalEntity.legal_name,
        legalAddress: legalEntity.legal_address,
        fiscalIdentifierType: legalEntity.fiscal_identifier_type,
        fiscalIdentifier: legalEntity.fiscal_identifier,
        vatRegistered: legalEntity.vat_registered,
        vatRegistrationNumber: legalEntity.vat_registration_number,
        bankName: legalEntity.bank_name,
        bankAccount: legalEntity.bank_account,
        bankSwift: legalEntity.bank_swift,
      },
      buyer: { name: buyer.name, address: buyer.address, fiscalIdentifier: buyer.tax_id },
      jurisdiction: {
        countryCode: inv.jurisdiction_country_code!,
        profileId: inv.jurisdiction_profile_id,
        profileVersion: inv.jurisdiction_profile_version!,
        sourceNotes: profile.source_notes,
      },
      taxCode: inv.tax_code!,
      taxCodeLabel: taxCodeDef?.label ?? inv.tax_code!,
      taxRate,
      supplyDate: inv.issue_date,
      documentCurrency: inv.currency,
      lines: totals.lines,
      subtotalNet: totals.subtotalNet,
      taxAmount: totals.taxAmount,
      grandTotal: totals.grandTotal,
      numberingContext: { invoiceNumber: inv.invoice_number },
      eInvoice: { required: profile.config.eInvoice.required, system: profile.config.eInvoice.system },
      snapshotTakenAt: new Date().toISOString(),
    };
  }
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export const isHq = (user: AuthUser) => user.scope === 'global';

function n(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}

/** Default analytics window: the last 12 calendar months. */
function defaultFrom(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 11);
  return d.toISOString().slice(0, 10);
}
