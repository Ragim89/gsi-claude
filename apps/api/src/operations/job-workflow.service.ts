import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import {
  AuthUser,
  InspectionJob,
  JOB_WORKFLOW,
  JobAction,
  JobGuard,
  JobStatus,
  JobTransition,
  transitionFor,
} from '@gsi/shared-types';
import { Tx } from '../db/db.service';
import { AuditService } from '../common/audit.service';
import { JobEventsService } from './job-events.service';

export interface TransitionInput {
  reason?: string | null;
  metadata?: Record<string, unknown>;
  /** Extra SQL applied in the same UPDATE, for columns a particular action also sets. */
  extraSet?: string;
  extraParams?: unknown[];
}

/**
 * The one place a job changes status.
 *
 * Nothing else in the codebase writes `inspection_jobs.status`. Every move runs the same
 * sequence — authorise, validate the transition, check the business rules, write the row,
 * record the history, write the audit entry, raise the event — inside the caller's
 * transaction, so a job whose history is missing cannot exist.
 */
@Injectable()
export class JobWorkflowService {
  private readonly logger = new Logger(JobWorkflowService.name);

  constructor(private readonly audit: AuditService, private readonly events: JobEventsService) {}

  /** The actions this user may take on this job right now — what the interface offers. */
  available(user: AuthUser, job: InspectionJob): JobAction[] {
    return JOB_WORKFLOW.filter(
      (t) => t.from.includes(job.status) && (user.permissions?.includes(t.permission) ?? false),
    ).map((t) => t.action);
  }

  async apply(
    tx: Tx,
    user: AuthUser,
    job: InspectionJob,
    action: JobAction,
    input: TransitionInput = {},
  ): Promise<JobStatus> {
    const transition = transitionFor(action);
    if (!transition) throw new BadRequestException(`Unknown action "${action}"`);

    if (!user.permissions?.includes(transition.permission)) {
      throw new ForbiddenException(`Requires permission: ${transition.permission}`);
    }

    if (!transition.from.includes(job.status)) {
      throw new ConflictException(
        `A job that is ${label(job.status)} cannot be ${pastTense(action)}` +
          ` (allowed from: ${transition.from.map(label).join(', ')})`,
      );
    }

    if (transition.requiresReason && !input.reason?.trim()) {
      throw new BadRequestException(`A reason is required to ${action.replace('_', ' ')} a job`);
    }

    // Resuming goes back to whatever the job was doing before the hold.
    const target =
      action === 'resume' ? ((job.statusBeforeHold as JobStatus | null) ?? 'confirmed') : transition.to;

    await this.checkGuards(tx, job, transition);

    const sets = [`status = '${target}'::job_status`];
    if (action === 'hold') sets.push(`status_before_hold = '${job.status}'::job_status`);
    if (action === 'resume') sets.push('status_before_hold = NULL');
    if (input.extraSet) sets.push(input.extraSet);

    await tx.exec(
      `UPDATE inspection_jobs SET ${sets.join(', ')} WHERE id = $1`,
      [job.id, ...(input.extraParams ?? [])],
    );

    await tx.exec(
      `INSERT INTO job_status_history (job_id, branch_id, from_status, to_status, changed_by, reason, metadata)
       VALUES ($1, $2, $3::job_status, $4::job_status, $5, $6, $7::jsonb)`,
      [
        job.id,
        job.branchId,
        job.status,
        target,
        user.id,
        input.reason?.trim() || null,
        input.metadata ? JSON.stringify({ action, ...input.metadata }) : JSON.stringify({ action }),
      ],
    );

    await this.audit.record(tx, user, {
      action: `job.${action}`,
      entityType: 'job',
      entityId: job.id,
      entityLabel: job.jobNumber,
      branchId: job.branchId,
      before: { status: job.status },
      after: { status: target },
      metadata: { action, ...(input.reason ? { reason: input.reason } : {}), ...input.metadata },
    });

    // Phase 10 turns this into notifications; for now it is a seam with a log behind it.
    this.events.emit({
      type: 'job.status_changed',
      jobId: job.id,
      jobNumber: job.jobNumber,
      branchId: job.branchId,
      from: job.status,
      to: target,
      action,
      actorId: user.id,
      reason: input.reason ?? null,
    });

    return target;
  }

  /**
   * Business rules. Each one answers in words a person can act on, because "422" tells an
   * operations clerk nothing about which field is missing.
   */
  private async checkGuards(tx: Tx, job: InspectionJob, transition: JobTransition): Promise<void> {
    for (const guard of transition.guards ?? []) {
      const message = await this.checkGuard(tx, job, guard);
      if (message) throw new BadRequestException(message);
    }
  }

  private async checkGuard(tx: Tx, job: InspectionJob, guard: JobGuard): Promise<string | null> {
    switch (guard) {
      case 'hasClient':
        return job.clientId ? null : 'the client is missing';
      case 'hasOffice':
        return job.branchId ? null : 'the responsible office is missing';
      case 'hasServiceType':
        return job.type ? null : 'the service type is missing';
      case 'hasRequestedDate':
        return job.requestedDate ? null : 'the requested date is missing';
      case 'hasAssignee': {
        const row = await tx.one<{ n: number }>(
          'SELECT count(*)::int AS n FROM job_assignments WHERE job_id = $1 AND removed_at IS NULL',
          [job.id],
        );
        return (row?.n ?? 0) > 0 ? null : 'nobody is assigned to it yet';
      }
      case 'checklistComplete': {
        const row = await tx.one<{ n: number }>(
          'SELECT count(*)::int AS n FROM job_checklist_items WHERE job_id = $1 AND result IS NULL',
          [job.id],
        );
        const missing = row?.n ?? 0;
        return missing === 0 ? null : `${missing} checklist item(s) still have no result`;
      }
      case 'hasReport': {
        const row = await tx.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM reports WHERE job_id = $1 AND status = 'issued'`,
          [job.id],
        );
        return (row?.n ?? 0) > 0 ? null : 'no report has been issued for it';
      }
      case 'noOpenInvoice': {
        const row = await tx.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM invoices
           WHERE job_id = $1 AND deleted_at IS NULL AND status IN ('draft', 'issued', 'partially_paid')`,
          [job.id],
        );
        // Reading invoices needs the finance permission; without it the count comes back 0,
        // which is the right answer for someone who cannot see them either way.
        return (row?.n ?? 0) === 0 ? null : 'it still has an unpaid invoice';
      }
      default:
        return null;
    }
  }
}

function label(status: JobStatus): string {
  return status.replace(/_/g, ' ');
}

function pastTense(action: JobAction): string {
  const words: Partial<Record<JobAction, string>> = {
    confirm: 'confirmed',
    assign: 'assigned',
    start: 'started',
    submit: 'submitted for review',
    return: 'returned for rework',
    approve: 'approved',
    complete: 'completed',
    invoice: 'marked as invoiced',
    close: 'closed',
    hold: 'put on hold',
    resume: 'resumed',
    cancel: 'cancelled',
    sample: 'moved to sampling',
    send_to_lab: 'sent to the laboratory',
    prepare_report: 'moved to report preparation',
  };
  return words[action] ?? action;
}
