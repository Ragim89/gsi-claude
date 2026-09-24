import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  AuthUser,
  CustodyEventType,
  SAMPLE_WORKFLOW,
  Sample,
  SampleAction,
  SampleGuard,
  SampleStatus,
  SampleTransition,
  sampleTransitionFor,
} from '@gsi/shared-types';
import { Tx } from '../db/db.service';
import { AuditService } from '../common/audit.service';
import { JobEventsService } from '../operations/job-events.service';
import { CustodyInput, recordCustody } from './custody';

export interface SampleTransitionInput {
  reason?: string | null;
  metadata?: Record<string, unknown>;
  /** Extra columns the move itself owns, e.g. the dispatch details. */
  extraSet?: string;
  extraParams?: unknown[];
  /** The custody entry this move implies; most moves have exactly one. */
  custody?: Omit<CustodyInput, 'sampleId' | 'branchId' | 'eventType'> & { eventType: CustodyEventType };
}

/**
 * The one place a sample changes status — the same shape as the job and inspection engines,
 * with one addition that matters more here than anywhere else: the move and the custody entry
 * it implies are written in the same transaction. A sample that is dispatched according to its
 * status but has no dispatch in its custody chain would be worse than no record at all.
 */
@Injectable()
export class SampleWorkflowService {
  constructor(private readonly audit: AuditService, private readonly events: JobEventsService) {}

  /** What this user may do with this sample right now. */
  available(user: AuthUser, sample: Sample): SampleAction[] {
    return SAMPLE_WORKFLOW.filter(
      (t) => t.from.includes(sample.status) && (user.permissions?.includes(t.permission) ?? false),
    ).map((t) => t.action);
  }

  async apply(
    tx: Tx,
    user: AuthUser,
    sample: Sample,
    action: SampleAction,
    input: SampleTransitionInput = {},
  ): Promise<SampleStatus> {
    const transition = sampleTransitionFor(action);
    if (!transition) throw new BadRequestException(`Unknown action "${action}"`);

    if (!user.permissions?.includes(transition.permission)) {
      throw new ForbiddenException(`Requires permission: ${transition.permission}`);
    }
    if (!transition.from.includes(sample.status)) {
      throw new ConflictException(
        `A sample that is ${label(sample.status)} cannot be ${pastTense(action)}` +
          ` (allowed from: ${transition.from.map(label).join(', ')})`,
      );
    }
    if (transition.requiresReason && !input.reason?.trim()) {
      throw new BadRequestException(`A reason is required to ${action.replace(/_/g, ' ')} a sample`);
    }

    const target =
      action === 'resume' ? ((sample.statusBeforeHold as SampleStatus | null) ?? 'registered') : transition.to;

    this.checkGuards(sample, transition);

    const sets = [`status = '${target}'::sample_status`];
    const params: unknown[] = [sample.id];
    if (action === 'hold') sets.push(`status_before_hold = '${sample.status}'::sample_status`);
    if (action === 'resume') sets.push('status_before_hold = NULL');
    if (action === 'collect' && !sample.sampledAt) sets.push('sampled_at = now()');
    if (input.extraSet) {
      sets.push(input.extraSet);
      params.push(...(input.extraParams ?? []));
    }

    await tx.exec(`UPDATE samples SET ${sets.join(', ')} WHERE id = $1`, params);

    await tx.exec(
      `INSERT INTO sample_status_history (sample_id, branch_id, from_status, to_status, changed_by, reason, metadata)
       VALUES ($1, $2, $3::sample_status, $4::sample_status, $5, $6, $7::jsonb)`,
      [
        sample.id,
        sample.branchId,
        sample.status,
        target,
        user.id,
        input.reason?.trim() || null,
        JSON.stringify({ action, ...input.metadata }),
      ],
    );

    // The physical record, written with the business one or not at all.
    if (input.custody) {
      await recordCustody(tx, user, { ...input.custody, sampleId: sample.id, branchId: sample.branchId });
    }

    await this.audit.record(tx, user, {
      action: `sample.${action}`,
      entityType: 'sample',
      entityId: sample.id,
      entityLabel: sample.sampleNumber,
      branchId: sample.branchId,
      before: { status: sample.status },
      after: { status: target },
      metadata: { action, ...(input.reason ? { reason: input.reason } : {}), ...input.metadata },
    });

    this.events.emit({
      type: 'job.status_changed',
      jobId: sample.jobId,
      jobNumber: sample.sampleNumber,
      branchId: sample.branchId,
      actorId: user.id,
      reason: input.reason ?? null,
    });

    return target;
  }

  /** Every guard reads the sample as it will be after this move, so no guard needs the database. */
  private checkGuards(sample: Sample, transition: SampleTransition): void {
    for (const guard of transition.guards ?? []) {
      const message = this.checkGuard(sample, guard);
      if (message) throw new BadRequestException(`This sample cannot be moved on: ${message}`);
    }
  }

  private checkGuard(sample: Sample, guard: SampleGuard): string | null {
    switch (guard) {
      case 'hasSampler':
        return sample.sampledBy ? null : 'nobody is recorded as having taken it';
      case 'hasIdentity': {
        const missing: string[] = [];
        if (!sample.commodityId && !sample.commodity?.trim()) missing.push('the commodity');
        if (sample.quantity == null) missing.push('the quantity');
        if (!sample.unit?.trim()) missing.push('the unit');
        if (!sample.sampledAt) missing.push('when it was taken');
        if (!sample.sampledBy) missing.push('who took it');
        return missing.length ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing` : null;
      }
      case 'hasSeal':
        return sample.sealNumber?.trim() ? null : 'it has no seal number';
      case 'hasDestination':
        return sample.destinationLaboratoryId ? null : 'no destination laboratory has been chosen';
      case 'hasRejectionReason':
        return sample.rejectionReason ? null : 'a rejection reason is required';
      default:
        return null;
    }
  }
}

function label(status: SampleStatus): string {
  return status.replace(/_/g, ' ');
}

function pastTense(action: SampleAction): string {
  const words: Record<SampleAction, string> = {
    collect: 'collected',
    register: 'registered',
    seal: 'sealed',
    dispatch: 'dispatched',
    receive: 'received',
    accept: 'accepted',
    reject: 'rejected',
    return: 'returned',
    hold: 'put on hold',
    resume: 'resumed',
    cancel: 'cancelled',
  };
  return words[action] ?? action;
}
