import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  AuthUser,
  LAB_WORKFLOW,
  LabGuard,
  LabTransition,
  TestRequest,
  TestRequestAction,
  TestRequestStatus,
  labTransitionFor,
} from '@gsi/shared-types';
import { Tx } from '../db/db.service';
import { AuditService } from '../common/audit.service';
import { JobEventsService } from '../operations/job-events.service';

export interface LabTransitionInput {
  reason?: string | null;
  metadata?: Record<string, unknown>;
  extraSet?: string;
  extraParams?: unknown[];
}

/**
 * The one place a test request changes status — the same shape as the job, inspection and
 * sample engines.
 *
 * Two guards here carry the weight of the whole module. `hasTechnicalReview` refuses an
 * approval that nobody has reviewed, and `notSelfApproval` refuses one signed by the person who
 * ran the analysis. Between them they are what makes a laboratory record worth anything: a
 * number nobody but its author ever looked at is an opinion, not a result.
 */
@Injectable()
export class LabWorkflowService {
  constructor(private readonly audit: AuditService, private readonly events: JobEventsService) {}

  /** What this user may do with this request right now. */
  available(user: AuthUser, request: TestRequest): TestRequestAction[] {
    return LAB_WORKFLOW.filter(
      (t) => t.from.includes(request.status) && (user.permissions?.includes(t.permission) ?? false),
    ).map((t) => t.action);
  }

  async apply(
    tx: Tx,
    user: AuthUser,
    request: TestRequest,
    action: TestRequestAction,
    input: LabTransitionInput = {},
  ): Promise<TestRequestStatus> {
    const transition = labTransitionFor(action);
    if (!transition) throw new BadRequestException(`Unknown action "${action}"`);

    if (!user.permissions?.includes(transition.permission)) {
      throw new ForbiddenException(`Requires permission: ${transition.permission}`);
    }
    if (!transition.from.includes(request.status)) {
      throw new ConflictException(
        `A test that is ${label(request.status)} cannot be ${pastTense(action)}` +
          ` (allowed from: ${transition.from.map(label).join(', ')})`,
      );
    }
    if (transition.requiresReason && !input.reason?.trim()) {
      throw new BadRequestException(`A reason is required to ${action.replace(/_/g, ' ')} a test`);
    }

    const target =
      action === 'resume' ? ((request.statusBeforeHold as TestRequestStatus | null) ?? 'in_progress') : transition.to;

    this.checkGuards(user, request, transition);

    const sets = [`status = '${target}'::test_request_status`];
    const params: unknown[] = [request.id];
    if (action === 'hold') sets.push(`status_before_hold = '${request.status}'::test_request_status`);
    if (action === 'resume') sets.push('status_before_hold = NULL');
    if (action === 'start' && !request.startedAt) sets.push('started_at = now()');
    if (input.extraSet) {
      sets.push(input.extraSet);
      params.push(...(input.extraParams ?? []));
    }

    await tx.exec(`UPDATE test_requests SET ${sets.join(', ')} WHERE id = $1`, params);

    await tx.exec(
      `INSERT INTO test_request_status_history (test_request_id, branch_id, from_status, to_status,
                                                changed_by, reason, metadata)
       VALUES ($1, $2, $3::test_request_status, $4::test_request_status, $5, $6, $7::jsonb)`,
      [
        request.id,
        request.branchId,
        request.status,
        target,
        user.id,
        input.reason?.trim() || null,
        JSON.stringify({ action, ...input.metadata }),
      ],
    );

    await this.audit.record(tx, user, {
      action: `lab.${action}`,
      entityType: 'test_request',
      entityId: request.id,
      entityLabel: `${request.sampleNumber ?? ''} · ${request.testCode ?? ''}`.trim(),
      branchId: request.branchId,
      before: { status: request.status },
      after: { status: target },
      metadata: { action, ...(input.reason ? { reason: input.reason } : {}), ...input.metadata },
    });

    this.events.emit({
      type: 'job.status_changed',
      jobId: request.jobId ?? request.sampleId,
      jobNumber: `${request.sampleNumber ?? ''} · ${request.testCode ?? ''}`.trim(),
      branchId: request.branchId,
      actorId: user.id,
      reason: input.reason ?? null,
    });

    return target;
  }

  private checkGuards(user: AuthUser, request: TestRequest, transition: LabTransition): void {
    for (const guard of transition.guards ?? []) {
      const message = this.checkGuard(user, request, guard);
      if (message) throw new BadRequestException(`This test cannot be moved on: ${message}`);
    }
  }

  private checkGuard(user: AuthUser, request: TestRequest, guard: LabGuard): string | null {
    const result = request.result;
    switch (guard) {
      case 'hasAnalyst':
        return request.assignedAnalystId ? null : 'nobody has been assigned to run it';
      case 'hasResult':
        return result ? null : 'no result has been entered';
      case 'hasTechnicalReview':
        return result?.reviewedBy
          ? null
          : 'it has not been technically reviewed; a result nobody has checked cannot be approved';
      case 'notSelfApproval':
        // The separation of the bench from the signature. A one-person laboratory is served by
        // granting `lab.result.self_approve` deliberately, not by the rule quietly not applying.
        if (result?.analystId && result.analystId === user.id
            && !(user.permissions?.includes('lab.result.self_approve') ?? false)) {
          return 'you entered this result yourself; approval belongs to somebody else';
        }
        return null;
      default:
        return null;
    }
  }
}

function label(status: TestRequestStatus): string {
  return status.replace(/_/g, ' ');
}

function pastTense(action: TestRequestAction): string {
  const words: Record<TestRequestAction, string> = {
    assign: 'assigned',
    start: 'started',
    enter: 'entered',
    submit: 'submitted',
    review: 'reviewed',
    return: 'returned',
    approve: 'approved',
    release: 'released',
    amend: 'amended',
    hold: 'put on hold',
    resume: 'resumed',
    reject: 'rejected',
    cancel: 'cancelled',
  };
  return words[action] ?? action;
}
