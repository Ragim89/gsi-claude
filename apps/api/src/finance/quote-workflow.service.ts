import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  AuthUser,
  Quote,
  QuoteAction,
  QuoteGuard,
  QuoteStatus,
  QuoteTransition,
  quoteTransitionFor,
  QUOTE_WORKFLOW,
} from '@gsi/shared-types';
import { Tx } from '../db/db.service';
import { AuditService } from '../common/audit.service';

export interface QuoteTransitionInput {
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

const label = (s: QuoteStatus) => s.replace(/_/g, ' ');

/**
 * The only thing that writes `quotes.status`.
 *
 * Same shape as JobWorkflowService/ReportWorkflowService/InspectionWorkflowService/
 * SampleWorkflowService/LabWorkflowService: permission → transition legality → reason →
 * guards → write → history → audit, all inside the caller's transaction.
 */
@Injectable()
export class QuoteWorkflowService {
  constructor(private readonly audit: AuditService) {}

  /** What this user may do with this quote right now — offered to the interface as buttons. */
  available(user: AuthUser, quote: Quote): QuoteAction[] {
    return QUOTE_WORKFLOW.filter(
      (t) =>
        t.from.includes(quote.status) &&
        (user.permissions?.includes(t.permission) ?? false) &&
        (t.guards ?? []).every((g) => !this.syncGuardProblem(g, quote)),
    ).map((t) => t.action);
  }

  async apply(
    tx: Tx,
    user: AuthUser,
    quote: Quote,
    action: QuoteAction,
    input: QuoteTransitionInput = {},
  ): Promise<QuoteStatus> {
    const transition = quoteTransitionFor(action);
    if (!transition) throw new BadRequestException(`Unknown action "${action}"`);

    if (!user.permissions?.includes(transition.permission)) {
      throw new ForbiddenException(`Requires permission: ${transition.permission}`);
    }
    if (!transition.from.includes(quote.status)) {
      throw new ConflictException(
        `A quote that is ${label(quote.status)} cannot be ${action.replace(/_/g, ' ')}d` +
          ` (allowed from: ${transition.from.map(label).join(', ')})`,
      );
    }
    if (transition.requiresReason && !input.reason?.trim()) {
      throw new BadRequestException(`A reason is required to ${action.replace(/_/g, ' ')} a quote`);
    }

    await this.checkGuards(tx, quote, transition);

    const isDecision = action === 'accept' || action === 'reject' || action === 'expire';
    const sets = [`status = '${transition.to}'::quote_status`];
    if (action === 'send') sets.push('sent_at = now()');
    if (isDecision) sets.push('decided_at = now()', 'decision_note = $2');
    await tx.exec(
      `UPDATE quotes SET ${sets.join(', ')} WHERE id = $1`,
      isDecision ? [quote.id, input.reason?.trim() || null] : [quote.id],
    );

    await tx.exec(
      `INSERT INTO quote_status_history (quote_id, branch_id, from_status, to_status, changed_by, reason, metadata)
       VALUES ($1, $2, $3::quote_status, $4::quote_status, $5, $6, $7::jsonb)`,
      [quote.id, quote.branchId, quote.status, transition.to, user.id,
       input.reason?.trim() || null, JSON.stringify({ action, ...input.metadata })],
    );

    await this.audit.record(tx, user, {
      action: `quote.${action}`,
      entityType: 'quote',
      entityId: quote.id,
      entityLabel: quote.quoteNumber,
      branchId: quote.branchId,
      before: { status: quote.status },
      after: { status: transition.to },
      ...(input.reason ? { metadata: { reason: input.reason } } : {}),
    });

    return transition.to;
  }

  private async checkGuards(tx: Tx, quote: Quote, transition: QuoteTransition): Promise<void> {
    for (const guard of transition.guards ?? []) {
      const problem = await this.guardProblem(tx, guard, quote);
      if (problem) throw new BadRequestException(problem);
    }
  }

  private async guardProblem(tx: Tx, guard: QuoteGuard, quote: Quote): Promise<string | null> {
    switch (guard) {
      case 'hasLines': {
        const row = await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM quote_lines WHERE quote_id = $1', [quote.id]);
        return (row?.n ?? 0) > 0 ? null : 'it has no lines yet';
      }
      default:
        return null;
    }
  }

  /** Synchronous best-effort check for `available()`, when the quote already carries its lines. */
  private syncGuardProblem(guard: QuoteGuard, quote: Quote): string | null {
    switch (guard) {
      case 'hasLines':
        return (quote.lines?.length ?? 0) > 0 ? null : 'it has no lines yet';
      default:
        return null;
    }
  }
}
