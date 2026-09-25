import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  AuthUser,
  ReportAction,
  ReportDocument,
  ReportGuard,
  ReportStatus,
  ReportTransition,
  ReportVersion,
  reportTransitionFor,
  REPORT_WORKFLOW,
} from '@gsi/shared-types';
import { Tx } from '../db/db.service';
import { AuditService } from '../common/audit.service';

export interface ReportTransitionInput {
  reason?: string | null;
  /** Extra `SET` clause applied to the document in the same statement as the status. */
  extraSet?: string;
  extraParams?: unknown[];
  metadata?: Record<string, unknown>;
}

const label = (s: ReportStatus) => s.replace(/_/g, ' ');

/**
 * The only thing that writes `reports.status`.
 *
 * Fifth instance of the same engine as jobs, inspections, samples and the laboratory, and for
 * the same reason: a document whose status moved without a line of history, an audit entry and
 * a permission check is a document nobody can defend afterwards.
 */
@Injectable()
export class ReportWorkflowService {
  constructor(private readonly audit: AuditService) {}

  /**
   * What this user may do with this document right now.
   *
   * Guards are applied here as well as at execution, so the author of a document is not offered
   * a review or an approval they would be refused. Offering a button that answers 409 teaches
   * people to distrust the buttons.
   */
  available(user: AuthUser, report: ReportDocument): ReportAction[] {
    return REPORT_WORKFLOW.filter((t) => {
      if (!t.from.includes(report.status)) return false;
      if (!(user.permissions?.includes(t.permission) ?? false)) return false;
      return (t.guards ?? []).every(
        (g) => !this.guardProblem(g, user, report, report.currentVersion ?? null),
      ) && !this.wouldBeSelfReview(user, report, t.action);
    }).map((t) => t.action);
  }

  /** Reviewing is not in the guard list — it is refused by the service — so it is checked here. */
  private wouldBeSelfReview(user: AuthUser, report: ReportDocument, action: ReportAction): boolean {
    if (action !== 'review' && action !== 'request_changes') return false;
    const author = report.currentVersion?.preparedBy ?? report.preparedBy;
    return author === user.id && !(user.permissions?.includes('report.self_approve') ?? false);
  }

  async apply(
    tx: Tx,
    user: AuthUser,
    report: ReportDocument,
    action: ReportAction,
    input: ReportTransitionInput = {},
  ): Promise<ReportStatus> {
    const transition = reportTransitionFor(action);
    if (!transition) throw new BadRequestException(`Unknown action "${action}"`);

    if (!user.permissions?.includes(transition.permission)) {
      throw new ForbiddenException(`Requires permission: ${transition.permission}`);
    }
    if (!transition.from.includes(report.status)) {
      throw new ConflictException(
        `A document that is ${label(report.status)} cannot be ${action.replace(/_/g, ' ')}d` +
          ` (allowed from: ${transition.from.map(label).join(', ')})`,
      );
    }
    if (transition.requiresReason && !input.reason?.trim()) {
      throw new BadRequestException(`A reason is required to ${action.replace(/_/g, ' ')} a document`);
    }

    this.checkGuards(user, report, transition);

    const sets = [`status = '${transition.to}'::report_status`];
    const params: unknown[] = [report.id];
    if (input.extraSet) {
      sets.push(input.extraSet.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 1}`));
      params.push(...(input.extraParams ?? []));
    }
    await tx.exec(`UPDATE reports SET ${sets.join(', ')} WHERE id = $1`, params);

    await tx.exec(
      `INSERT INTO report_status_history (report_id, version_number, from_status, to_status, changed_by, reason, metadata)
       VALUES ($1, $2, $3::report_status, $4::report_status, $5, $6, $7::jsonb)`,
      [report.id, report.version, report.status, transition.to, user.id,
       input.reason?.trim() ?? null, JSON.stringify(input.metadata ?? {})],
    );

    await this.audit.record(tx, user, {
      action: `report.${action}`,
      entityType: 'report',
      entityId: report.id,
      entityLabel: report.reportNumber,
      branchId: report.branchId,
      before: { status: report.status },
      after: { status: transition.to, version: report.version },
      ...(input.reason ? { metadata: { reason: input.reason } } : {}),
    });

    return transition.to;
  }

  /**
   * The rules that are about the document rather than about the person.
   *
   * `notSelfApproval` is the one that matters: the person who wrote a document does not sign
   * it off. `report.self_approve` lifts it, and is granted to nobody by default — a small
   * office where one person does everything should have to decide that deliberately.
   */
  private checkGuards(user: AuthUser, report: ReportDocument, transition: ReportTransition) {
    for (const guard of transition.guards ?? []) {
      const problem = this.guardProblem(guard, user, report, report.currentVersion ?? null);
      if (problem) throw new ConflictException(`This document cannot be ${transition.action}d: ${problem}`);
    }
  }

  private guardProblem(
    guard: ReportGuard,
    user: AuthUser,
    report: ReportDocument,
    version: ReportVersion | null,
  ): string | null {
    switch (guard) {
      case 'hasTemplate':
        return report.templateId ? null : 'no template has been chosen for it';
      case 'hasContent':
        return version ? null : 'it has no content yet';
      case 'reviewed':
        return version?.reviewedBy
          ? null
          : 'nobody has reviewed it; a document nobody has checked cannot be approved';
      case 'notSelfApproval': {
        const author = version?.preparedBy ?? report.preparedBy;
        if (author && author === user.id && !(user.permissions?.includes('report.self_approve') ?? false)) {
          return 'you prepared it yourself; approval belongs to somebody else';
        }
        return null;
      }
      default:
        return null;
    }
  }
}
