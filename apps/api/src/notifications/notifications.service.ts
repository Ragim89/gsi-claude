import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter } from 'events';
import { Observable } from 'rxjs';
import { AuthUser, NotificationList, NotificationRecord, NotificationType } from '@gsi/shared-types';
import { DbService } from '../db/db.service';

const row = (r: Record<string, unknown>): NotificationRecord => ({
  id: String(r.id),
  type: r.type as NotificationType,
  title: String(r.title),
  body: r.body ? String(r.body) : null,
  entityType: r.entityType ? String(r.entityType) : null,
  entityId: r.entityId ? String(r.entityId) : null,
  entityLabel: r.entityLabel ? String(r.entityLabel) : null,
  readAt: r.readAt ? String(r.readAt) : null,
  createdAt: String(r.createdAt),
});

/**
 * Per-user notifications (PHASE 10). Reading and marking-read run under the caller's own Row-
 * Level Security (`notifications_own_read`/`notifications_own_update` in 024_notifications.sql):
 * a user can only ever see or touch their own row, so there is no server-side "whose inbox is
 * this" check to get wrong.
 *
 * Writing crosses a user boundary on purpose (the actor who caused an event is never its
 * recipient), so it goes through `create_notification()`, a narrow SECURITY DEFINER function —
 * see the migration for why that is safer here than a permissive INSERT policy.
 */
@Injectable()
export class NotificationsService {
  /** Per-user "something changed" pings for the live badge — the payload is a signal to refetch, not the data itself. */
  private readonly emitter = new EventEmitter();

  constructor(private readonly db: DbService) {}

  stream(userId: string): Observable<{ type: NotificationType }> {
    return new Observable((subscriber) => {
      const listener = (payload: { type: NotificationType }) => subscriber.next(payload);
      this.emitter.on(userId, listener);
      return () => this.emitter.off(userId, listener);
    });
  }

  async list(user: AuthUser, unreadOnly = false): Promise<NotificationList> {
    return this.db.tx(user, async (tx) => {
      const rows = await tx.many<Record<string, unknown>>(
        `SELECT id::text, type, title, body, entity_type AS "entityType", entity_id::text AS "entityId",
                entity_label AS "entityLabel", read_at AS "readAt", created_at AS "createdAt"
         FROM notifications WHERE user_id = $1 ${unreadOnly ? 'AND read_at IS NULL' : ''}
         ORDER BY created_at DESC LIMIT 100`,
        [user.id],
      );
      const unread = await tx.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
        [user.id],
      );
      return { items: rows.map(row), unreadCount: unread?.n ?? 0 };
    });
  }

  async markRead(user: AuthUser, id: string): Promise<void> {
    const affected = await this.db.tx(user, (tx) =>
      tx.exec('UPDATE notifications SET read_at = now() WHERE id = $1 AND read_at IS NULL', [id]),
    );
    if (!affected) {
      // Already read, or not this user's — RLS makes those indistinguishable from here, which is the point.
      const exists = await this.db.tx(user, (tx) => tx.one('SELECT 1 FROM notifications WHERE id = $1', [id]));
      if (!exists) throw new NotFoundException('Notification not found');
    }
  }

  async markAllRead(user: AuthUser): Promise<void> {
    await this.db.tx(user, (tx) => tx.exec('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user.id]));
  }

  /** One recipient. Runs as `actor` (whoever's transaction noticed the event); the function itself is what crosses the boundary. */
  async notify(
    actor: AuthUser | null,
    input: {
      userId: string; branchId: string; type: NotificationType; title: string; body?: string | null;
      entityType?: string | null; entityId?: string | null; entityLabel?: string | null;
    },
  ): Promise<void> {
    await this.db.tx(actor, (tx) =>
      tx.exec('SELECT create_notification($1,$2,$3,$4,$5,$6,$7,$8)', [
        input.userId, input.branchId, input.type, input.title, input.body ?? null,
        input.entityType ?? null, input.entityId ?? null, input.entityLabel ?? null,
      ]),
    );
    this.emitter.emit(input.userId, { type: input.type });
  }

  /**
   * Every active user in `branchId` holding `permission` — the standard way this module picks
   * recipients for a role-based event. Goes through `users_with_permission()` (SECURITY
   * DEFINER): the caller here has no "current user" whose own RLS scope would make `users` and
   * `role_permissions` visible, the same reason `create_notification()` exists below.
   */
  async usersWithPermission(branchId: string, permission: string): Promise<string[]> {
    const rows = await this.db.tx(null, (tx) =>
      tx.many<{ id: string }>('SELECT id::text FROM users_with_permission($1, $2) AS id', [branchId, permission]),
    );
    return rows.map((r) => r.id);
  }

  /** True if a notification of this type already exists for this entity — the cron sweeps' dedupe. */
  async alreadyNotified(type: NotificationType, entityId: string): Promise<boolean> {
    const found = await this.db.tx(null, (tx) => tx.one<{ notification_exists: boolean }>('SELECT notification_exists($1, $2)', [type, entityId]));
    return !!found?.notification_exists;
  }
}
