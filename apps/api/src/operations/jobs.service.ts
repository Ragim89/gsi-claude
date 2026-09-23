import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser, canTransition, CHECKLIST_TEMPLATES, InspectionJob, JobStatus, ServiceType } from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { buildSet } from '../common/sql';
import { seedChecklist } from './checklist-seed';
import { ReportsService } from '../documents/reports.service';
import { JOB_COLUMNS, JOB_FROM } from './job-sql';

export interface JobFilters {
  status?: JobStatus;
  clientId?: string;
  inspectorId?: string;
  search?: string;
  /** HQ users can narrow the group view to one branch; RLS still bounds everyone else. */
  branchId?: string;
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
}

export interface CreateJobInput {
  clientId: string;
  type: ServiceType;
  location: string;
  commodityId?: string | null;
  portId?: string | null;
  contractNo?: string | null;
  quantityValue?: number | null;
  quantityUnit?: string | null;
  vesselOrObject?: string | null;
  commodity?: string | null;
  quantity?: string | null;
  scheduledAt?: string | null;
  instructions?: string | null;
  assignedInspectorId?: string | null;
}

export type UpdateJobInput = Partial<Omit<CreateJobInput, 'clientId' | 'type' | 'assignedInspectorId'>>;

@Injectable()
export class JobsService {
  constructor(private readonly db: DbService, private readonly reports: ReportsService) {}

  list(user: AuthUser, f: JobFilters) {
    // RLS limits inspectors to their own jobs and everyone to their branch.
    return this.db.tx(user, (tx) =>
      tx.many<InspectionJob>(
        `SELECT ${JOB_COLUMNS} FROM ${JOB_FROM}
         WHERE ($1::job_status IS NULL OR j.status = $1::job_status)
           AND ($2::uuid IS NULL OR j.client_id = $2::uuid)
           AND ($3::uuid IS NULL OR j.assigned_inspector_id = $3::uuid)
           AND ($4::text IS NULL OR j.job_number ILIKE '%' || $4 || '%' OR c.name ILIKE '%' || $4 || '%'
                OR j.vessel_or_object ILIKE '%' || $4 || '%' OR j.location ILIKE '%' || $4 || '%')
           AND ($5::uuid IS NULL OR j.branch_id = $5::uuid)
           AND ($6::uuid IS NULL OR j.commodity_id = $6::uuid)
           AND ($7::uuid IS NULL OR j.port_id = $7::uuid)
           AND ($8::text IS NULL OR j.contract_no ILIKE '%' || $8 || '%')
           AND ($9::numeric IS NULL OR j.quantity_value >= $9::numeric)
           AND ($10::numeric IS NULL OR j.quantity_value <= $10::numeric)
           AND ($11::date IS NULL OR COALESCE(j.scheduled_at, j.created_at)::date >= $11::date)
           AND ($12::date IS NULL OR COALESCE(j.scheduled_at, j.created_at)::date <= $12::date)
           AND ($13::service_type IS NULL OR j.type = $13::service_type)
           AND ($14::commodity_group IS NULL OR cm."group" = $14::commodity_group)
         ORDER BY COALESCE(j.scheduled_at, j.created_at) DESC
         LIMIT 500`,
        [f.status ?? null, f.clientId ?? null, f.inspectorId ?? null, f.search?.trim() || null, f.branchId ?? null,
         f.commodityId ?? null, f.portId ?? null, f.contractNo?.trim() || null, f.minQuantity ?? null,
         f.maxQuantity ?? null, f.from ?? null, f.to ?? null, f.type ?? null, f.commodityGroup ?? null],
      ),
    );
  }

  get(user: AuthUser, id: string) {
    return this.db.tx(user, (tx) => this.load(tx, id));
  }

