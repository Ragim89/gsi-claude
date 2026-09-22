import { CHECKLIST_TEMPLATES, CHECKLIST_TEMPLATE_VERSION, ServiceType } from '@gsi/shared-types';
import type { Tx } from '../db/db.service';

/** Snapshots the service-type checklist template into job_checklist_items for a new job. */
export async function seedChecklist(tx: Tx, jobId: string, type: ServiceType): Promise<void> {
  const items = CHECKLIST_TEMPLATES[type];
  if (!items?.length) return;
  await tx.exec(
    `INSERT INTO job_checklist_items (job_id, item_key, label, input_kind, template_version, sort_order)
     SELECT $1, t.key, t.label, t.kind::checklist_input_kind, $2, t.ord
     FROM jsonb_to_recordset($3::jsonb) AS t(key text, label jsonb, kind text, ord int)`,
    [jobId, CHECKLIST_TEMPLATE_VERSION, JSON.stringify(items.map((it, i) => ({ ...it, ord: (i + 1) * 10 })))],
  );
}
