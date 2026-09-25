import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DbService } from '../db/db.service';
import { NotificationsService } from './notifications.service';

/**
 * The two notification types that are not the consequence of an action someone took, but of
 * time passing — a scheduled inspection getting close, an invoice's due date slipping by. Both
 * run hourly and dedupe against `notifications` itself (`notification_exists`), so a job that
 * has already been flagged once is not flagged again on every tick.
 */
@Injectable()
export class NotificationsCronService {
  private readonly logger = new Logger(NotificationsCronService.name);

  constructor(
    private readonly db: DbService,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweepInspectionsDue(): Promise<void> {
    const due = await this.db.tx(null, (tx) =>
      tx.many<{ inspection_id: string; branch_id: string; job_number: string; scheduled_start: string }>(
        'SELECT * FROM inspections_due_soon(24)',
      ),
    );
    for (const inspection of due) {
      if (await this.notifications.alreadyNotified('inspection.due', inspection.inspection_id)) continue;
      const assignees = await this.db.tx(null, (tx) =>
        tx.many<{ inspection_assignees: string }>('SELECT * FROM inspection_assignees($1)', [inspection.inspection_id]),
      );
      await Promise.all(
        assignees.map((a) =>
          this.notifications.notify(null, {
            userId: a.inspection_assignees,
            branchId: inspection.branch_id,
            type: 'inspection.due',
            title: `Inspection due soon: ${inspection.job_number}`,
            body: `Scheduled for ${new Date(inspection.scheduled_start).toISOString()}`,
            entityType: 'inspection',
            entityId: inspection.inspection_id,
            entityLabel: inspection.job_number,
          }),
        ),
      );
    }
    if (due.length) this.logger.log(`inspections due soon: ${due.length} checked`);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async sweepInvoicesOverdue(): Promise<void> {
    const overdue = await this.db.tx(null, (tx) =>
      tx.many<{ invoice_id: string; branch_id: string; invoice_number: string }>('SELECT * FROM invoices_newly_overdue()'),
    );
    for (const invoice of overdue) {
      if (await this.notifications.alreadyNotified('invoice.overdue', invoice.invoice_id)) continue;
      const recipients = await this.notifications.usersWithPermission(invoice.branch_id, 'invoice.remind');
      await Promise.all(
        recipients.map((userId) =>
          this.notifications.notify(null, {
            userId,
            branchId: invoice.branch_id,
            type: 'invoice.overdue',
            title: `Invoice overdue: ${invoice.invoice_number}`,
            entityType: 'invoice',
            entityId: invoice.invoice_id,
            entityLabel: invoice.invoice_number,
          }),
        ),
      );
    }
    if (overdue.length) this.logger.log(`invoices overdue: ${overdue.length} checked`);
  }
}