  async load(tx: Tx, id: string, forUpdate = false): Promise<InspectionJob> {
    const job = await tx.one<InspectionJob>(
      `SELECT ${JOB_COLUMNS} FROM ${JOB_FROM} WHERE j.id = $1 ${forUpdate ? 'FOR UPDATE OF j' : ''}`,
      [id],
    );
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  create(user: AuthUser, input: CreateJobInput) {
    if (!CHECKLIST_TEMPLATES[input.type]) throw new BadRequestException('Unknown service type');
    return this.db.tx(user, async (tx) => {
      // The job lives in the client's branch; RLS guarantees the caller can see that client.
      const client = await tx.one<{ branch_id: string }>('SELECT branch_id FROM clients WHERE id = $1', [input.clientId]);
      if (!client) throw new NotFoundException('Client not found');
      if (input.assignedInspectorId) await this.assertInspector(tx, input.assignedInspectorId, client.branch_id);

      const row = await tx.one<{ id: string }>(
        `INSERT INTO inspection_jobs (branch_id, job_number, client_id, type, status, assigned_inspector_id,
                                      location, vessel_or_object, commodity, quantity, scheduled_at, instructions,
                                      commodity_id, port_id, contract_no, quantity_value, quantity_unit, created_by)
         VALUES ($1, next_doc_number($1, 'J'), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                 COALESCE($16, 'MT'), $17)
         RETURNING id`,
        [client.branch_id, input.clientId, input.type, input.assignedInspectorId ? 'assigned' : 'new',
         input.assignedInspectorId ?? null, input.location.trim(), input.vesselOrObject ?? null, input.commodity ?? null,
         input.quantity ?? null, input.scheduledAt ?? null, input.instructions ?? null,
         input.commodityId ?? null, input.portId ?? null, input.contractNo?.trim() || null,
         input.quantityValue ?? null, input.quantityUnit ?? null, user.id],
      );
      await seedChecklist(tx, row!.id, input.type);
      return this.load(tx, row!.id);
    });
  }

  update(user: AuthUser, id: string, input: UpdateJobInput) {
    const { sql, params } = buildSet(input as Record<string, unknown>, {
      location: 'location',
      vesselOrObject: 'vessel_or_object',
      commodity: 'commodity',
      quantity: 'quantity',
      commodityId: 'commodity_id',
      portId: 'port_id',
      contractNo: 'contract_no',
      quantityValue: 'quantity_value',
      quantityUnit: 'quantity_unit',
      scheduledAt: 'scheduled_at',
      instructions: 'instructions',
    }, 2);
    if (!sql) throw new BadRequestException('Nothing to update');
    return this.db.tx(user, async (tx) => {
      const job = await this.load(tx, id, true);
      if (job.status === 'approved' || job.status === 'cancelled') {
        throw new ConflictException(`Job is ${job.status} and can no longer be edited`);
      }
      await tx.exec(`UPDATE inspection_jobs SET ${sql} WHERE id = $1`, [id, ...params]);
      return this.load(tx, id);
    });
  }

  /** Only never-started jobs can be deleted; everything else is cancelled to keep the audit trail. */
  remove(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const job = await this.load(tx, id, true);
      if (job.status !== 'new' && job.status !== 'assigned') {
        throw new ConflictException('Only jobs that have not started can be deleted; cancel it instead');
      }
      await tx.exec('DELETE FROM inspection_jobs WHERE id = $1', [id]);
    });
  }

  assign(user: AuthUser, id: string, inspectorId: string) {
    return this.db.tx(user, async (tx) => {
      const job = await this.load(tx, id, true);
      if (!['new', 'assigned', 'in_progress'].includes(job.status)) {
        throw new ConflictException(`Cannot reassign a job in status ${job.status}`);
      }
      await this.assertInspector(tx, inspectorId, job.branchId);
      await tx.exec(
        `UPDATE inspection_jobs SET assigned_inspector_id = $2,
                status = CASE WHEN status = 'new' THEN 'assigned'::job_status ELSE status END
         WHERE id = $1`,
        [id, inspectorId],
      );
      return this.load(tx, id);
    });
  }

  start(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const job = await this.load(tx, id, true);
      this.assertAssignedInspector(user, job);
      await this.transition(tx, job, 'in_progress');
      return this.load(tx, id);
    });
  }

  submit(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const job = await this.load(tx, id, true);
      this.assertAssignedInspector(user, job);
      const missing = await tx.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM job_checklist_items WHERE job_id = $1 AND result IS NULL',
        [id],
      );
      if (missing && missing.n > 0) {
        throw new BadRequestException(`${missing.n} checklist item(s) have no result yet`);
      }
      await this.transition(tx, job, 'under_review', `submitted_at = now(), review_comment = NULL`);
      return this.load(tx, id);
    });
  }

  returnForRework(user: AuthUser, id: string, comment: string) {
    return this.db.tx(user, async (tx) => {
      const job = await this.load(tx, id, true);
      await this.transition(tx, job, 'in_progress', 'review_comment = $2', [comment]);
      return this.load(tx, id);
    });
  }

  /**
   * Supervisor approval → issues the PDF report in the same transaction, so a job is never
   * "approved" without its report (and a failed render leaves the job under review).
   */
  approve(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const job = await this.load(tx, id, true);
      await this.transition(tx, job, 'approved', 'approved_at = now(), approved_by = $2', [user.id]);
      const report = await this.reports.issueForJob(tx, user, id);
      return { job: await this.load(tx, id), report };
    });
  }

  cancel(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const job = await this.load(tx, id, true);
      await this.transition(tx, job, 'cancelled');
      return this.load(tx, id);
    });
  }

  private async transition(tx: Tx, job: InspectionJob, to: JobStatus, extraSet = '', extraParams: unknown[] = []) {
    if (!canTransition(job.status, to)) {
      throw new ConflictException(`Cannot move job from ${job.status} to ${to}`);
    }
    const set = extraSet ? `, ${extraSet}` : '';
    await tx.exec(`UPDATE inspection_jobs SET status = '${to}'::job_status${set} WHERE id = $1`, [job.id, ...extraParams]);
  }

  private assertAssignedInspector(user: AuthUser, job: InspectionJob) {
    // ASSUMPTION: supervisors/admins may start/submit on behalf of an inspector (e.g. paper
    // checklist typed in at the office); inspectors only for their own jobs (also enforced by RLS).
    if (user.role === 'inspector' && job.assignedInspectorId !== user.id) {
      throw new ForbiddenException('Job is not assigned to you');
    }
  }

  private async assertInspector(tx: Tx, inspectorId: string, branchId: string) {
    const ok = await tx.one(
      `SELECT 1 FROM users WHERE id = $1 AND branch_id = $2 AND role = 'inspector' AND is_active`,
      [inspectorId, branchId],
    );
    if (!ok) throw new BadRequestException('Inspector must be an active inspector of the job branch');
  }
}
