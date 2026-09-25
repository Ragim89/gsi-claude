import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ASSIGNMENT_ROLES,
  AssignmentRole,
  AuthUser,
  CHECKLIST_TEMPLATES,
  InspectionJob,
  JobAction,
  JobAssignment,
  JobObjectKind,
  JobPriority,
  JobStatus,
  JobStatusHistoryEntry,
  Page,
  ServiceType,
} from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { buildSet } from '../common/sql';
import { openInspection } from '../inspections/open-inspection';
import { ReportDocumentsService } from '../documents/report-documents.service';
import { JOB_COLUMNS, JOB_FROM } from './job-sql';
import { AuditService } from '../common/audit.service';
import { JobWorkflowService } from './job-workflow.service';
import { JobEventsService } from './job-events.service';

export type JobSort = 'jobNumber' | 'requestedDate' | 'scheduledAt' | 'priority' | 'status' | 'updatedAt';

export interface JobFilters {
  status?: JobStatus;
  /** Anything not finished or cancelled — what an operations screen opens on. */
  active?: boolean;
  priority?: JobPriority;
  clientId?: string;
  contractId?: string;
  inspectorId?: string;
  /** Jobs the caller is assigned to, in any role — the "my jobs" view. */
  mine?: boolean;
  search?: string;
  /** HQ users can narrow the group view to one branch; RLS still bounds everyone else. */
  branchId?: string;
  countryId?: string;
  // Reference and period filters (the calendar range on every list screen).
  commodityId?: string;
  commodityGroup?: string;
  portId?: string;
  contractNo?: string;
  minQuantity?: number;
  maxQuantity?: number;
  /** Inclusive range over the job date (scheduled date, falling back to creation). */
  from?: string;
  to?: string;
  type?: ServiceType;
  sort?: JobSort;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface CreateJobInput {
  clientId: string;
  type: ServiceType;
  location?: string;
  status?: 'draft' | 'confirmed';
  priority?: JobPriority;
  clientContactId?: string | null;
  contractId?: string | null;
  clientReference?: string | null;
  requestingBranchId?: string | null;
  city?: string | null;
  objectKind?: JobObjectKind | null;
  containerNo?: string | null;
  transportRef?: string | null;
  commodityId?: string | null;
  portId?: string | null;
  contractNo?: string | null;
  quantityValue?: number | null;
  quantityUnit?: string | null;
  vesselOrObject?: string | null;
  commodity?: string | null;
  quantity?: string | null;
  requestedDate?: string | null;
  scheduledAt?: string | null;
  instructions?: string | null;
  internalNotes?: string | null;
  assignedInspectorId?: string | null;
}

export type UpdateJobInput = Partial<Omit<CreateJobInput, 'clientId' | 'type' | 'status'>> & {
  /** The version the form was loaded with; a stale one is refused instead of overwriting. */
  version?: number;
};

const SORT_COLUMNS: Record<JobSort, string> = {
  jobNumber: 'j.job_number',
  requestedDate: 'j.requested_date',
  scheduledAt: 'j.scheduled_at',
  // Urgent first when sorting descending: the enum is declared low → urgent.
  priority: 'j.priority',
  status: 'j.status',
  updatedAt: 'j.updated_at',
};

const UPDATABLE = {
  location: 'location',
  vesselOrObject: 'vessel_or_object',
  commodity: 'commodity',
  quantity: 'quantity',
  commodityId: 'commodity_id',
  portId: 'port_id',
  contractNo: 'contract_no',
  contractId: 'contract_id',
  clientContactId: 'client_contact_id',
  clientReference: 'client_reference',
  requestingBranchId: 'requesting_branch_id',
  city: 'city',
  objectKind: 'object_kind',
  containerNo: 'container_no',
  transportRef: 'transport_ref',
  priority: 'priority',
  quantityValue: 'quantity_value',
  quantityUnit: 'quantity_unit',
  requestedDate: 'requested_date',
  scheduledAt: 'scheduled_at',
  instructions: 'instructions',
  internalNotes: 'internal_notes',
};

/**
 * Inspection jobs — the operational centre of the platform (docs/01-architecture.md, module 2).
 *
 * Status changes do not happen here: they go through JobWorkflowService, which is the only
 * code in the system that writes `status`.
 */
@Injectable()
export class JobsService {
  constructor(
    private readonly db: DbService,
    private readonly reports: ReportDocumentsService,
    private readonly audit: AuditService,
    private readonly workflow: JobWorkflowService,
    private readonly events: JobEventsService,
  ) {}

