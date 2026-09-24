import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  AuthUser,
  INSPECTION_WORKFLOW,
  Inspection,
  InspectionAction,
  InspectionGuard,
  InspectionStatus,
  InspectionTransition,
  inspectionTransitionFor,
} from '@gsi/shared-types';
import { Tx } from '../db/db.service';
import { AuditService } from '../common/audit.service';
import { JobEventsService } from '../operations/job-events.service';

export interface InspectionTransitionInput {
  reason?: string | null;
  metadata?: Record<string, unknown>;
  extraSet?: string;
  extraParams?: unknown[];
}

/**
 * The one place an inspection changes status — the same shape as JobWorkflowService, because
 * two different ways of doing the same thing is how a system starts contradicting itself.
 *
 * Authorise → validate the move → demand a reason where one is owed → check the business
 * rules → write the row, the history and the audit entry → announce it, all inside the
 * caller's transaction.
 */
@Injectable()
export class InspectionWorkflowService {
  constructor(private readonly audit: AuditService, private readonly events: JobEventsService) {}

  /** What this user may do with this inspection right now. */
  available(user: AuthUser, inspection: Inspection): InspectionAction[] {
    return INSPECTION_WORKFLOW.filter(
      (t) => t.from.includes(inspection.status) && (user.permissions?.includes(t.permission) ?? false),
    ).map((t) => t.action);
  }

  async apply(
    tx: Tx,
    user: AuthUser,
    inspection: Inspection,
    action: InspectionAction,
    input: InspectionTransitionInput = {},
  ): Promise<InspectionStatus> {
    const transition = inspectionTransitionFor(action);
    if (!transition) throw new BadRequestException(`Unknown action "${action}"`);

    if (!user.permissions?.includes(transition.permission)) {
      throw new ForbiddenException(`Requires permission: ${transition.permission}`);
    }
    if (!transition.from.includes(inspection.status)) {
      throw new ConflictException(
        `An inspection that is ${label(inspection.status)} cannot be ${pastTense(action)}` +
          ` (allowed from: ${transition.from.map(label).join(', ')})`,
      );
    }
    if (transition.requiresReason && !input.reason?.trim()) {
      throw new BadRequestException(`A reason is required to ${action.replace(/_/g, ' ')} an inspection`);
    }

    const target =
      action === 'resume' ? ((inspection.statusBeforeHold as InspectionStatus | null) ?? 'in_progress') : transition.to;

    await this.checkGuards(tx, inspection, transition);

    const sets = [`status = '${target}'::inspection_status`];
    if (action === 'hold') sets.push(`status_before_hold = '${inspection.status}'::inspection_status`);
    if (action === 'resume') sets.push('status_before_hold = NULL');
    // The stamps that belong to the move itself.
    if (action === 'start' && !inspection.actualStart) sets.push('actual_start = now()');
    if (action === 'complete') sets.push('actual_end = now()');
    if (action === 'approve') {
      sets.push('reviewed_by = $2', 'reviewed_at = now()');
      input = { ...input, extraParams: [user.id, ...(input.extraParams ?? [])] };
    }
    if (action === 'return' || action === 'reopen') {
      sets.push('review_comment = $2');
      input = { ...input, extraParams: [input.reason ?? null, ...(input.extraParams ?? [])] };
    }
    if (input.extraSet) sets.push(input.extraSet);

    await tx.exec(`UPDATE inspections SET ${sets.join(', ')} WHERE id = $1`, [
      inspection.id,
      ...(input.extraParams ?? []),
    ]);

    await tx.exec(
      `INSERT INTO inspection_status_history (inspection_id, branch_id, from_status, to_status, changed_by, reason, metadata)
       VALUES ($1, $2, $3::inspection_status, $4::inspection_status, $5, $6, $7::jsonb)`,
      [
        inspection.id,
        inspection.branchId,
        inspection.status,
        target,
        user.id,
        input.reason?.trim() || null,
        JSON.stringify({ action, ...input.metadata }),
      ],
    );

    await this.audit.record(tx, user, {
      action: `inspection.${action}`,
      entityType: 'inspection',
      entityId: inspection.id,
      entityLabel: inspection.inspectionNumber,
      branchId: inspection.branchId,
      before: { status: inspection.status },
      after: { status: target },
      metadata: { action, ...(input.reason ? { reason: input.reason } : {}), ...input.metadata },
    });

    this.events.emit({
      type: 'job.status_changed',
      jobId: inspection.jobId,
      jobNumber: inspection.inspectionNumber,
      branchId: inspection.branchId,
      actorId: user.id,
      reason: input.reason ?? null,
    });

    return target;
  }

  private async checkGuards(tx: Tx, inspection: Inspection, transition: InspectionTransition): Promise<void> {
    for (const guard of transition.guards ?? []) {
      const message = await this.checkGuard(tx, inspection, guard);
      if (message) throw new BadRequestException(`This inspection cannot be moved on: ${message}`);
    }
  }

  private async checkGuard(tx: Tx, inspection: Inspection, guard: InspectionGuard): Promise<string | null> {
    switch (guard) {
      case 'hasSchedule':
        return inspection.scheduledStart ? null : 'it has no scheduled start';
      case 'hasLead':
        return inspection.leadInspectorId ? null : 'it has no lead inspector';
      case 'hasConclusion':
        return inspection.conclusion?.trim() ? null : 'the conclusion is empty';
      case 'requiredChecklistDone': {
        const row = await tx.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM job_checklist_items
           WHERE inspection_id = $1 AND is_required AND result IS NULL`,
          [inspection.id],
        );
        const missing = row?.n ?? 0;
        return missing === 0 ? null : `${missing} required checklist item(s) still have no answer`;
      }
      default:
        return null;
    }
  }
}

function label(status: InspectionStatus): string {
  return status.replace(/_/g, ' ');
}

function pastTense(action: InspectionAction): string {
  const words: Record<InspectionAction, string> = {
    schedule: 'scheduled',
    start: 'started',
    complete: 'completed',
    submit_review: 'sent for review',
    return: 'returned for corrections',
    approve: 'approved',
    reopen: 'reopened',
    hold: 'put on hold',
    resume: 'resumed',
    cancel: 'cancelled',
  };
  return words[action];
}
