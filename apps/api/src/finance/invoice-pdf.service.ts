import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser, Branch, Invoice, InvoiceLine } from '@gsi/shared-types';
import { DbService } from '../db/db.service';
import { PdfService } from '../documents/pdf.service';
import { invoiceTemplate } from '../documents/templates/invoice-default';
import type { InvoiceTemplateData } from '../documents/templates/types';

const BRANCH_COLUMNS = `
  id, code, country, city, currency, locale, ui_locales AS "uiLocales", timezone,
  legal_name AS "legalName", address, phone, email, accreditation, is_hq AS "isHq",
  letterhead_template_id AS "letterheadTemplateId"`;

/**
 * Printable invoice on the branch letterhead, rendered on demand with the same
 * Chromium pipeline as inspection reports.
 *
 * ASSUMPTION: unlike reports, invoice PDFs are not archived in object storage — the invoice
 * record is the source of truth and the document can always be re-rendered from it. If
 * accounting requires an immutable copy (e-invoicing, e-fatura), store it like reports.
 */
@Injectable()
export class InvoicePdfService {
  constructor(private readonly db: DbService, private readonly pdf: PdfService) {}

  async render(user: AuthUser, id: string): Promise<{ pdf: Buffer; filename: string }> {
    const data = await this.db.tx(user, async (tx): Promise<InvoiceTemplateData> => {
      const invoice = await tx.one<Invoice>(
        `SELECT i.id, i.branch_id AS "branchId", i.client_id AS "clientId", i.job_id AS "jobId",
                j.job_number AS "jobNumber", j.type AS "serviceType", i.invoice_number AS "invoiceNumber",
                i.status, i.currency, i.amount_net::float8 AS "amountNet", i.tax_rate::float8 AS "taxRate",
                i.tax_amount::float8 AS "taxAmount", i.amount_total::float8 AS "amountTotal",
                i.amount_paid::float8 AS "amountPaid",
                to_char(i.issue_date, 'YYYY-MM-DD') AS "issueDate",
                to_char(i.due_date, 'YYYY-MM-DD') AS "dueDate",
                i.paid_at AS "paidAt", i.notes, i.created_at AS "createdAt"
         FROM invoices i LEFT JOIN inspection_jobs j ON j.id = i.job_id
         WHERE i.id = $1`,
        [id],
      );
      if (!invoice) throw new NotFoundException('Invoice not found');

      const branch = (await tx.one<Branch>(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE id = $1`, [invoice.branchId]))!;
      const organization = (await tx.one<InvoiceTemplateData['organization']>(
        `SELECT o.name, o.short_name AS "shortName", o.product_name AS "productName", o.logo_url AS "logoUrl"
         FROM branches b JOIN countries c ON c.id = b.country_id JOIN organizations o ON o.id = c.organization_id
         WHERE b.id = $1`,
        [invoice.branchId],
      ))!;
      const client = (await tx.one<InvoiceTemplateData['client']>(
        `SELECT name, address, tax_id AS "taxId", gafta_fosfa_ref AS "gaftaFosfaRef" FROM clients WHERE id = $1`,
        [invoice.clientId],
      ))!;
      const lines = await tx.many<InvoiceLine>(
        `SELECT id, invoice_id AS "invoiceId", description, quantity::float8 AS quantity,
                unit_price::float8 AS "unitPrice", amount::float8 AS amount, sort_order AS "sortOrder"
         FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order`,
        [id],
      );
      return { organization, branch, client, invoice, lines };
    });

    const pdf = await this.pdf.render(invoiceTemplate.html(data), { footerHtml: invoiceTemplate.footer(data) });
    return { pdf, filename: `${data.invoice.invoiceNumber}.pdf` };
  }
}