  /**
   * The job list: paginated on the server, because this table grows faster than any other
   * and a list screen has no business pulling a year of work to show fifty rows.
   */
  async list(user: AuthUser, f: JobFilters): Promise<Page<InspectionJob>> {
    const limit = f.limit ?? 50;
    const offset = f.offset ?? 0;
    const sort = SORT_COLUMNS[f.sort ?? 'scheduledAt'] ?? SORT_COLUMNS.scheduledAt;
    const dir = f.dir === 'asc' ? 'ASC' : 'DESC';

    const params = [
      f.status ?? null,
      f.clientId ?? null,
      f.inspectorId ?? null,
      f.search?.trim() || null,
      f.branchId ?? null,
      f.commodityId ?? null,
      f.portId ?? null,
      f.contractNo?.trim() || null,
      f.minQuantity ?? null,
      f.maxQuantity ?? null,
      f.from ?? null,
      f.to ?? null,
      f.type ?? null,
      f.commodityGroup ?? null,
      f.priority ?? null,
      f.active ?? null,
      f.mine ? user.id : null,
      f.countryId ?? null,
      f.contractId ?? null,
    ];

    const where = `
      WHERE ($1::job_status IS NULL OR j.status = $1::job_status)
        AND ($2::uuid IS NULL OR j.client_id = $2::uuid)
        AND ($3::uuid IS NULL OR j.assigned_inspector_id = $3::uuid
             OR EXISTS (SELECT 1 FROM job_assignments a
                        WHERE a.job_id = j.id AND a.user_id = $3::uuid AND a.removed_at IS NULL))
        AND ($4::text IS NULL OR j.job_number ILIKE '%' || $4 || '%' OR c.name ILIKE '%' || $4 || '%'
             OR j.vessel_or_object ILIKE '%' || $4 || '%' OR j.location ILIKE '%' || $4 || '%'
             OR j.client_reference ILIKE '%' || $4 || '%' OR j.contract_no ILIKE '%' || $4 || '%'
             OR ctr.contract_no ILIKE '%' || $4 || '%' OR j.commodity ILIKE '%' || $4 || '%'
             OR j.container_no ILIKE '%' || $4 || '%')
        AND ($5::uuid IS NULL OR j.branch_id = $5::uuid)
        AND ($6::uuid IS NULL OR j.commodity_id = $6::uuid)
        AND ($7::uuid IS NULL OR j.port_id = $7::uuid)
        AND ($8::text IS NULL OR j.contract_no ILIKE '%' || $8 || '%')
        AND ($9::numeric IS NULL OR j.quantity_value >= $9::numeric)
        AND ($10::numeric IS NULL OR j.quantity_value <= $10::numeric)
        AND ($11::date IS NULL OR COALESCE(j.scheduled_at::date, j.requested_date, j.created_at::date) >= $11::date)
        AND ($12::date IS NULL OR COALESCE(j.scheduled_at::date, j.requested_date, j.created_at::date) <= $12::date)
        AND ($13::service_type IS NULL OR j.type = $13::service_type)
        AND ($14::commodity_group IS NULL OR cm."group" = $14::commodity_group)
        AND ($15::job_priority IS NULL OR j.priority = $15::job_priority)
        AND ($16::boolean IS NOT TRUE OR j.status NOT IN ('closed', 'cancelled', 'completed', 'invoiced'))
        AND ($17::uuid IS NULL OR j.assigned_inspector_id = $17::uuid
             OR EXISTS (SELECT 1 FROM job_assignments a
                        WHERE a.job_id = j.id AND a.user_id = $17::uuid AND a.removed_at IS NULL))
        AND ($18::uuid IS NULL OR b.country_id = $18::uuid)
        AND ($19::uuid IS NULL OR j.contract_id = $19::uuid)
        AND j.deleted_at IS NULL`;

    return this.db.tx(user, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.many<InspectionJob>(
          `SELECT ${JOB_COLUMNS} FROM ${JOB_FROM} ${where}
           ORDER BY ${sort} ${dir} NULLS LAST, j.job_number DESC
           LIMIT ${limit} OFFSET ${offset}`,
          params,
        ),
        tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${JOB_FROM} ${where}`, params),
      ]);
      return { rows, total: total?.n ?? 0, limit, offset };
    });
  }

  get(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const job = await this.load(tx, id);
      return { ...job, actions: this.workflow.available(user, job) };
    });
  }

  async load(tx: Tx, id: string, forUpdate = false): Promise<InspectionJob> {
    const job = await tx.one<InspectionJob>(
      `SELECT ${JOB_COLUMNS} FROM ${JOB_FROM}
       WHERE j.id = $1 AND j.deleted_at IS NULL ${forUpdate ? 'FOR UPDATE OF j' : ''}`,
      [id],
    );
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  /**
   * A job can be created as a draft with very little filled in — operations often opens one
   * from a phone call — or straight as confirmed when everything is known.
   */
  create(user: AuthUser, input: CreateJobInput) {
    if (!CHECKLIST_TEMPLATES[input.type]) throw new BadRequestException('Unknown service type');
    const status: JobStatus = input.status === 'confirmed' ? 'confirmed' : 'draft';
    if (status === 'confirmed' && !input.location?.trim()) {
      throw new BadRequestException('A confirmed job needs the place of inspection');
    }

    return this.db.tx(user, async (tx) => {
      // The job lives in the client's branch; RLS guarantees the caller can see that client.
      const client = await tx.one<{ branch_id: string }>('SELECT branch_id FROM clients WHERE id = $1', [input.clientId]);
      if (!client) throw new NotFoundException('Client not found');
      if (input.assignedInspectorId) await this.assertInspector(tx, input.assignedInspectorId, client.branch_id);
      await this.assertClientLinks(tx, input.clientId, input.contractId, input.clientContactId);

      const row = await tx.one<{ id: string }>(
        `INSERT INTO inspection_jobs (branch_id, job_number, client_id, type, status, assigned_inspector_id,
                                      location, vessel_or_object, commodity, quantity, scheduled_at, instructions,
                                      commodity_id, port_id, contract_no, quantity_value, quantity_unit,
                                      contract_id, client_contact_id, client_reference, requesting_branch_id,
                                      city, object_kind, container_no, transport_ref, priority, requested_date,
                                      internal_notes, created_by)
         VALUES ($1, next_doc_number($1, 'J'), $2, $3, $4::job_status, $5, COALESCE($6, ''), $7, $8, $9, $10, $11,
                 $12, $13, $14, $15, COALESCE($16, 'MT'), $17, $18, $19, $20, $21, $22::job_object_kind, $23, $24,
                 COALESCE($25::job_priority, 'normal'), COALESCE($26::date, current_date), $27, $28)
         RETURNING id`,
        [client.branch_id, input.clientId, input.type, status,
         input.assignedInspectorId ?? null, input.location?.trim() ?? null, input.vesselOrObject ?? null,
         input.commodity ?? null, input.quantity ?? null, input.scheduledAt ?? null, input.instructions ?? null,
         input.commodityId ?? null, input.portId ?? null, input.contractNo?.trim() || null,
         input.quantityValue ?? null, input.quantityUnit ?? null, input.contractId ?? null,
         input.clientContactId ?? null, input.clientReference ?? null, input.requestingBranchId ?? null,
         input.city ?? null, input.objectKind ?? null, input.containerNo ?? null, input.transportRef ?? null,
         input.priority ?? null, input.requestedDate ?? null, input.internalNotes ?? null, user.id],
      );
      // A job opens with the inspection that carries its field work — and with it the
      // checklist, which is where a job's checklist has lived since this phase. More
      // inspections can be added to the same job at any time.
      await openInspection(tx, this.audit, user, {
        jobId: row!.id,
        branchId: client.branch_id,
        type: input.type,
        leadInspectorId: input.assignedInspectorId ?? null,
        location: input.location?.trim() ?? null,
        city: input.city ?? null,
        scheduledStart: input.scheduledAt ?? null,
        instructions: input.instructions ?? null,
      });

      // The inspector named at creation becomes the lead, and the job moves to assigned.
      if (input.assignedInspectorId) {
        await this.addAssignment(tx, user, row!.id, client.branch_id, input.assignedInspectorId, 'lead_inspector');
        if (status === 'confirmed') {
          await tx.exec(`UPDATE inspection_jobs SET status = 'assigned' WHERE id = $1`, [row!.id]);
        }
      }

      const job = await this.load(tx, row!.id);
      await tx.exec(
        `INSERT INTO job_status_history (job_id, branch_id, from_status, to_status, changed_by, metadata)
         VALUES ($1, $2, NULL, $3::job_status, $4, '{"action":"create"}'::jsonb)`,
        [job.id, job.branchId, job.status, user.id],
      );
      await this.audit.record(tx, user, {
        action: 'job.create',
        entityType: 'job',
        entityId: job.id,
        entityLabel: job.jobNumber,
        branchId: job.branchId,
        after: { clientId: input.clientId, type: input.type, status: job.status, priority: job.priority },
      });
      return job;
    });
  }

  update(user: AuthUser, id: string, input: UpdateJobInput) {
    const { version, ...fields } = input;
    const { sql, params } = buildSet(fields as Record<string, unknown>, UPDATABLE, 2);
    if (!sql) throw new BadRequestException('Nothing to update');

    return this.db.tx(user, async (tx) => {
      const job = await this.load(tx, id, true);
      if (['approved', 'completed', 'invoiced', 'closed', 'cancelled'].includes(job.status)) {
        throw new ConflictException(`A job that is ${job.status.replace(/_/g, ' ')} can no longer be edited`);
      }
      // Optimistic locking: two clerks with the same job open no longer overwrite each other.
      if (version !== undefined && version !== job.version) {
        throw new ConflictException(
          'This job was changed by someone else while you were editing it. Reload it and try again.',
        );
      }
      await this.assertClientLinks(tx, job.clientId, fields.contractId, fields.clientContactId);

      await tx.exec(`UPDATE inspection_jobs SET ${sql} WHERE id = $1`, [id, ...params]);
      const after = await this.load(tx, id);
      const changed = AuditService.diff(
        job as unknown as Record<string, unknown>,
        after as unknown as Record<string, unknown>,
      );
      if (changed) {
        await this.audit.record(tx, user, {
          action: 'job.update',
          entityType: 'job',
          entityId: id,
          entityLabel: job.jobNumber,
          branchId: job.branchId,
          before: changed.before,
          after: changed.after,
        });
      }
      return after;
    });
  }

  // ---- Lifecycle ---------------------------------------------------------------------
  // Everything below hands the actual status change to the workflow service.

  transition(user: AuthUser, id: string, action: JobAction, reason?: string | null, metadata?: Record<string, unknown>) {
    return this.db.tx(user, async (tx) => {
      const job = await this.load(tx, id, true);

      // A few actions carry side effects of their own beyond the status.
      if (action === 'start' || action === 'submit') await this.assertAssignedInspector(tx, user, job);

      const extra =
        action === 'submit'
          ? { extraSet: 'submitted_at = now(), review_comment = NULL' }
          : action === 'return'
            ? { extraSet: 'review_comment = $2', extraParams: [reason ?? null] }
            : action === 'approve'
              ? { extraSet: 'approved_at = now(), approved_by = $2', extraParams: [user.id] }
              : {};

      await this.workflow.apply(tx, user, job, action, { reason, metadata, ...extra });

      // Approval issues the report in the same transaction, so a job is never approved
      // without its document (and a failed render leaves it under review).
      if (action === 'approve') {
        const report = await this.reports.issueForJob(tx, user, id);
        await this.audit.record(tx, user, {
          action: 'report.issue',
          entityType: 'report',
          entityId: report.id,
          entityLabel: report.reportNumber,
          branchId: job.branchId,
          after: { jobNumber: job.jobNumber, version: report.version, status: report.status },
        });
        return { job: await this.load(tx, id), report };
      }
      return { job: await this.load(tx, id) };
    });
  }

  // ---- Assignments -------------------------------------------------------------------

  listAssignments(user: AuthUser, jobId: string): Promise<JobAssignment[]> {
    return this.db.tx(user, async (tx) => {
      await this.load(tx, jobId);
      return tx.many<JobAssignment>(
        `SELECT a.id, a.job_id AS "jobId", a.user_id AS "userId", u.full_name AS "userName", u.email AS "userEmail",
                a.role, a.assigned_by AS "assignedBy", ab.full_name AS "assignedByName",
                a.assigned_at AS "assignedAt", a.removed_at AS "removedAt", a.note
         FROM job_assignments a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN users ab ON ab.id = a.assigned_by
         WHERE a.job_id = $1 AND a.removed_at IS NULL
         ORDER BY a.role, u.full_name`,
        [jobId],
      );
    });
  }

  /**
   * Puts someone on a job. The first assignment also moves a confirmed job to assigned —
   * that is what "assigned" means, and it goes through the workflow like any other change.
   */
  assign(user: AuthUser, jobId: string, userId: string, role: AssignmentRole = 'inspector', note?: string | null) {
    if (!ASSIGNMENT_ROLES.includes(role)) throw new BadRequestException('Unknown assignment role');
    return this.db.tx(user, async (tx) => {
      const job = await this.load(tx, jobId, true);
      if (['approved', 'completed', 'invoiced', 'closed', 'cancelled'].includes(job.status)) {
        throw new ConflictException(`A job that is ${job.status.replace(/_/g, ' ')} can no longer be reassigned`);
      }
      await this.assertAssignable(tx, userId, job.branchId);
      await this.addAssignment(tx, user, jobId, job.branchId, userId, role, note);

      if (job.status === 'confirmed') {
        await this.workflow.apply(tx, user, job, 'assign', { metadata: { userId, role } });
      }
      return this.listAssignmentsIn(tx, jobId);
    });
  }

  removeAssignment(user: AuthUser, jobId: string, assignmentId: string) {
    return this.db.tx(user, async (tx) => {
      const job = await this.load(tx, jobId, true);
      const row = await tx.one<{ user_id: string; role: AssignmentRole; full_name: string }>(
        `SELECT a.user_id, a.role, u.full_name FROM job_assignments a JOIN users u ON u.id = a.user_id
         WHERE a.id = $1 AND a.job_id = $2 AND a.removed_at IS NULL`,
        [assignmentId, jobId],
      );
      if (!row) throw new NotFoundException('Assignment not found');

      await tx.exec('UPDATE job_assignments SET removed_at = now(), removed_by = $2 WHERE id = $1', [
        assignmentId,
        user.id,
      ]);
      // The lead is mirrored on the job for the report and for "own" scope.
      if (row.role === 'lead_inspector') {
        await tx.exec('UPDATE inspection_jobs SET assigned_inspector_id = NULL WHERE id = $1', [jobId]);
      }
      await this.audit.record(tx, user, {
        action: 'job.assignment_changed',
        entityType: 'job',
        entityId: jobId,
        entityLabel: job.jobNumber,
        branchId: job.branchId,
        before: { user: row.full_name, role: row.role },
        metadata: { removed: true },
      });
      this.events.emit({
        type: 'job.unassigned',
        jobId,
        jobNumber: job.jobNumber,
        branchId: job.branchId,
        actorId: user.id,
        userId: row.user_id,
      });
      return this.listAssignmentsIn(tx, jobId);
    });
  }

  // ---- History, archive, restore ------------------------------------------------------

  history(user: AuthUser, jobId: string): Promise<JobStatusHistoryEntry[]> {
    return this.db.tx(user, async (tx) => {
      await this.load(tx, jobId);
      return tx.many<JobStatusHistoryEntry>(
        `SELECT h.id::text AS id, h.job_id AS "jobId", h.from_status AS "fromStatus", h.to_status AS "toStatus",
                h.changed_by AS "changedBy", u.full_name AS "changedByName", h.reason, h.metadata,
                h.created_at AS "createdAt"
         FROM job_status_history h
         LEFT JOIN users u ON u.id = h.changed_by
         WHERE h.job_id = $1
         ORDER BY h.created_at, h.id`,
        [jobId],
      );
    });
  }

  /**
   * Archiving hides a job from the lists; it is not the same as cancelling it, which is a
   * business outcome and stays visible. Only work that never started can be archived.
   */
  archive(user: AuthUser, id: string) {
    return this.db.tx(
      user,
      async (tx) => {
        const job = await this.load(tx, id, true);
        if (!['draft', 'confirmed', 'cancelled'].includes(job.status)) {
          throw new ConflictException('Only draft, confirmed or cancelled jobs can be archived; cancel it first');
        }
        await tx.exec('UPDATE inspection_jobs SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [id, user.id]);
        await this.audit.record(tx, user, {
          action: 'job.archive',
          entityType: 'job',
          entityId: id,
          entityLabel: job.jobNumber,
          branchId: job.branchId,
          before: { status: job.status },
        });
      },
      { includeArchived: true },
    );
  }

  restore(user: AuthUser, id: string) {
    return this.db.tx(
      user,
      async (tx) => {
        const job = await tx.one<InspectionJob>(
          `SELECT ${JOB_COLUMNS} FROM ${JOB_FROM} WHERE j.id = $1 AND j.deleted_at IS NOT NULL`,
          [id],
        );
        if (!job) throw new NotFoundException('Archived job not found');
        await tx.exec('UPDATE inspection_jobs SET deleted_at = NULL, deleted_by = NULL WHERE id = $1', [id]);
        await this.audit.record(tx, user, {
          action: 'job.restore',
          entityType: 'job',
          entityId: id,
          entityLabel: job.jobNumber,
          branchId: job.branchId,
          after: { status: job.status },
        });
        return job;
      },
      { includeArchived: true },
    );
  }

  /** The archive itself, for an administrator looking for something that was put away. */
  listArchived(user: AuthUser, f: { branchId?: string; limit?: number; offset?: number }): Promise<Page<InspectionJob>> {
    const limit = f.limit ?? 50;
    const offset = f.offset ?? 0;
    return this.db.tx(
      user,
      async (tx) => {
        const params = [f.branchId ?? null];
        const where = `WHERE j.deleted_at IS NOT NULL AND ($1::uuid IS NULL OR j.branch_id = $1::uuid)`;
        const [rows, total] = await Promise.all([
          tx.many<InspectionJob>(
            `SELECT ${JOB_COLUMNS} FROM ${JOB_FROM} ${where}
             ORDER BY j.deleted_at DESC LIMIT ${limit} OFFSET ${offset}`,
            params,
          ),
          tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${JOB_FROM} ${where}`, params),
        ]);
        return { rows, total: total?.n ?? 0, limit, offset };
      },
      { includeArchived: true },
    );
  }

  // ---- Internals ----------------------------------------------------------------------

  private async addAssignment(
    tx: Tx,
    user: AuthUser,
    jobId: string,
    branchId: string,
    userId: string,
    role: AssignmentRole,
    note?: string | null,
  ) {
    // One lead at a time: the previous one steps back to plain inspector.
    if (role === 'lead_inspector') {
      await tx.exec(
        `UPDATE job_assignments SET role = 'inspector'
         WHERE job_id = $1 AND role = 'lead_inspector' AND removed_at IS NULL AND user_id <> $2`,
        [jobId, userId],
      );
      await tx.exec('UPDATE inspection_jobs SET assigned_inspector_id = $2 WHERE id = $1', [jobId, userId]);
    }
    await tx.exec(
      `INSERT INTO job_assignments (job_id, branch_id, user_id, role, assigned_by, note)
       VALUES ($1, $2, $3, $4::assignment_role, $5, $6)
       ON CONFLICT DO NOTHING`,
      [jobId, branchId, userId, role, user.id, note ?? null],
    );

    const job = await tx.one<{ job_number: string }>('SELECT job_number FROM inspection_jobs WHERE id = $1', [jobId]);
    await this.audit.record(tx, user, {
      action: 'job.assign',
      entityType: 'job',
      entityId: jobId,
      entityLabel: job?.job_number ?? '',
      branchId,
      after: { userId, role },
    });
    this.events.emit({
      type: 'job.assigned',
      jobId,
      jobNumber: job?.job_number ?? '',
      branchId,
      actorId: user.id,
      userId,
    });
  }

  private listAssignmentsIn(tx: Tx, jobId: string) {
    return tx.many<JobAssignment>(
      `SELECT a.id, a.job_id AS "jobId", a.user_id AS "userId", u.full_name AS "userName", u.email AS "userEmail",
              a.role, a.assigned_by AS "assignedBy", a.assigned_at AS "assignedAt",
              a.removed_at AS "removedAt", a.note
       FROM job_assignments a JOIN users u ON u.id = a.user_id
       WHERE a.job_id = $1 AND a.removed_at IS NULL
       ORDER BY a.role, u.full_name`,
      [jobId],
    );
  }

  /** The contract and the contact must belong to the client the job is for. */
  private async assertClientLinks(
    tx: Tx,
    clientId: string,
    contractId?: string | null,
    contactId?: string | null,
  ): Promise<void> {
    if (contractId) {
      const row = await tx.one<{ client_id: string; status: string }>(
        'SELECT client_id, status::text AS status FROM contracts WHERE id = $1',
        [contractId],
      );
      if (!row) throw new NotFoundException('Contract not found');
      if (row.client_id !== clientId) throw new BadRequestException('That contract belongs to another client');
    }
    if (contactId) {
      const row = await tx.one<{ client_id: string }>('SELECT client_id FROM client_contacts WHERE id = $1', [contactId]);
      if (!row) throw new NotFoundException('Contact not found');
      if (row.client_id !== clientId) throw new BadRequestException('That contact belongs to another client');
    }
  }

  /** Anyone assigned must be an active user of the same office. */
  private async assertAssignable(tx: Tx, userId: string, branchId: string): Promise<void> {
    const row = await tx.one<{ is_active: boolean; full_name: string }>(
      'SELECT is_active, full_name FROM users WHERE id = $1 AND branch_id = $2',
      [userId, branchId],
    );
    if (!row) throw new BadRequestException('That person does not work at the office responsible for this job');
    if (!row.is_active) throw new BadRequestException(`${row.full_name} is deactivated and cannot be assigned`);
  }

  private async assertInspector(tx: Tx, inspectorId: string, branchId: string): Promise<void> {
    await this.assertAssignable(tx, inspectorId, branchId);
  }

  private async assertAssignedInspector(tx: Tx, user: AuthUser, job: InspectionJob): Promise<void> {
    // ASSUMPTION: supervisors and admins may start or submit on behalf of an inspector (a
    // paper checklist typed in at the office). A field role must be on the job — in any
    // assignment role, not only as lead, so a sampler can record their own work.
    if (user.scope !== 'own') return;
    if (job.assignedInspectorId === user.id) return;
    const row = await tx.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM job_assignments WHERE job_id = $1 AND user_id = $2 AND removed_at IS NULL',
      [job.id, user.id],
    );
    if (!row?.n) throw new ForbiddenException('This job is not assigned to you');
  }
}
