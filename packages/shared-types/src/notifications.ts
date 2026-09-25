/**
 * PHASE 10 — Notification centre.
 *
 * Every row belongs to exactly one user: notifications are not a shared inbox, they are each
 * person's own list of things that need their attention. `type` is a closed vocabulary so the
 * frontend can pick an icon and a link without parsing free text.
 */

export const NOTIFICATION_TYPES = [
  'job.assigned',
  'inspection.due',
  'sample.received',
  'lab_result.awaiting_review',
  'report.awaiting_review',
  'report.awaiting_issue',
  'report.issued',
  'invoice.overdue',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotificationRecord {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  entityLabel: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationList {
  items: NotificationRecord[];
  unreadCount: number;
}
