import { AuthUser, ServiceType } from '@gsi/shared-types';
import type { Tx } from '../db/db.service';
import type { AuditService } from '../common/audit.service';
import { seedChecklist } from '../operations/checklist-seed';

export interface OpenInspectionInput {
  jobId: string;
  branchId: string;
  type: ServiceType;
  leadInspectorId?: string | null;
  location?: string | null;
  city?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  instructions?: string | null;
  /** Off only where a checklist genuinely does not apply; on by default. */
  withChecklist?: boolean;
}

/**
 * Opens an inspection on a job: the row, its checklist snapshot, its first history entry and
 * the lead's assignment.
 *
 * A plain function rather than a service method because a job creates its first inspection
 * the moment it is created, and OperationsModule cannot depend on InspectionsModule without
 * the two importing each other in a circle. One implementation either way: the inspection a
 * job opens for itself is the same inspection the office opens by hand.
 */
export async function openInspection(
  tx: Tx,
  audit: AuditService,
  user: AuthUser,
  input: OpenInspectionInput,
): Promise<string> {
  const row = await tx.one<{ id: string; inspection_number: string }>(
    `INSERT INTO inspections (branch_id, job_id, inspection_number, type, status, lead_inspector_id,
                              location, city, scheduled_start, scheduled_end, instructions, created_by)
     VALUES ($1, $2, next_doc_number($1, 'INS'), $3, $4::inspection_status, $5, $6, $7,
             $8::timestamptz, $9::timestamptz, $10, $11)
     RETURNING id, inspection_number`,
    [input.branchId, input.jobId, input.type, input.scheduledStart ? 'scheduled' : 'draft',
     input.leadInspectorId ?? null, input.location ?? null, input.city ?? null,
     input.scheduledStart ?? null, input.scheduledEnd ?? null, input.instructions ?? null, user.id],
  );
  const id = row!.id;
  const status = input.scheduledStart ? 'scheduled' : 'draft';

  if (input.withChecklist !== false) {
    await seedChecklist(tx, input.jobId, input.type, id);
  }

  await tx.exec(
    `INSERT INTO inspection_status_history (inspection_id, branch_id, from_status, to_status, changed_by, metadata)
     VALUES ($1, $2, NULL, $3::inspection_status, $4, '{"action":"create"}'::jsonb)`,
    [id, input.branchId, status, user.id],
  );

  if (input.leadInspectorId) {
    await tx.exec(
      `INSERT INTO inspection_assignments (inspection_id, branch_id, user_id, role, assigned_by)
       VALUES ($1, $2, $3, 'lead_inspector', $4) ON CONFLICT DO NOTHING`,
      [id, input.branchId, input.leadInspectorId, user.id],
    );
  }

  await audit.record(tx, user, {
    action: 'inspection.create',
    entityType: 'inspection',
    entityId: id,
    entityLabel: row!.inspection_number,
    branchId: input.branchId,
    after: { jobId: input.jobId, type: input.type, status, leadInspectorId: input.leadInspectorId ?? null },
  });

  return id;
}
