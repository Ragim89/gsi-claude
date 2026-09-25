import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuthUser, InvoiceReminder } from '@gsi/shared-types';
import { DbService } from '../db/db.service';
import { AuditService } from '../common/audit.service';
import { EMAIL_ADAPTER, EmailAdapter } from '../email/email.interface';

/**
 * Overdue-invoice reminders.
 *
 * `log` is still what it always was: a hook, not a simulated send — it records that someone
 * chased an invoice, who, when, and what was said, whether or not any e-mail exists to send.
 * PHASE 10 wires the actual send into that same call, through the provider-neutral adapter: if
 * the client has a primary contact with an e-mail address, that address gets the note too. A
 * failed or unconfigured send never blocks the log — the record that someone followed up matters
 * more than the delivery receipt.
 */
@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(EMAIL_ADAPTER) private readonly email: EmailAdapter,
  ) {}

  list(user: AuthUser, invoiceId: string) {
    return this.db.tx(user, (tx) =>
      tx.many<InvoiceReminder>(
        `SELECT r.id::text, r.invoice_id AS "invoiceId", r.note, r.sent_by AS "sentBy",
                u.full_name AS "sentByName", r.created_at AS "createdAt"
         FROM invoice_reminders r LEFT JOIN users u ON u.id = r.sent_by
         WHERE r.invoice_id = $1 ORDER BY r.created_at DESC`,
        [invoiceId],
      ),
    );
  }

  async log(user: AuthUser, invoiceId: string, note?: string | null) {
    const result = await this.db.tx(user, async (tx) => {
      const inv = await tx.one<{ branch_id: string; invoice_number: string; client_name: string }>(
        `SELECT i.branch_id, i.invoice_number, c.name AS client_name
         FROM invoices i JOIN clients c ON c.id = i.client_id
         WHERE i.id = $1 AND i.deleted_at IS NULL`,
        [invoiceId],
      );
      if (!inv) throw new NotFoundException('Invoice not found');

      const row = await tx.one<{ id: string }>(
        `INSERT INTO invoice_reminders (invoice_id, branch_id, note, sent_by) VALUES ($1, $2, $3, $4) RETURNING id::text`,
        [invoiceId, inv.branch_id, note?.trim() || null, user.id],
      );

      await this.audit.record(tx, user, {
        action: 'invoice.remind',
        entityType: 'invoice',
        entityId: invoiceId,
        entityLabel: inv.invoice_number,
        branchId: inv.branch_id,
        metadata: note ? { note } : undefined,
      });

      const contact = await tx.one<{ email: string | null }>(
        `SELECT cc.email FROM invoices i
         JOIN client_contacts cc ON cc.client_id = i.client_id AND cc.is_primary AND cc.deleted_at IS NULL
         WHERE i.id = $1`,
        [invoiceId],
      );

      return { id: row!.id, invoiceNumber: inv.invoice_number, clientName: inv.client_name, contactEmail: contact?.email ?? null };
    });

    if (result.contactEmail) {
      await this.email
        .send({
          to: result.contactEmail,
          subject: `Payment reminder — invoice ${result.invoiceNumber}`,
          text: note?.trim()
            ? `Dear ${result.clientName},\n\n${note.trim()}\n\nInvoice: ${result.invoiceNumber}`
            : `Dear ${result.clientName},\n\nThis is a reminder that invoice ${result.invoiceNumber} is outstanding.`,
        })
        .catch((err) => this.logger.warn(`reminder e-mail not sent: ${(err as Error).message}`));
    }

    return { id: result.id };
  }
}
