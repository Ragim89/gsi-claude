import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { NotificationType } from '@gsi/shared-types';
import { DomainEntityType, JobEvent, JobEventsService } from '../operations/job-events.service';
import { NotificationsService } from './notifications.service';

interface Rule {
  entityType: DomainEntityType;
  to: string;
  notificationType: NotificationType;
  title: (event: JobEvent) => string;
  /** Permission held by whoever should be told, in the branch the event happened in. */
  permission: string;
}

/**
 * PHASE 10 — turns the seam `JobEventsService` already offered (see its own doc comment) into
 * rows in `notifications`. One rule per (entity type, target status): a status a role-holder
 * needs to act on next.
 *
 * `job.assigned` and a report reaching `issued` are handled outside this table because their
 * recipient is named on the event itself (`userId`) — the assignee or the author, not "whoever
 * holds a permission in the branch".
 */
const RULES: Rule[] = [
  {
    entityType: 'sample', to: 'received_by_lab', notificationType: 'sample.received',
    title: (e) => `Sample ${e.jobNumber} received by the laboratory`, permission: 'sample.accept_lab',
  },
  {
    entityType: 'test_request', to: 'under_review', notificationType: 'lab_result.awaiting_review',
    title: (e) => `Result awaiting review: ${e.jobNumber}`, permission: 'lab.result.review',
  },
  {
    entityType: 'report', to: 'under_review', notificationType: 'report.awaiting_review',
    title: (e) => `Report awaiting review: ${e.jobNumber}`, permission: 'report.review',
  },
  {
    entityType: 'report', to: 'approved', notificationType: 'report.awaiting_issue',
    title: (e) => `Report approved, awaiting issue: ${e.jobNumber}`, permission: 'report.issue',
  },
];

@Injectable()
export class NotificationEventsListener implements OnModuleInit {
  private readonly logger = new Logger(NotificationEventsListener.name);

  constructor(
    private readonly events: JobEventsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.events.on('*', (event) => {
      this.handle(event).catch((err) => this.logger.warn(`notification dispatch failed: ${(err as Error).message}`));
    });
  }

  private async handle(event: JobEvent): Promise<void> {
    if (event.type === 'job.assigned' && event.userId) {
      await this.notifications.notify(null, {
        userId: event.userId,
        branchId: event.branchId,
        type: 'job.assigned',
        title: `Job assigned: ${event.jobNumber}`,
        entityType: 'job',
        entityId: event.jobId,
        entityLabel: event.jobNumber,
      });
      return;
    }

    if (event.type !== 'job.status_changed') return;
    const entityType = event.entityType ?? 'job';

    if (entityType === 'report' && event.to === 'issued' && event.userId) {
      await this.notifications.notify(null, {
        userId: event.userId,
        branchId: event.branchId,
        type: 'report.issued',
        title: `Report issued: ${event.jobNumber}`,
        entityType: 'report',
        entityId: event.jobId,
        entityLabel: event.jobNumber,
      });
      return;
    }

    const rule = RULES.find((r) => r.entityType === entityType && r.to === event.to);
    if (!rule) return;

    const recipients = await this.notifications.usersWithPermission(event.branchId, rule.permission);
    await Promise.all(
      recipients.map((userId) =>
        this.notifications.notify(null, {
          userId,
          branchId: event.branchId,
          type: rule.notificationType,
          title: rule.title(event),
          entityType,
          entityId: event.jobId,
          entityLabel: event.jobNumber,
        }),
      ),
    );
  }
}
