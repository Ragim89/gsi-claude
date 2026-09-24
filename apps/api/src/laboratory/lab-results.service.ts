import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  AuthUser,
  LabResultType,
  MethodSnapshot,
  RESULT_EDITABLE_STATUSES,
  ReleasedResult,
  SpecEvaluation,
  SpecificationSnapshot,
  TestResult,
} from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../common/audit.service';
import { LabRequestsService } from './lab-requests.service';
import { LabWorkflowService } from './lab-workflow.service';
import { RESULT_FROM, RESULT_WITH_NAMES } from './lab-sql';

export interface ResultInput {
  numericValue?: number | string | null;
  textValue?: string | null;
  booleanValue?: boolean | null;
  qualitativeValue?: string | null;
  unit?: string | null;
  instrumentId?: string | null;
  comments?: string | null;
  /** The revision this edit was started from; a stale one is refused rather than overwritten. */
  version?: number;
}

/**
 * Results: entering them, checking them, signing them, and correcting them without ever
 * rewriting what was already signed.
 *
 * The rule the whole file is built around: an approved result is immutable. Correcting one
 * creates a new revision that supersedes it; the old row keeps its value, its method snapshot,
 * its limits and its signatures, because a report quoted it and that report must go on being
 * true about what it quoted.
 */
@Injectable()
export class LabResultsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly requests: LabRequestsService,
    private readonly workflow: LabWorkflowService,
  ) {}

  /**
   * Saves the analyst's answer. The first save is a draft and moves the request to
   * `result_entered`; later saves overwrite the draft. Once it is submitted an ordinary analyst
   * can no longer touch it — that is what submitting means.
   */
  save(user: AuthUser, requestId: string, input: ResultInput) {
    return this.db.tx(user, async (tx) => {
      const request = await this.requests.load(tx, requestId, true);

      if (!RESULT_EDITABLE_STATUSES.includes(request.status)) {
        throw new ConflictException(
          `A result cannot be written while the test is ${request.status.replace(/_/g, ' ')}` +
            (request.status === 'under_review' ? '; ask for it to be returned first' : ''),
        );
      }
      if (request.assignedAnalystId && request.assignedAnalystId !== user.id
          && !(user.permissions?.includes('lab.test.assign') ?? false)) {
        throw new ForbiddenException('This analysis is assigned to somebody else');
      }

      const resultType = (request.resultType ?? 'numeric') as LabResultType;
      const value = this.readValue(resultType, input);
      const method = await this.methodSnapshot(tx, request.testMethodId);
      const specification = await this.specificationSnapshot(tx, request.specificationId);
      const unit = input.unit ?? request.result?.unit ?? method.defaultUnit ?? null;
      const evaluation = this.evaluate(resultType, value, specification);
      const instrument = await this.instrument(tx, input.instrumentId ?? null, request.laboratoryId);

      const current = await tx.one<{ id: string; version: number; revision: number }>(
        'SELECT id, version, revision FROM test_results WHERE test_request_id = $1 AND is_current FOR UPDATE',
        [requestId],
      );

      if (current && input.version !== undefined && input.version !== current.version) {
        throw new ConflictException('This result was changed by somebody else. Refresh before saving.');
      }

      let resultId: string;
      if (current) {
        await tx.exec(
          `UPDATE test_results
              SET numeric_value = $2::numeric, text_value = $3, boolean_value = $4, qualitative_value = $5,
                  unit = $6, method_snapshot = $7::jsonb, specification_snapshot = $8::jsonb,
                  evaluation = $9::spec_evaluation, instrument_id = $10::uuid, instrument_overdue = $11,
                  comments = $12, analyst_id = $13, entered_at = now()
            WHERE id = $1`,
          [current.id, value.numeric, value.text, value.boolean, value.qualitative, unit,
           JSON.stringify(method), specification ? JSON.stringify(specification) : null, evaluation,
           instrument?.id ?? null, instrument?.overdue ?? false, input.comments ?? null, user.id],
        );
        resultId = current.id;
      } else {
        const row = await tx.one<{ id: string }>(
          `INSERT INTO test_results (test_request_id, branch_id, revision, result_type, numeric_value,
                                     text_value, boolean_value, qualitative_value, unit, method_snapshot,
                                     specification_snapshot, evaluation, instrument_id, instrument_overdue,
                                     analyst_id, comments)
           VALUES ($1, $2, 1, $3::lab_result_type, $4::numeric, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
                   $11::spec_evaluation, $12::uuid, $13, $14, $15)
           RETURNING id`,
          [requestId, request.branchId, resultType, value.numeric, value.text, value.boolean,
           value.qualitative, unit, JSON.stringify(method),
           specification ? JSON.stringify(specification) : null, evaluation,
           instrument?.id ?? null, instrument?.overdue ?? false, user.id, input.comments ?? null],
        );
        resultId = row!.id;
      }

      // Saving is itself a move, so it leaves a line in the history like every other one.
      if (request.status === 'in_progress') {
        await this.workflow.apply(tx, user, request, 'enter', { metadata: { evaluation } });
      }

      await this.audit.record(tx, user, {
        action: 'lab.result.draft_saved',
        entityType: 'test_request',
        entityId: requestId,
        entityLabel: `${request.sampleNumber} · ${request.testCode}`,
        branchId: request.branchId,
        after: { evaluation, unit, revision: current?.revision ?? 1 },
      });

      if (evaluation === 'out_of_spec') await this.raiseOutOfSpec(tx, user, request, resultId);

      return this.requests.load(tx, requestId);
    });
  }

  /** Hands the draft in. From here an ordinary analyst can no longer change the value. */
  submit(user: AuthUser, requestId: string) {
    return this.db.tx(user, async (tx) => {
      const request = await this.requests.load(tx, requestId, true);
      if (!request.result) throw new BadRequestException('There is no result to submit');
      await tx.exec('UPDATE test_results SET submitted_at = now() WHERE id = $1', [request.result.id]);
      await this.workflow.apply(tx, user, request, 'submit', {
        metadata: { evaluation: request.result.evaluation },
      });
      return this.requests.load(tx, requestId);
    });
  }

  /**
   * Technical review: a second pair of eyes signs that the work is sound. It deliberately does
   * not approve anything — approval is a separate right and a separate click.
   */
  review(user: AuthUser, requestId: string, comment?: string | null) {
    return this.db.tx(user, async (tx) => {
      const request = await this.requests.load(tx, requestId, true);
      if (!request.result) throw new BadRequestException('There is no result to review');
      if (request.result.analystId === user.id
          && !(user.permissions?.includes('lab.result.self_approve') ?? false)) {
        throw new ForbiddenException('You entered this result; somebody else has to review it');
      }
      await tx.exec(
        'UPDATE test_results SET reviewed_by = $2, reviewed_at = now(), review_comment = $3 WHERE id = $1',
        [request.result.id, user.id, comment ?? null],
      );
      await this.workflow.apply(tx, user, request, 'review', { reason: comment, metadata: { reviewed: true } });
      return this.requests.load(tx, requestId);
    });
  }

  /** Sends it back to the bench. The reason is mandatory and reaches the analyst. */
  returnToAnalyst(user: AuthUser, requestId: string, reason: string) {
    return this.db.tx(user, async (tx) => {
      const request = await this.requests.load(tx, requestId, true);
      if (request.result) {
        await tx.exec(
          'UPDATE test_results SET review_comment = $2, submitted_at = NULL WHERE id = $1',
          [request.result.id, reason],
        );
      }
      await this.workflow.apply(tx, user, request, 'return', { reason });
      return this.requests.load(tx, requestId);
    });
  }

  approve(user: AuthUser, requestId: string) {
    return this.db.tx(user, async (tx) => {
      const request = await this.requests.load(tx, requestId, true);
      await this.workflow.apply(tx, user, request, 'approve', {
        metadata: { evaluation: request.result?.evaluation, revision: request.result?.revision },
      });
      await tx.exec('UPDATE test_results SET approved_by = $2, approved_at = now() WHERE id = $1', [
        request.result!.id,
        user.id,
      ]);
      return this.requests.load(tx, requestId);
    });
  }

  /**
   * Releases the result for use outside the laboratory. Approved says the number is right;
   * released says it may leave the building. Reports only ever read released revisions.
   */
  release(user: AuthUser, requestId: string) {
    return this.db.tx(user, async (tx) => {
      const request = await this.requests.load(tx, requestId, true);
      if (!request.result?.approvedAt) throw new ConflictException('Only an approved result can be released');
      await this.workflow.apply(tx, user, request, 'release', { metadata: { revision: request.result.revision } });
      await tx.exec('UPDATE test_results SET released_by = $2, released_at = now() WHERE id = $1', [
        request.result.id,
        user.id,
      ]);
      return this.requests.load(tx, requestId);
    });
  }

  /**
   * Corrects a signed result by superseding it. The old revision keeps every value and every
   * signature it had; the new one starts as a draft on the bench with the reason on the record.
   */
  amend(user: AuthUser, requestId: string, reason: string) {
    return this.db.tx(user, async (tx) => {
      const request = await this.requests.load(tx, requestId, true);
      const previous = request.result;
      if (!previous) throw new BadRequestException('There is nothing to amend');
      if (!previous.approvedAt) throw new ConflictException('Only an approved result needs an amendment');

      await tx.exec('UPDATE test_results SET is_current = false WHERE id = $1', [previous.id]);
      const row = await tx.one<{ id: string; revision: number }>(
        `INSERT INTO test_results (test_request_id, branch_id, revision, is_current, supersedes_result_id,
                                   result_type, numeric_value, text_value, boolean_value, qualitative_value,
                                   unit, method_snapshot, specification_snapshot, evaluation,
                                   instrument_id, instrument_overdue, analyst_id, comments, amendment_reason)
         SELECT p.test_request_id, p.branch_id, p.revision + 1, true, p.id,
                p.result_type, p.numeric_value, p.text_value, p.boolean_value, p.qualitative_value,
                p.unit, p.method_snapshot, p.specification_snapshot, p.evaluation,
                p.instrument_id, p.instrument_overdue, $2, p.comments, $3
         FROM test_results p WHERE p.id = $1
         RETURNING id, revision`,
        [previous.id, user.id, reason],
      );

      await this.workflow.apply(tx, user, request, 'amend', {
        reason,
        metadata: { supersedes: previous.revision, revision: row!.revision },
      });
      await this.audit.record(tx, user, {
        action: 'lab.result.amended',
        entityType: 'test_request',
        entityId: requestId,
        entityLabel: `${request.sampleNumber} · ${request.testCode}`,
        branchId: request.branchId,
        before: { revision: previous.revision, value: this.plain(previous) },
        after: { revision: row!.revision, reason },
      });
      return this.requests.load(tx, requestId);
    });
  }

  /** Every revision, newest first — the amendment trail. */
  revisions(user: AuthUser, requestId: string): Promise<TestResult[]> {
    return this.db.tx(user, async (tx) => {
      await this.requests.load(tx, requestId);
      return tx.many<TestResult>(
        `SELECT ${RESULT_WITH_NAMES} FROM ${RESULT_FROM}
         WHERE x.test_request_id = $1 ORDER BY x.revision DESC`,
        [requestId],
      );
    });
  }

  /**
   * The read model reports are allowed to quote: released revisions only.
   *
   * Approved is the laboratory's word that the number is right; released is its word that the
   * number may appear on a document with a client's name on it. A report that quoted merely
   * approved results would be publishing work the laboratory had not cleared.
   */
  released(user: AuthUser, f: { jobId?: string; sampleId?: string }): Promise<ReleasedResult[]> {
    if (!f.jobId && !f.sampleId) throw new BadRequestException('Ask for one job or one sample');
    return this.db.tx(user, (tx) =>
      tx.many<ReleasedResult>(
        `SELECT r.id AS "testRequestId", x.id AS "resultId", x.revision,
                s.id AS "sampleId", s.sample_number AS "sampleNumber",
                s.job_id AS "jobId", j.job_number AS "jobNumber",
                t.code AS "testCode", t.name AS "testName",
                x.method_snapshot->>'code' AS "methodCode",
                x.method_snapshot->>'name' AS "methodName",
                (x.method_snapshot->>'version')::int AS "methodVersion",
                x.method_snapshot->>'standardReference' AS "standardReference",
                x.result_type AS "resultType", x.numeric_value::float8 AS "numericValue",
                x.text_value AS "textValue", x.boolean_value AS "booleanValue",
                x.qualitative_value AS "qualitativeValue", x.unit, x.evaluation,
                x.specification_snapshot AS "specificationSnapshot",
                an.full_name AS "analystName", ap.full_name AS "approvedByName",
                x.approved_at AS "approvedAt", x.released_at AS "releasedAt"
         FROM test_results x
         JOIN test_requests r ON r.id = x.test_request_id
         JOIN samples s ON s.id = r.sample_id
         JOIN inspection_jobs j ON j.id = s.job_id
         JOIN lab_tests t ON t.id = r.lab_test_id
         LEFT JOIN users an ON an.id = x.analyst_id
         LEFT JOIN users ap ON ap.id = x.approved_by
         WHERE x.is_current AND x.released_at IS NOT NULL
           AND ($1::uuid IS NULL OR s.job_id = $1::uuid)
           AND ($2::uuid IS NULL OR s.id = $2::uuid)
         ORDER BY s.sample_number, t.sort_order, t.code`,
        [f.jobId ?? null, f.sampleId ?? null],
      ),
    );
  }

  // ---- Internals -------------------------------------------------------------------------

  /** Reads the one field the result type promises, and refuses the rest. */
  private readValue(type: LabResultType, input: ResultInput) {
    const empty = { numeric: null as string | null, text: null as string | null, boolean: null as boolean | null, qualitative: null as string | null };
    switch (type) {
      case 'numeric': {
        if (input.numericValue === undefined || input.numericValue === null || input.numericValue === '') {
          throw new BadRequestException('This analysis needs a numeric result');
        }
        // Kept as a string all the way to `numeric`: passing it through a JavaScript number
        // would turn 12.40 into something that is not quite 12.40, for ever.
        const raw = String(input.numericValue).trim().replace(',', '.');
        if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new BadRequestException(`"${raw}" is not a number`);
        return { ...empty, numeric: raw };
      }
      case 'text':
        if (!input.textValue?.trim()) throw new BadRequestException('This analysis needs a text result');
        return { ...empty, text: input.textValue.trim() };
      case 'boolean':
      case 'pass_fail':
        if (typeof input.booleanValue !== 'boolean') {
          throw new BadRequestException('This analysis needs pass or fail');
        }
        return { ...empty, boolean: input.booleanValue };
      case 'qualitative':
        if (!input.qualitativeValue?.trim()) throw new BadRequestException('This analysis needs a qualitative result');
        return { ...empty, qualitative: input.qualitativeValue.trim() };
      default:
        throw new BadRequestException('Unknown result type');
    }
  }

  private async methodSnapshot(tx: Tx, methodId: string): Promise<MethodSnapshot> {
    const row = await tx.one<MethodSnapshot>(
      `SELECT id, code, name, version, standard_reference AS "standardReference",
              default_unit AS "defaultUnit", detection_limit::float8 AS "detectionLimit",
              quantification_limit::float8 AS "quantificationLimit",
              accreditation_scope AS "accreditationScope"
       FROM test_methods WHERE id = $1`,
      [methodId],
    );
    if (!row) throw new BadRequestException('The method has disappeared');
    return row;
  }

  private async specificationSnapshot(tx: Tx, specId: string | null): Promise<SpecificationSnapshot | null> {
    if (!specId) return null;
    return tx.one<SpecificationSnapshot>(
      `SELECT id,
              CASE WHEN contract_id IS NOT NULL THEN 'contract'
                   WHEN client_id IS NOT NULL THEN 'client'
                   WHEN commodity_id IS NOT NULL THEN 'commodity'
                   ELSE 'default' END AS scope,
              min_value::float8 AS "minValue", max_value::float8 AS "maxValue",
              target_value::float8 AS "targetValue", unit,
              qualitative_requirement AS "qualitativeRequirement"
       FROM test_specifications WHERE id = $1`,
      [specId],
    );
  }

  /**
   * Whether the value met the limits it was judged against. Computed, stored and traceable —
   * and never allowed to change the value itself. Out of specification is a fact about a
   * result, not a reason to alter it.
   */
  private evaluate(
    type: LabResultType,
    value: { numeric: string | null; qualitative: string | null; boolean: boolean | null },
    spec: SpecificationSnapshot | null,
  ): SpecEvaluation {
    if (!spec) return 'not_evaluated';
    if (type === 'numeric' && value.numeric !== null) {
      const n = Number(value.numeric);
      if (spec.minValue !== null && n < spec.minValue) return 'out_of_spec';
      if (spec.maxValue !== null && n > spec.maxValue) return 'out_of_spec';
      if (spec.minValue === null && spec.maxValue === null) return 'not_evaluated';
      return 'within_spec';
    }
    if ((type === 'pass_fail' || type === 'boolean') && value.boolean !== null) {
      return value.boolean ? 'within_spec' : 'out_of_spec';
    }
    if (type === 'qualitative' && spec.qualitativeRequirement) {
      return value.qualitative?.trim().toLowerCase() === spec.qualitativeRequirement.trim().toLowerCase()
        ? 'within_spec'
        : 'out_of_spec';
    }
    return 'not_evaluated';
  }

  private async instrument(tx: Tx, id: string | null, laboratoryId: string) {
    if (!id) return null;
    const row = await tx.one<{ id: string; laboratory_id: string; status: string; overdue: boolean; name: string }>(
      `SELECT id, laboratory_id, status::text,
              (calibration_due_at IS NOT NULL AND calibration_due_at < current_date) AS overdue, name
       FROM lab_instruments WHERE id = $1`,
      [id],
    );
    if (!row) throw new BadRequestException('Unknown instrument');
    if (row.laboratory_id !== laboratoryId) {
      throw new BadRequestException(`${row.name} belongs to a different laboratory`);
    }
    if (row.status === 'out_of_service' || row.status === 'retired') {
      throw new BadRequestException(`${row.name} is ${row.status.replace(/_/g, ' ')}`);
    }
    // An overdue calibration is recorded on the result and warned about, never a hard block:
    // deciding that no analysis may run is a laboratory's call, not a default of this software.
    return row;
  }

  private async raiseOutOfSpec(tx: Tx, user: AuthUser, request: { id: string; branchId: string; sampleNumber?: string; testCode?: string }, resultId: string) {
    await this.audit.record(tx, user, {
      action: 'lab.result.out_of_spec',
      entityType: 'test_request',
      entityId: request.id,
      entityLabel: `${request.sampleNumber ?? ''} · ${request.testCode ?? ''}`.trim(),
      branchId: request.branchId,
      after: { resultId },
    });
  }

  private plain(result: TestResult) {
    return result.numericValue ?? result.textValue ?? result.qualitativeValue ?? result.booleanValue;
  }
}
