import { CHECKLIST_TEMPLATES, CHECKLIST_TEMPLATE_VERSION, ServiceType } from '@gsi/shared-types';
import type { Tx } from '../db/db.service';

/**
 * Snapshots the service-type checklist template into job_checklist_items.
 *
 * A snapshot, not a reference: the label, input kind, section and template version are copied
 * into the row. Editing a template next year therefore cannot change what a completed
 * inspection was asked — which is the whole point under ISO 17020.
 *
 * `inspectionId` attaches the items to one inspection of the job; a job with two inspections
 * gets two independent checklists.
 */
export async function seedChecklist(
  tx: Tx,
  jobId: string,
  type: ServiceType,
  inspectionId?: string,
): Promise<void> {
  const items = CHECKLIST_TEMPLATES[type];
  if (!items?.length) return;
  await tx.exec(
    `INSERT INTO job_checklist_items (job_id, inspection_id, item_key, label, input_kind, section,
                                      is_required, template_version, sort_order)
     SELECT $1, $4::uuid, t.key, t.label, t.kind::checklist_input_kind, t.section,
            COALESCE(t.required, true), $2, t.ord
     FROM jsonb_to_recordset($3::jsonb)
       AS t(key text, label jsonb, kind text, section text, required boolean, ord int)
     /* No inference target: the uniqueness is two partial indexes (per inspection, or per job
        for the pre-inspection rows), and neither is the one true conflict arbiter. */
     ON CONFLICT DO NOTHING`,
    [
      jobId,
      CHECKLIST_TEMPLATE_VERSION,
      JSON.stringify(
        items.map((it, i) => ({
          key: it.key,
          label: it.label,
          kind: it.kind,
          section: it.section ?? null,
          required: it.required ?? true,
          ord: (i + 1) * 10,
        })),
      ),
      inspectionId ?? null,
    ],
  );
}
