import type { JobStatus, InspectionStatus, ServiceType } from '@gsi/shared-types';
import type { Tx } from './db.service';
import { seedChecklist } from '../operations/checklist-seed';

/**
 * The same mapping migration 013 used to turn existing jobs into inspections, so a database
 * built from the seed and one migrated from MVP-1 look alike.
 */
const FROM_JOB: Record<JobStatus, InspectionStatus> = {
  draft: 'draft',
  confirmed: 'draft',
  assigned: 'scheduled',
  in_progress: 'in_progress',
  sampling: 'in_progress',
  lab: 'completed',
  report_preparation: 'completed',
  under_review: 'under_review',
  approved: 'approved',
  completed: 'approved',
  invoiced: 'approved',
  closed: 'approved',
  on_hold: 'on_hold',
  cancelled: 'cancelled',
};

export interface SeedInspectionInput {
  jobId: string;
  branchId: string;
  type: ServiceType;
  jobStatus: JobStatus;
  leadInspectorId?: string | null;
  location?: string | null;
  scheduledStart?: string | null;
  createdBy: string;
  createdAt?: string | null;
}

/**
 * Gives a seeded job the inspection its field work belongs to, with the checklist snapshot
 * attached to it. Demo data without inspections would leave the field screens empty on a
 * fresh install while a migrated database had them — two different products.
 */
export async function seedInspection(tx: Tx, input: SeedInspectionInput): Promise<string> {
  const status = FROM_JOB[input.jobStatus] ?? 'draft';
  const started = ['in_progress', 'completed', 'under_review', 'approved'].includes(status);
  const finished = ['completed', 'under_review', 'approved'].includes(status);

  const row = await tx.one<{ id: string }>(
    `INSERT INTO inspections (branch_id, job_id, inspection_number, type, status, lead_inspector_id,
                              location, scheduled_start, actual_start, actual_end, created_by,
                              created_at, updated_at)
     VALUES ($1, $2, next_doc_number($1, 'INS'), $3, $4::inspection_status, $5, $6,
             $7::timestamptz,
             CASE WHEN $8 THEN $7::timestamptz END,
             CASE WHEN $9 THEN $7::timestamptz + interval '6 hour' END,
             $10, COALESCE($11::timestamptz, now()), COALESCE($11::timestamptz, now()))
     RETURNING id`,
    [input.branchId, input.jobId, input.type, status, input.leadInspectorId ?? null,
     input.location ?? null, input.scheduledStart ?? null, started, finished, input.createdBy,
     input.createdAt ?? null],
  );
  const inspectionId = row!.id;

  await seedChecklist(tx, input.jobId, input.type, inspectionId);

  await tx.exec(
    `INSERT INTO inspection_status_history (inspection_id, branch_id, from_status, to_status, changed_by,
                                            created_at, metadata)
     VALUES ($1, $2, NULL, $3::inspection_status, $4, COALESCE($5::timestamptz, now()), '{"seed": true}'::jsonb)`,
    [inspectionId, input.branchId, status, input.createdBy, input.createdAt ?? null],
  );

  if (input.leadInspectorId) {
    await tx.exec(
      `INSERT INTO inspection_assignments (inspection_id, branch_id, user_id, role, assigned_by, assigned_at)
       VALUES ($1, $2, $3, 'lead_inspector', $4, COALESCE($5::timestamptz, now())) ON CONFLICT DO NOTHING`,
      [inspectionId, input.branchId, input.leadInspectorId, input.createdBy, input.createdAt ?? null],
    );
  }

  return inspectionId;
}
