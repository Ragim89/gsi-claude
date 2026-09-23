import { Injectable, Logger } from '@nestjs/common';
import type { AuthUser } from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';

export interface AuditEvent {
  /** A dotted verb from the permission vocabulary: job.approve, invoice.pay, user.manage. */
  action: string;
  entityType?: string;
  entityId?: string | null;
  /** How a person recognises the record: job number, invoice number, client name. */
  entityLabel?: string | null;
  branchId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

/** Per-request details the middleware collects; passed in where they are known. */
export interface AuditContext {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Writes the audit trail.
 *
 * Two ways to call it:
 *  - `record(tx, …)` inside an existing transaction, so the entry lands exactly when the
 *    change does — an approved report and its audit entry commit together or not at all;
 *  - `log(user, …)` for events with no transaction of their own, such as signing in.
 *
 * A failure to write an entry never fails the operation that triggered it: losing an audit
 * line is bad, losing a customer's invoice because of it is worse. Failures are logged loudly.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly db: DbService) {}

  async record(tx: Tx, user: AuthUser | null, event: AuditEvent, ctx: AuditContext = {}): Promise<void> {
    try {
      await tx.exec(
        `INSERT INTO audit_logs (user_id, user_email, user_role, branch_id, action, entity_type,
                                 entity_id, entity_label, before_data, after_data, metadata,
                                 ip_address, user_agent, request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::inet,$13,$14)`,
        [
          user?.id ?? null,
          user?.email ?? null,
          user?.roles?.join(',') ?? user?.role ?? null,
          event.branchId ?? user?.branchId ?? null,
          event.action,
          event.entityType ?? null,
          event.entityId ?? null,
          event.entityLabel ?? null,
          event.before ? JSON.stringify(event.before) : null,
          event.after ? JSON.stringify(event.after) : null,
          event.metadata ? JSON.stringify(event.metadata) : null,
          ctx.ip ?? null,
          ctx.userAgent?.slice(0, 500) ?? null,
          ctx.requestId ?? null,
        ],
      );
    } catch (err) {
      this.logger.error(`could not write audit entry for ${event.action}: ${(err as Error).message}`);
    }
  }

  /** Same, but opening its own transaction. */
  async log(user: AuthUser | null, event: AuditEvent, ctx: AuditContext = {}): Promise<void> {
    try {
      await this.db.tx(user, (tx) => this.record(tx, user, event, ctx));
    } catch (err) {
      this.logger.error(`could not write audit entry for ${event.action}: ${(err as Error).message}`);
    }
  }

  /**
   * Only the fields that actually changed, so an entry stays readable and does not copy a
   * whole row on every edit.
   */
  static diff(
    before: Record<string, unknown> | null | undefined,
    after: Record<string, unknown> | null | undefined,
  ): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
    if (!before || !after) return null;
    const changedBefore: Record<string, unknown> = {};
    const changedAfter: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const a = before[key];
      const b = after[key];
      if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) {
        changedBefore[key] = a ?? null;
        changedAfter[key] = b ?? null;
      }
    }
    return Object.keys(changedAfter).length ? { before: changedBefore, after: changedAfter } : null;
  }
}
