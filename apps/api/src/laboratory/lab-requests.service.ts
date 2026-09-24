import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AuthUser,
  JobPriority,
  LabDashboard,
  Page,
  TestRequest,
  TestRequestAction,
  TestRequestHistoryEntry,
  TestRequestStatus,
} from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../common/audit.service';
import { LabWorkflowService } from './lab-workflow.service';
import { REQUEST_COLUMNS, REQUEST_FROM } from './lab-sql';

export type RequestSort = 'requestedAt' | 'dueAt' | 'priority' | 'status' | 'updatedAt';

export interface RequestFilters {
  sampleId?: string;
  jobId?: string;
  clientId?: string;
  laboratoryId?: string;
  labTestId?: string;
  testMethodId?: string;
  analystId?: string;
  status?: TestRequestStatus;
  priority?: JobPriority;
  commodityId?: string;
  branchId?: string;
  /** Assigned to me — the analyst's own bench. */
  mine?: boolean;
  /** Still owed an answer. */
  active?: boolean;
  /** Nobody is running it yet. */
  unassigned?: boolean;
  overdue?: boolean;
  outOfSpec?: boolean;
  /**
   * Whether the live result already carries a technical review. It is what separates "waiting
   * to be checked" from "checked, waiting to be signed" — both are `under_review`, and the
   * laboratory dashboard counts them as two different piles of work.
   */
  reviewed?: boolean;
  search?: string;
  from?: string;
  to?: string;
  sort?: RequestSort;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface CreateRequestsInput {
  sampleId: string;
  laboratoryId?: string;
  /** Explicit list, or the commodity's standard panel when `usePanel` is set. */
  tests?: Array<{ labTestId: string; testMethodId?: string | null }>;
  usePanel?: boolean;
  priority?: JobPriority;
  dueAt?: string | null;
  instructions?: string | null;
  /** Skip what is already requested rather than refusing the whole batch. */
  skipDuplicates?: boolean;
}

const SORT_COLUMNS: Record<RequestSort, string> = {
  requestedAt: 'r.requested_at',
  dueAt: 'r.due_at',
  priority: `array_position(ARRAY['urgent','high','normal','low']::text[], r.priority::text)`,
  status: 'r.status',
  updatedAt: 'r.updated_at',
};

/**
 * Test requests: one analysis on one sample, from "somebody asked" to "the laboratory has
 * answered". The work queue is this list with different filters — a laboratory does not need
 * five screens to ask five questions of the same table.
 */
@Injectable()
export class LabRequestsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly workflow: LabWorkflowService,
  ) {}

  async list(user: AuthUser, f: RequestFilters): Promise<Page<TestRequest>> {
    const limit = f.limit ?? 50;
    const offset = f.offset ?? 0;
    const sort = SORT_COLUMNS[f.sort ?? 'requestedAt'] ?? SORT_COLUMNS.requestedAt;
    const dir = f.dir === 'asc' ? 'ASC' : 'DESC';

    const params = [
      f.sampleId ?? null,
      f.status ?? null,
      f.analystId ?? null,
      f.search?.trim() || null,
      f.laboratoryId ?? null,
      f.from ?? null,
      f.to ?? null,
      f.mine ? user.id : null,
      f.active ?? null,
      f.jobId ?? null,
      f.clientId ?? null,
      f.labTestId ?? null,
      f.priority ?? null,
      f.unassigned ?? null,
      f.overdue ?? null,
      f.outOfSpec ?? null,
      f.commodityId ?? null,
      f.branchId ?? null,
      f.testMethodId ?? null,
      f.reviewed ?? null,
    ];

    const where = `
      WHERE ($1::uuid IS NULL OR r.sample_id = $1::uuid)
        AND ($2::test_request_status IS NULL OR r.status = $2::test_request_status)
        AND ($3::uuid IS NULL OR r.assigned_analyst_id = $3::uuid)
        AND ($4::text IS NULL OR s.sample_number ILIKE '%' || $4 || '%'
             OR j.job_number ILIKE '%' || $4 || '%' OR c.name ILIKE '%' || $4 || '%'
             OR t.code ILIKE '%' || $4 || '%' OR t.name::text ILIKE '%' || $4 || '%'
             OR aa.full_name ILIKE '%' || $4 || '%')
        AND ($5::uuid IS NULL OR r.laboratory_id = $5::uuid)
        AND ($6::date IS NULL OR r.requested_at::date >= $6::date)
        AND ($7::date IS NULL OR r.requested_at::date <= $7::date)
        AND ($8::uuid IS NULL OR r.assigned_analyst_id = $8::uuid)
        AND ($9::boolean IS NOT TRUE OR r.status IN
             ('requested','assigned','in_progress','result_entered','under_review','on_hold'))
        AND ($10::uuid IS NULL OR s.job_id = $10::uuid)
        AND ($11::uuid IS NULL OR s.client_id = $11::uuid)
        AND ($12::uuid IS NULL OR r.lab_test_id = $12::uuid)
        AND ($13::job_priority IS NULL OR r.priority = $13::job_priority)
        AND ($14::boolean IS NOT TRUE OR r.assigned_analyst_id IS NULL)
        AND ($15::boolean IS NOT TRUE OR (r.due_at IS NOT NULL AND r.due_at < now()
             AND r.status IN ('requested','assigned','in_progress','result_entered','under_review','on_hold')))
        AND ($16::boolean IS NOT TRUE OR EXISTS (
             SELECT 1 FROM test_results oo WHERE oo.test_request_id = r.id
               AND oo.is_current AND oo.evaluation = 'out_of_spec'))
        AND ($17::uuid IS NULL OR s.commodity_id = $17::uuid)
        AND ($18::uuid IS NULL OR r.branch_id = $18::uuid)
        AND ($19::uuid IS NULL OR r.test_method_id = $19::uuid)
        AND ($20::boolean IS NULL OR EXISTS (
             SELECT 1 FROM test_results rr WHERE rr.test_request_id = r.id AND rr.is_current
               AND (rr.reviewed_by IS NOT NULL) = $20::boolean))`;

    return this.db.tx(user, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.many<TestRequest>(
          `SELECT ${REQUEST_COLUMNS} FROM ${REQUEST_FROM} ${where}
           ORDER BY ${sort} ${dir} NULLS LAST, r.requested_at DESC
           LIMIT ${limit} OFFSET ${offset}`,
          params,
        ),
        tx.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM test_requests r
             JOIN samples s ON s.id = r.sample_id
             JOIN inspection_jobs j ON j.id = s.job_id
             JOIN clients c ON c.id = s.client_id
             JOIN lab_tests t ON t.id = r.lab_test_id
             LEFT JOIN users aa ON aa.id = r.assigned_analyst_id
           ${where}`,
          params,
        ),
      ]);
      return { rows, total: total?.n ?? 0, limit, offset };
    });
  }

  get(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const request = await this.load(tx, id);
      return { ...request, actions: this.workflow.available(user, request) };
    });
  }

  async load(tx: Tx, id: string, forUpdate = false): Promise<TestRequest> {
    if (forUpdate) await tx.one('SELECT id FROM test_requests WHERE id = $1 FOR UPDATE', [id]);
    const row = await tx.one<TestRequest>(`SELECT ${REQUEST_COLUMNS} FROM ${REQUEST_FROM} WHERE r.id = $1`, [id]);
    if (!row) throw new NotFoundException('Test request not found');
    return row;
  }

  /**
   * Asks the laboratory for analyses on a sample. Several at once, because that is how a
   * laboratory is asked: a panel, not a form filled in five times.
   *
   * The sample has to have been accepted by the laboratory first. A sample still in a courier's
   * van cannot be analysed, and a request pretending otherwise would put a due date on work
   * nobody can start.
   */
  createMany(user: AuthUser, input: CreateRequestsInput) {
    return this.db.tx(user, async (tx) => {
      const sample = await tx.one<{
        id: string; branch_id: string; status: string; sample_number: string;
        commodity_id: string | null; client_id: string; destination_laboratory_id: string | null;
        job_id: string;
      }>(
        `SELECT id, branch_id, status::text, sample_number, commodity_id, client_id,
                destination_laboratory_id, job_id
         FROM samples WHERE id = $1 AND deleted_at IS NULL`,
        [input.sampleId],
      );
      if (!sample) throw new NotFoundException('Sample not found');
      if (sample.status !== 'accepted_by_lab') {
        throw new ConflictException(
          `Analyses can only be requested on a sample the laboratory has accepted; this one is ${sample.status.replace(/_/g, ' ')}`,
        );
      }

      const laboratoryId = input.laboratoryId ?? sample.destination_laboratory_id;
      if (!laboratoryId) throw new BadRequestException('No laboratory to send the analyses to');
      const lab = await tx.one<{ id: string; is_active: boolean; name: string }>(
        'SELECT id, is_active, name FROM laboratories WHERE id = $1',
        [laboratoryId],
      );
      if (!lab) throw new BadRequestException('Unknown laboratory');
      if (!lab.is_active) throw new BadRequestException(`${lab.name} is not active`);

      let wanted = input.tests ?? [];
      if (input.usePanel) {
        if (!sample.commodity_id) {
          throw new BadRequestException('This sample has no commodity, so it has no standard panel');
        }
        wanted = await tx.many<{ labTestId: string; testMethodId: string | null }>(
          `SELECT t.id AS "labTestId", m.id AS "testMethodId"
           FROM commodities cd, unnest(cd.lab_methods) WITH ORDINALITY AS wanted(code, ord)
           JOIN lab_tests t ON t.code = wanted.code AND t.is_active
           LEFT JOIN LATERAL (
             SELECT m.id FROM test_methods m
             WHERE m.lab_test_id = t.id AND m.is_active AND m.retired_at IS NULL
             ORDER BY m.effective_from DESC, m.code LIMIT 1
           ) m ON true
           WHERE cd.id = $1
           ORDER BY wanted.ord`,
          [sample.commodity_id],
        );
      }
      if (!wanted.length) throw new BadRequestException('No analyses were asked for');

      const created: string[] = [];
      const skipped: string[] = [];
      for (const want of wanted) {
        const methodId = want.testMethodId ?? (await this.defaultMethod(tx, want.labTestId));
        if (!methodId) {
          const test = await tx.one<{ code: string }>('SELECT code FROM lab_tests WHERE id = $1', [want.labTestId]);
          throw new BadRequestException(
            `The laboratory has no method declared for ${test?.code ?? 'that test'}; add one before requesting it`,
          );
        }

        const existing = await tx.one<{ id: string }>(
          `SELECT id FROM test_requests
           WHERE sample_id = $1 AND lab_test_id = $2 AND test_method_id = $3
             AND status NOT IN ('cancelled', 'rejected')`,
          [sample.id, want.labTestId, methodId],
        );
        if (existing) {
          // The unique index would refuse it anyway; saying so plainly beats a constraint error.
          if (input.skipDuplicates || input.usePanel) {
            skipped.push(want.labTestId);
            continue;
          }
          const test = await tx.one<{ code: string }>('SELECT code FROM lab_tests WHERE id = $1', [want.labTestId]);
          throw new ConflictException(
            `${test?.code ?? 'That analysis'} is already requested on ${sample.sample_number}`,
          );
        }

        const specificationId = await tx.one<{ id: string | null }>(
          `SELECT app_resolve_specification($1, $2, $3, $4, $5, current_date) AS id`,
          [want.labTestId, methodId, sample.commodity_id, sample.client_id, await this.contractOf(tx, sample.job_id)],
        );

        const row = await tx.one<{ id: string }>(
          `INSERT INTO test_requests (branch_id, sample_id, laboratory_id, lab_test_id, test_method_id,
                                      specification_id, priority, requested_by, due_at, instructions)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::job_priority, 'normal'), $8, $9::timestamptz, $10)
           RETURNING id`,
          [sample.branch_id, sample.id, laboratoryId, want.labTestId, methodId,
           specificationId?.id ?? null, input.priority ?? null, user.id, input.dueAt ?? null,
           input.instructions ?? null],
        );
        created.push(row!.id);

        await tx.exec(
          `INSERT INTO test_request_status_history (test_request_id, branch_id, from_status, to_status,
                                                    changed_by, metadata)
           VALUES ($1, $2, NULL, 'requested'::test_request_status, $3, '{"action":"request"}'::jsonb)`,
          [row!.id, sample.branch_id, user.id],
        );
      }

      if (created.length) {
        await this.audit.record(tx, user, {
          action: 'lab.requested',
          entityType: 'sample',
          entityId: sample.id,
          entityLabel: sample.sample_number,
          branchId: sample.branch_id,
          after: { laboratoryId, requested: created.length, skipped: skipped.length },
        });
      }

      const rows = await tx.many<TestRequest>(
        `SELECT ${REQUEST_COLUMNS} FROM ${REQUEST_FROM} WHERE r.id = ANY($1::uuid[]) ORDER BY t.sort_order`,
        [created],
      );
      return { created: rows, skipped: skipped.length };
    });
  }

  /**
   * Gives the work to an analyst. The checks are the ones a laboratory manager would make out
   * loud: is this person still with us, can they enter results at all, and are they in an
   * office that can see this laboratory.
   */
  assign(user: AuthUser, id: string, analystId: string, note?: string | null) {
    return this.db.tx(user, async (tx) => {
      const request = await this.load(tx, id, true);
      const analyst = await tx.one<{ id: string; is_active: boolean; full_name: string; branch_id: string }>(
        'SELECT id, is_active, full_name, branch_id FROM users WHERE id = $1',
        [analystId],
      );
      if (!analyst) throw new BadRequestException('Unknown person');
      if (!analyst.is_active) throw new BadRequestException(`${analyst.full_name} is deactivated`);

      const canEnter = await tx.one<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM user_roles ur
           JOIN role_permissions rp ON rp.role_code = ur.role_code
           WHERE ur.user_id = $1 AND rp.permission_code = 'lab.result.enter'
         ) AS ok`,
        [analystId],
      );
      if (!canEnter?.ok) {
        throw new BadRequestException(`${analyst.full_name} is not allowed to enter laboratory results`);
      }

      const sameReach = await tx.one<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM laboratories l
           WHERE l.id = $1 AND (l.branch_id = $2 OR l.branch_id IS NULL)
         ) AS ok`,
        [request.laboratoryId, analyst.branch_id],
      );
      if (!sameReach?.ok) {
        throw new BadRequestException(`${analyst.full_name} does not work at this laboratory's office`);
      }

      await this.workflow.apply(tx, user, { ...request, assignedAnalystId: analystId }, 'assign', {
        reason: note,
        metadata: { analyst: analyst.full_name },
        extraSet: 'assigned_analyst_id = $2, assigned_by = $3, assigned_at = now()',
        extraParams: [analystId, user.id],
      });
      return this.load(tx, id);
    });
  }

  /** The one way a test request changes status. */
  transition(user: AuthUser, id: string, action: TestRequestAction, reason?: string | null) {
    return this.db.tx(user, async (tx) => {
      const request = await this.load(tx, id, true);

      if (action === 'start' && request.assignedAnalystId && request.assignedAnalystId !== user.id
          && !(user.permissions?.includes('lab.test.assign') ?? false)) {
        throw new ConflictException('This analysis is assigned to somebody else');
      }

      await this.workflow.apply(tx, user, request, action, {
        reason,
        ...(action === 'reject' || action === 'cancel'
          ? { extraSet: 'cancel_reason = $2', extraParams: [reason ?? null] }
          : {}),
      });
      return this.load(tx, id);
    });
  }

  history(user: AuthUser, id: string): Promise<TestRequestHistoryEntry[]> {
    return this.db.tx(user, async (tx) => {
      await this.load(tx, id);
      return tx.many<TestRequestHistoryEntry>(
        `SELECT h.id::text AS id, h.test_request_id AS "testRequestId", h.from_status AS "fromStatus",
                h.to_status AS "toStatus", h.changed_by AS "changedBy", u.full_name AS "changedByName",
                h.reason, h.metadata, h.created_at AS "createdAt"
         FROM test_request_status_history h LEFT JOIN users u ON u.id = h.changed_by
         WHERE h.test_request_id = $1 ORDER BY h.created_at, h.id`,
        [id],
      );
    });
  }

  /** Every figure is a query against the same rows the queue shows; none is an estimate. */
  dashboard(user: AuthUser, laboratoryId?: string): Promise<LabDashboard> {
    return this.db.tx(user, async (tx) => {
      const row = await tx.one<LabDashboard>(
        `SELECT
           (SELECT count(*)::int FROM samples sa
            WHERE sa.status = 'accepted_by_lab' AND sa.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM test_requests q WHERE q.sample_id = sa.id
                              AND q.status NOT IN ('cancelled','rejected'))) AS "samplesAwaitingTests",
           count(*) FILTER (WHERE r.assigned_analyst_id IS NULL
                              AND r.status = 'requested')::int AS "unassigned",
           count(*) FILTER (WHERE r.status = 'in_progress')::int AS "inProgress",
           count(*) FILTER (WHERE r.status = 'under_review'
                              AND NOT EXISTS (SELECT 1 FROM test_results v
                                              WHERE v.test_request_id = r.id AND v.is_current
                                                AND v.reviewed_by IS NOT NULL))::int AS "awaitingReview",
           count(*) FILTER (WHERE r.status = 'under_review'
                              AND EXISTS (SELECT 1 FROM test_results v
                                          WHERE v.test_request_id = r.id AND v.is_current
                                            AND v.reviewed_by IS NOT NULL))::int AS "awaitingApproval",
           count(*) FILTER (WHERE r.status = 'approved')::int AS "awaitingRelease",
           count(*) FILTER (WHERE r.due_at IS NOT NULL AND r.due_at < now()
                              AND r.status IN ('requested','assigned','in_progress','result_entered',
                                               'under_review','on_hold'))::int AS "overdue",
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM test_results v
                                          WHERE v.test_request_id = r.id AND v.is_current
                                            AND v.evaluation = 'out_of_spec'))::int AS "outOfSpec"
         FROM test_requests r
         WHERE ($1::uuid IS NULL OR r.laboratory_id = $1::uuid)`,
        [laboratoryId ?? null],
      );
      return row!;
    });
  }

  // ---- Internals -------------------------------------------------------------------------

  private async defaultMethod(tx: Tx, labTestId: string): Promise<string | null> {
    const row = await tx.one<{ id: string }>(
      `SELECT id FROM test_methods
       WHERE lab_test_id = $1 AND is_active AND retired_at IS NULL
       ORDER BY effective_from DESC, code LIMIT 1`,
      [labTestId],
    );
    return row?.id ?? null;
  }

  private async contractOf(tx: Tx, jobId: string): Promise<string | null> {
    const row = await tx.one<{ contract_id: string | null }>(
      'SELECT contract_id FROM inspection_jobs WHERE id = $1',
      [jobId],
    );
    return row?.contract_id ?? null;
  }
}
