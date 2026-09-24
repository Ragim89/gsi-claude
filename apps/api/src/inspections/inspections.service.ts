import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ASSIGNMENT_ROLES,
  AssignmentRole,
  AuthUser,
  CHECKLIST_TEMPLATES,
  EDITABLE_INSPECTION_STATUSES,
  FindingSeverity,
  FindingStatus,
  Inspection,
  InspectionAction,
  InspectionFinding,
  InspectionMeasurement,
  InspectionStatus,
  InspectionStatusHistoryEntry,
  JobAssignment,
  Page,
  ServiceType,
} from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { buildSet } from '../common/sql';
import { AuditService } from '../common/audit.service';
import { JobsService } from '../operations/jobs.service';
import { JobWorkflowService } from '../operations/job-workflow.service';
import { InspectionWorkflowService } from './inspection-workflow.service';
import { openInspection } from './open-inspection';

export type InspectionSort = 'inspectionNumber' | 'scheduledStart' | 'status' | 'updatedAt';

export interface InspectionFilters {
  jobId?: string;
  clientId?: string;
  status?: InspectionStatus;
  type?: ServiceType;
  inspectorId?: string;
  /** Everything the caller is on — the field worker's own list. */
  mine?: boolean;
  /** Not finished and not cancelled. */
  active?: boolean;
  branchId?: string;
  countryId?: string;
  search?: string;
  from?: string;
  to?: string;
  sort?: InspectionSort;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface CreateInspectionInput {
  jobId: string;
  type?: ServiceType;
  location?: string | null;
  city?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  leadInspectorId?: string | null;
  instructions?: string | null;
  /** Copy the job's checklist template for this inspection; on by default. */
  withChecklist?: boolean;
}

export type UpdateInspectionInput = Partial<{
  location: string | null;
  city: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  weatherConditions: string | null;
  siteConditions: string | null;
  generalObservations: string | null;
  conclusion: string | null;
  internalNotes: string | null;
  instructions: string | null;
  leadInspectorId: string | null;
  version: number;
}>;

const SORT_COLUMNS: Record<InspectionSort, string> = {
  inspectionNumber: 'i.inspection_number',
  scheduledStart: 'i.scheduled_start',
  status: 'i.status',
  updatedAt: 'i.updated_at',
};

const UPDATABLE = {
  location: 'location',
  city: 'city',
  scheduledStart: 'scheduled_start',
  scheduledEnd: 'scheduled_end',
  weatherConditions: 'weather_conditions',
  siteConditions: 'site_conditions',
  generalObservations: 'general_observations',
  conclusion: 'conclusion',
  internalNotes: 'internal_notes',
  instructions: 'instructions',
  leadInspectorId: 'lead_inspector_id',
};

const COLUMNS = `
  i.id, i.branch_id AS "branchId", b.code AS "branchCode", i.job_id AS "jobId", j.job_number AS "jobNumber",
  j.client_id AS "clientId", c.name AS "clientName", i.inspection_number AS "inspectionNumber",
  i.type, i.status, i.lead_inspector_id AS "leadInspectorId", u.full_name AS "leadInspectorName",
  i.location, i.city, i.scheduled_start AS "scheduledStart", i.scheduled_end AS "scheduledEnd",
  i.actual_start AS "actualStart", i.actual_end AS "actualEnd",
  i.weather_conditions AS "weatherConditions", i.site_conditions AS "siteConditions",
  i.general_observations AS "generalObservations", i.conclusion, i.internal_notes AS "internalNotes",
  i.instructions, i.status_before_hold AS "statusBeforeHold",
  i.reviewed_by AS "reviewedBy", rb.full_name AS "reviewedByName", i.reviewed_at AS "reviewedAt",
  i.review_comment AS "reviewComment", i.version, i.deleted_at AS "archivedAt",
  /* Overdue is computed, never stored: scheduled in the past while the work is still open. */
  (i.scheduled_start IS NOT NULL AND i.scheduled_start < now()
   AND i.status IN ('draft', 'scheduled', 'in_progress', 'on_hold')) AS "overdue",
  (SELECT count(*)::int FROM job_checklist_items x WHERE x.inspection_id = i.id) AS "checklistTotal",
  (SELECT count(*)::int FROM job_checklist_items x WHERE x.inspection_id = i.id AND x.result IS NOT NULL) AS "checklistDone",
  (SELECT count(*)::int FROM job_checklist_items x
     WHERE x.inspection_id = i.id AND x.is_required AND x.result IS NULL) AS "requiredRemaining",
  (SELECT count(*)::int FROM inspection_findings f WHERE f.inspection_id = i.id) AS "findingCount",
  (SELECT count(*)::int FROM inspection_measurements m WHERE m.inspection_id = i.id) AS "measurementCount",
  (SELECT count(*)::int FROM media_attachments p WHERE p.inspection_id = i.id) AS "photoCount",
  COALESCE((SELECT json_agg(json_build_object('id', a.id, 'userId', a.user_id, 'userName', au.full_name,
                                              'role', a.role) ORDER BY a.role, au.full_name)
            FROM inspection_assignments a JOIN users au ON au.id = a.user_id
            WHERE a.inspection_id = i.id AND a.removed_at IS NULL), '[]'::json) AS "assignees",
  i.created_by AS "createdBy", cb.full_name AS "createdByName",
  i.created_at AS "createdAt", i.updated_at AS "updatedAt"`;

const FROM = `
  inspections i
  JOIN branches b ON b.id = i.branch_id
  JOIN inspection_jobs j ON j.id = i.job_id
  JOIN clients c ON c.id = j.client_id
  LEFT JOIN users u ON u.id = i.lead_inspector_id
  LEFT JOIN users rb ON rb.id = i.reviewed_by
  LEFT JOIN users cb ON cb.id = i.created_by`;

/**
 * Inspections: the field work of a job.
 *
 * A job can hold several, so nothing here assumes one. Status changes go through
 * InspectionWorkflowService; the job's own status moves only through JobWorkflowService,
 * never by writing to the job row from here.
 */
@Injectable()
export class InspectionsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly workflow: InspectionWorkflowService,
    private readonly jobs: JobsService,
    private readonly jobWorkflow: JobWorkflowService,
  ) {}

  async list(user: AuthUser, f: InspectionFilters): Promise<Page<Inspection>> {
    const limit = f.limit ?? 50;
    const offset = f.offset ?? 0;
    const sort = SORT_COLUMNS[f.sort ?? 'scheduledStart'] ?? SORT_COLUMNS.scheduledStart;
    const dir = f.dir === 'asc' ? 'ASC' : 'DESC';

    const params = [
      f.jobId ?? null,
      f.status ?? null,
      f.type ?? null,
      f.inspectorId ?? null,
      f.search?.trim() || null,
      f.branchId ?? null,
      f.from ?? null,
      f.to ?? null,
      f.mine ? user.id : null,
      f.active ?? null,
      f.clientId ?? null,
      f.countryId ?? null,
    ];

    const where = `
      WHERE ($1::uuid IS NULL OR i.job_id = $1::uuid)
        AND ($2::inspection_status IS NULL OR i.status = $2::inspection_status)
        AND ($3::service_type IS NULL OR i.type = $3::service_type)
        AND ($4::uuid IS NULL OR i.lead_inspector_id = $4::uuid
             OR EXISTS (SELECT 1 FROM inspection_assignments a
                        WHERE a.inspection_id = i.id AND a.user_id = $4::uuid AND a.removed_at IS NULL))
        AND ($5::text IS NULL OR i.inspection_number ILIKE '%' || $5 || '%'
             OR j.job_number ILIKE '%' || $5 || '%' OR c.name ILIKE '%' || $5 || '%'
             OR i.location ILIKE '%' || $5 || '%' OR i.city ILIKE '%' || $5 || '%')
        AND ($6::uuid IS NULL OR i.branch_id = $6::uuid)
        AND ($7::date IS NULL OR COALESCE(i.scheduled_start, i.created_at)::date >= $7::date)
        AND ($8::date IS NULL OR COALESCE(i.scheduled_start, i.created_at)::date <= $8::date)
        AND ($9::uuid IS NULL OR i.lead_inspector_id = $9::uuid
             OR EXISTS (SELECT 1 FROM inspection_assignments a
                        WHERE a.inspection_id = i.id AND a.user_id = $9::uuid AND a.removed_at IS NULL))
        AND ($10::boolean IS NOT TRUE OR i.status NOT IN ('approved', 'cancelled'))
        AND ($11::uuid IS NULL OR j.client_id = $11::uuid)
        AND ($12::uuid IS NULL OR b.country_id = $12::uuid)
        AND i.deleted_at IS NULL`;

    return this.db.tx(user, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.many<Inspection>(
          `SELECT ${COLUMNS} FROM ${FROM} ${where}
           ORDER BY ${sort} ${dir} NULLS LAST, i.inspection_number DESC
           LIMIT ${limit} OFFSET ${offset}`,
          params,
        ),
        tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${FROM} ${where}`, params),
      ]);
      return { rows, total: total?.n ?? 0, limit, offset };
    });
  }

  get(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const inspection = await this.load(tx, id);
      return { ...inspection, actions: this.workflow.available(user, inspection) };
    });
  }

  async load(tx: Tx, id: string, forUpdate = false): Promise<Inspection> {
    const row = await tx.one<Inspection>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE i.id = $1 AND i.deleted_at IS NULL ${forUpdate ? 'FOR UPDATE OF i' : ''}`,
      [id],
    );
    if (!row) throw new NotFoundException('Inspection not found');
    return row;
  }

  /**
   * Opens an inspection on a job. The checklist template of the service type is copied into
   * it, so editing a template later never changes work that has already been done.
   */
  create(user: AuthUser, input: CreateInspectionInput) {
    return this.db.tx(user, async (tx) => {
      const job = await this.jobs.load(tx, input.jobId);
      if (['closed', 'cancelled'].includes(job.status)) {
        throw new ConflictException(`A job that is ${job.status} can no longer take new inspections`);
      }
      const type = input.type ?? job.type;
      if (!CHECKLIST_TEMPLATES[type]) throw new BadRequestException('Unknown inspection type');
      if (input.leadInspectorId) await this.assertAssignable(tx, input.leadInspectorId, job.branchId);

      const id = await openInspection(tx, this.audit, user, {
        jobId: job.id,
        branchId: job.branchId,
        type,
        leadInspectorId: input.leadInspectorId ?? null,
        location: input.location ?? job.location,
        city: input.city ?? job.city ?? null,
        scheduledStart: input.scheduledStart ?? null,
        scheduledEnd: input.scheduledEnd ?? null,
        instructions: input.instructions ?? null,
        withChecklist: input.withChecklist,
      });
      return this.load(tx, id);
    });
  }

  update(user: AuthUser, id: string, input: UpdateInspectionInput) {
    const { version, ...fields } = input;
    const { sql, params } = buildSet(fields as Record<string, unknown>, UPDATABLE, 2);
    if (!sql) throw new BadRequestException('Nothing to update');

    return this.db.tx(user, async (tx) => {
      const inspection = await this.load(tx, id, true);
      this.assertEditable(inspection);
      if (version !== undefined && version !== inspection.version) {
        throw new ConflictException('This inspection was updated by another user. Refresh before saving.');
      }
      if (fields.leadInspectorId) await this.assertAssignable(tx, fields.leadInspectorId, inspection.branchId);

      await tx.exec(`UPDATE inspections SET ${sql} WHERE id = $1`, [id, ...params]);
      const after = await this.load(tx, id);
      const changed = AuditService.diff(
        inspection as unknown as Record<string, unknown>,
        after as unknown as Record<string, unknown>,
      );
      if (changed) {
        await this.audit.record(tx, user, {
          action: 'inspection.update',
          entityType: 'inspection',
          entityId: id,
          entityLabel: inspection.inspectionNumber,
          branchId: inspection.branchId,
          before: changed.before,
          after: changed.after,
        });
      }
      return after;
    });
  }

  /**
   * Moves the inspection, and lets the job follow where that is unambiguous: the first
   * inspection to start moves an assigned job into progress. Nothing auto-completes a job —
   * a job with three inspections is not finished because one of them is.
   */
  transition(user: AuthUser, id: string, action: InspectionAction, reason?: string | null) {
    return this.db.tx(user, async (tx) => {
      const inspection = await this.load(tx, id, true);
      if (action === 'start') await this.assertOnInspection(tx, user, inspection);

      await this.workflow.apply(tx, user, inspection, action, { reason });

      if (action === 'start') {
        const job = await this.jobs.load(tx, inspection.jobId, true);
        if (job.status === 'assigned' && user.permissions?.includes('job.start')) {
          await this.jobWorkflow.apply(tx, user, job, 'start', {
            metadata: { via: 'inspection', inspectionNumber: inspection.inspectionNumber },
          });
        }
      }
      return this.load(tx, id);
    });
  }

  // ---- Assignments --------------------------------------------------------------------

  listAssignments(user: AuthUser, inspectionId: string): Promise<JobAssignment[]> {
    return this.db.tx(user, async (tx) => {
      await this.load(tx, inspectionId);
      return this.assignmentsIn(tx, inspectionId);
    });
  }

  assign(user: AuthUser, inspectionId: string, userId: string, role: AssignmentRole = 'inspector', note?: string) {
    if (!ASSIGNMENT_ROLES.includes(role)) throw new BadRequestException('Unknown assignment role');
    return this.db.tx(user, async (tx) => {
      const inspection = await this.load(tx, inspectionId, true);
      this.assertEditable(inspection, 'reassigned');
      await this.assertAssignable(tx, userId, inspection.branchId);
      await this.addAssignment(tx, user, inspectionId, inspection.branchId, userId, role, note);
      return this.assignmentsIn(tx, inspectionId);
    });
  }

  removeAssignment(user: AuthUser, inspectionId: string, assignmentId: string) {
    return this.db.tx(user, async (tx) => {
      const inspection = await this.load(tx, inspectionId, true);
      const row = await tx.one<{ user_id: string; role: AssignmentRole; full_name: string }>(
        `SELECT a.user_id, a.role, u.full_name FROM inspection_assignments a JOIN users u ON u.id = a.user_id
         WHERE a.id = $1 AND a.inspection_id = $2 AND a.removed_at IS NULL`,
        [assignmentId, inspectionId],
      );
      if (!row) throw new NotFoundException('Assignment not found');

      await tx.exec('UPDATE inspection_assignments SET removed_at = now(), removed_by = $2 WHERE id = $1', [
        assignmentId,
        user.id,
      ]);
      if (row.role === 'lead_inspector') {
        await tx.exec('UPDATE inspections SET lead_inspector_id = NULL WHERE id = $1', [inspectionId]);
      }
      await this.audit.record(tx, user, {
        action: 'inspection.assign',
        entityType: 'inspection',
        entityId: inspectionId,
        entityLabel: inspection.inspectionNumber,
        branchId: inspection.branchId,
        before: { user: row.full_name, role: row.role },
        metadata: { removed: true },
      });
      return this.assignmentsIn(tx, inspectionId);
    });
  }

  // ---- Findings -----------------------------------------------------------------------

  listFindings(user: AuthUser, inspectionId: string): Promise<InspectionFinding[]> {
    return this.db.tx(user, async (tx) => {
      await this.load(tx, inspectionId);
      return tx.many<InspectionFinding>(
        `SELECT f.id, f.inspection_id AS "inspectionId", f.category, f.severity, f.status, f.title,
                f.description, f.recommendation, f.is_internal AS "isInternal",
                f.created_by AS "createdBy", u.full_name AS "createdByName",
                f.created_at AS "createdAt", f.updated_at AS "updatedAt"
         FROM inspection_findings f LEFT JOIN users u ON u.id = f.created_by
         WHERE f.inspection_id = $1
         ORDER BY array_position(ARRAY['critical','major','minor','info']::text[], f.severity::text), f.created_at`,
        [inspectionId],
      );
    });
  }

  addFinding(
    user: AuthUser,
    inspectionId: string,
    input: {
      title: string;
      severity?: FindingSeverity;
      category?: string | null;
      description?: string | null;
      recommendation?: string | null;
      isInternal?: boolean;
    },
  ) {
    return this.db.tx(user, async (tx) => {
      const inspection = await this.load(tx, inspectionId);
      this.assertEditable(inspection, 'added to');
      const row = await tx.one<{ id: string }>(
        `INSERT INTO inspection_findings (inspection_id, branch_id, title, severity, category, description,
                                          recommendation, is_internal, created_by)
         VALUES ($1, $2, $3, COALESCE($4::finding_severity, 'minor'), $5, $6, $7, COALESCE($8, false), $9)
         RETURNING id`,
        [inspectionId, inspection.branchId, input.title.trim(), input.severity ?? null, input.category ?? null,
         input.description ?? null, input.recommendation ?? null, input.isInternal ?? null, user.id],
      );
      await this.audit.record(tx, user, {
        action: 'inspection.finding_added',
        entityType: 'inspection',
        entityId: inspectionId,
        entityLabel: inspection.inspectionNumber,
        branchId: inspection.branchId,
        after: { title: input.title.trim(), severity: input.severity ?? 'minor' },
      });
      return tx.one(
        `SELECT id, inspection_id AS "inspectionId", category, severity, status, title, description,
                recommendation, is_internal AS "isInternal", created_at AS "createdAt", updated_at AS "updatedAt"
         FROM inspection_findings WHERE id = $1`,
        [row!.id],
      );
    });
  }

  updateFinding(
    user: AuthUser,
    inspectionId: string,
    findingId: string,
    input: Partial<{
      title: string;
      severity: FindingSeverity;
      status: FindingStatus;
      category: string | null;
      description: string | null;
      recommendation: string | null;
      isInternal: boolean;
    }>,
  ) {
    const { sql, params } = buildSet(input as Record<string, unknown>, {
      title: 'title',
      severity: 'severity',
      status: 'status',
      category: 'category',
      description: 'description',
      recommendation: 'recommendation',
      isInternal: 'is_internal',
    }, 3);
    if (!sql) throw new BadRequestException('Nothing to update');

    return this.db.tx(user, async (tx) => {
      const inspection = await this.load(tx, inspectionId);
      // A finding may be resolved after approval — that is follow-up, not a rewrite of the
      // inspection — but its text is frozen with the rest of the evidence.
      // Only the fields actually sent count: a validated DTO carries every declared property,
      // undefined and all, so asking it what was set means asking what is not undefined.
      const touched = Object.entries(input)
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k);
      if (!EDITABLE_INSPECTION_STATUSES.includes(inspection.status) && touched.some((k) => k !== 'status')) {
        throw new ConflictException('This inspection is closed for editing; only a finding status may change');
      }
      const n = await tx.exec(
        `UPDATE inspection_findings SET ${sql} WHERE id = $1 AND inspection_id = $2`,
        [findingId, inspectionId, ...params],
      );
      if (!n) throw new NotFoundException('Finding not found');
      await this.audit.record(tx, user, {
        action: 'inspection.finding_updated',
        entityType: 'inspection',
        entityId: inspectionId,
        entityLabel: inspection.inspectionNumber,
        branchId: inspection.branchId,
        after: input as Record<string, unknown>,
      });
      return tx.one(
        `SELECT id, inspection_id AS "inspectionId", category, severity, status, title, description,
                recommendation, is_internal AS "isInternal", created_at AS "createdAt", updated_at AS "updatedAt"
         FROM inspection_findings WHERE id = $1`,
        [findingId],
      );
    });
  }

  // ---- Measurements -------------------------------------------------------------------

  listMeasurements(user: AuthUser, inspectionId: string): Promise<InspectionMeasurement[]> {
    return this.db.tx(user, async (tx) => {
      await this.load(tx, inspectionId);
      return tx.many<InspectionMeasurement>(
        `SELECT m.id, m.inspection_id AS "inspectionId", m.measurement_type AS "measurementType", m.label,
                m.value_numeric::float8 AS "valueNumeric", m.value_text AS "valueText", m.unit, m.position,
                m.measured_at AS "measuredAt", m.measured_by AS "measuredBy", u.full_name AS "measuredByName",
                m.metadata
         FROM inspection_measurements m LEFT JOIN users u ON u.id = m.measured_by
         WHERE m.inspection_id = $1 ORDER BY m.measured_at, m.created_at`,
        [inspectionId],
      );
    });
  }

  addMeasurement(
    user: AuthUser,
    inspectionId: string,
    input: {
      measurementType: string;
      label?: string | null;
      valueNumeric?: number | null;
      valueText?: string | null;
      unit?: string | null;
      position?: string | null;
      measuredAt?: string | null;
    },
  ) {
    if (input.valueNumeric == null && !input.valueText?.trim()) {
      throw new BadRequestException('A measurement needs a value');
    }
    return this.db.tx(user, async (tx) => {
      const inspection = await this.load(tx, inspectionId);
      this.assertEditable(inspection, 'added to');
      const row = await tx.one<{ id: string }>(
        `INSERT INTO inspection_measurements (inspection_id, branch_id, measurement_type, label, value_numeric,
                                              value_text, unit, position, measured_at, measured_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()), $10)
         RETURNING id`,
        [inspectionId, inspection.branchId, input.measurementType, input.label ?? null,
         input.valueNumeric ?? null, input.valueText ?? null, input.unit ?? null, input.position ?? null,
         input.measuredAt ?? null, user.id],
      );
      await this.audit.record(tx, user, {
        action: 'inspection.measurement_added',
        entityType: 'inspection',
        entityId: inspectionId,
        entityLabel: inspection.inspectionNumber,
        branchId: inspection.branchId,
        after: { type: input.measurementType, value: input.valueNumeric ?? input.valueText, unit: input.unit ?? null },
      });
      return tx.one(
        `SELECT id, inspection_id AS "inspectionId", measurement_type AS "measurementType", label,
                value_numeric::float8 AS "valueNumeric", value_text AS "valueText", unit, position,
                measured_at AS "measuredAt"
         FROM inspection_measurements WHERE id = $1`,
        [row!.id],
      );
    });
  }

  removeMeasurement(user: AuthUser, inspectionId: string, measurementId: string) {
    return this.db.tx(user, async (tx) => {
      const inspection = await this.load(tx, inspectionId);
      this.assertEditable(inspection, 'changed');
      const n = await tx.exec('DELETE FROM inspection_measurements WHERE id = $1 AND inspection_id = $2', [
        measurementId,
        inspectionId,
      ]);
      if (!n) throw new NotFoundException('Measurement not found');
      await this.audit.record(tx, user, {
        action: 'inspection.measurement_removed',
        entityType: 'inspection',
        entityId: inspectionId,
        entityLabel: inspection.inspectionNumber,
        branchId: inspection.branchId,
        metadata: { measurementId },
      });
    });
  }

  // ---- History and archive -------------------------------------------------------------

  history(user: AuthUser, inspectionId: string): Promise<InspectionStatusHistoryEntry[]> {
    return this.db.tx(user, async (tx) => {
      await this.load(tx, inspectionId);
      return tx.many<InspectionStatusHistoryEntry>(
        `SELECT h.id::text AS id, h.inspection_id AS "inspectionId", h.from_status AS "fromStatus",
                h.to_status AS "toStatus", h.changed_by AS "changedBy", u.full_name AS "changedByName",
                h.reason, h.metadata, h.created_at AS "createdAt"
         FROM inspection_status_history h LEFT JOIN users u ON u.id = h.changed_by
         WHERE h.inspection_id = $1 ORDER BY h.created_at, h.id`,
        [inspectionId],
      );
    });
  }

  archive(user: AuthUser, id: string) {
    return this.db.tx(
      user,
      async (tx) => {
        const inspection = await this.load(tx, id, true);
        if (!['draft', 'scheduled', 'cancelled'].includes(inspection.status)) {
          throw new ConflictException('Only a draft, scheduled or cancelled inspection can be archived');
        }
        await tx.exec('UPDATE inspections SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [id, user.id]);
        await this.audit.record(tx, user, {
          action: 'inspection.archive',
          entityType: 'inspection',
          entityId: id,
          entityLabel: inspection.inspectionNumber,
          branchId: inspection.branchId,
          before: { status: inspection.status },
        });
      },
      { includeArchived: true },
    );
  }

  restore(user: AuthUser, id: string) {
    return this.db.tx(
      user,
      async (tx) => {
        const row = await tx.one<Inspection>(
          `SELECT ${COLUMNS} FROM ${FROM} WHERE i.id = $1 AND i.deleted_at IS NOT NULL`,
          [id],
        );
        if (!row) throw new NotFoundException('Archived inspection not found');
        await tx.exec('UPDATE inspections SET deleted_at = NULL, deleted_by = NULL WHERE id = $1', [id]);
        await this.audit.record(tx, user, {
          action: 'inspection.restore',
          entityType: 'inspection',
          entityId: id,
          entityLabel: row.inspectionNumber,
          branchId: row.branchId,
          after: { status: row.status },
        });
        return row;
      },
      { includeArchived: true },
    );
  }

  // ---- Internals -----------------------------------------------------------------------

  private assertEditable(inspection: Inspection, verb = 'edited'): void {
    if (!EDITABLE_INSPECTION_STATUSES.includes(inspection.status)) {
      throw new ConflictException(
        `An inspection that is ${inspection.status.replace(/_/g, ' ')} can no longer be ${verb}` +
          (inspection.status === 'approved' ? '; reopen it first, which is recorded' : ''),
      );
    }
  }

  private async addAssignment(
    tx: Tx,
    user: AuthUser,
    inspectionId: string,
    branchId: string,
    userId: string,
    role: AssignmentRole,
    note?: string | null,
  ) {
    if (role === 'lead_inspector') {
      await tx.exec(
        `UPDATE inspection_assignments SET role = 'inspector'
         WHERE inspection_id = $1 AND role = 'lead_inspector' AND removed_at IS NULL AND user_id <> $2`,
        [inspectionId, userId],
      );
      await tx.exec('UPDATE inspections SET lead_inspector_id = $2 WHERE id = $1', [inspectionId, userId]);
    }
    await tx.exec(
      `INSERT INTO inspection_assignments (inspection_id, branch_id, user_id, role, assigned_by, note)
       VALUES ($1, $2, $3, $4::assignment_role, $5, $6) ON CONFLICT DO NOTHING`,
      [inspectionId, branchId, userId, role, user.id, note ?? null],
    );
    const row = await tx.one<{ inspection_number: string }>(
      'SELECT inspection_number FROM inspections WHERE id = $1',
      [inspectionId],
    );
    await this.audit.record(tx, user, {
      action: 'inspection.assign',
      entityType: 'inspection',
      entityId: inspectionId,
      entityLabel: row?.inspection_number ?? '',
      branchId,
      after: { userId, role },
    });
  }

  private assignmentsIn(tx: Tx, inspectionId: string) {
    return tx.many<JobAssignment>(
      `SELECT a.id, a.inspection_id AS "jobId", a.user_id AS "userId", u.full_name AS "userName",
              u.email AS "userEmail", a.role, a.assigned_by AS "assignedBy", a.assigned_at AS "assignedAt",
              a.removed_at AS "removedAt", a.note
       FROM inspection_assignments a JOIN users u ON u.id = a.user_id
       WHERE a.inspection_id = $1 AND a.removed_at IS NULL
       ORDER BY a.role, u.full_name`,
      [inspectionId],
    );
  }

  private async assertAssignable(tx: Tx, userId: string, branchId: string): Promise<void> {
    const row = await tx.one<{ is_active: boolean; full_name: string }>(
      'SELECT is_active, full_name FROM users WHERE id = $1 AND branch_id = $2',
      [userId, branchId],
    );
    if (!row) throw new BadRequestException('That person does not work at the office responsible for this inspection');
    if (!row.is_active) throw new BadRequestException(`${row.full_name} is deactivated and cannot be assigned`);
  }

  /** A field role must be on the inspection to start it; the office may start on their behalf. */
  private async assertOnInspection(tx: Tx, user: AuthUser, inspection: Inspection): Promise<void> {
    if (user.scope !== 'own') return;
    if (inspection.leadInspectorId === user.id) return;
    const row = await tx.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM inspection_assignments
       WHERE inspection_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [inspection.id, user.id],
    );
    if (!row?.n) throw new ForbiddenException('This inspection is not assigned to you');
  }
}
