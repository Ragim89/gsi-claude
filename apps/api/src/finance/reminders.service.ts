import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser, InvoiceReminder } from '@gsi/shared-types';
import { DbService } from '../db/db.service';
import { AuditService } from '../common/audit.service';

/**
 * Overdue-invoice reminders — a hook, not a send.
 *
 * No e-mail/notification adapter exists yet (that is PHASE 10). This only logs that someone
 * chased an invoice: who, when, and what was said. It is the seam PHASE 10 wires an actual
 * send into, not a simulated one — the interface calls this action "log", not "send".
 */
@Injectable()
export class RemindersService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
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

  log(user: AuthUser, invoiceId: string, note?: string | null) {
    return this.db.tx(user, async (tx) => {
      const inv = await tx.one<{ branch_id: string; invoice_number: string }>(
        'SELECT branch_id, invoice_number FROM invoices WHERE id = $1 AND deleted_at IS NULL',
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

      return { id: row!.id };
    });
  }
}
