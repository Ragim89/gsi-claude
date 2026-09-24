import { AuthUser, CustodyEventType, SampleCondition, SealCondition } from '@gsi/shared-types';
import type { Tx } from '../db/db.service';

export interface CustodyInput {
  sampleId: string;
  branchId: string;
  eventType: CustodyEventType;
  fromUserId?: string | null;
  fromOfficeId?: string | null;
  fromLocation?: string | null;
  toUserId?: string | null;
  toOfficeId?: string | null;
  toLocation?: string | null;
  laboratoryId?: string | null;
  occurredAt?: string | null;
  sealState?: SealCondition | null;
  condition?: SampleCondition | null;
  notes?: string | null;
  mediaId?: string | null;
  correctsEventId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Appends one entry to the chain of custody.
 *
 * There is no update and no delete anywhere in the codebase for this table, and `gsi_app` is
 * not granted either — a mistaken entry is superseded by a `correction` that points at it, so
 * the original account and the fact that somebody revised it both survive.
 */
export async function recordCustody(tx: Tx, user: AuthUser, input: CustodyInput): Promise<string> {
  const row = await tx.one<{ id: string }>(
    `INSERT INTO sample_custody_events
       (sample_id, branch_id, event_type, from_user_id, from_office_id, from_location,
        to_user_id, to_office_id, to_location, laboratory_id, occurred_at, recorded_by,
        seal_state, condition, notes, media_id, corrects_event_id, metadata)
     VALUES ($1, $2, $3::custody_event_type, $4, $5, $6, $7, $8, $9, $10,
             COALESCE($11::timestamptz, now()), $12, $13::seal_condition, $14::sample_condition,
             $15, $16, $17, $18::jsonb)
     RETURNING id`,
    [
      input.sampleId, input.branchId, input.eventType,
      input.fromUserId ?? null, input.fromOfficeId ?? null, input.fromLocation ?? null,
      input.toUserId ?? null, input.toOfficeId ?? null, input.toLocation ?? null,
      input.laboratoryId ?? null, input.occurredAt ?? null, user.id,
      input.sealState ?? null, input.condition ?? null, input.notes ?? null,
      input.mediaId ?? null, input.correctsEventId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  return row!.id;
}

export const CUSTODY_COLUMNS = `
  e.id, e.sample_id AS "sampleId", e.event_type AS "eventType",
  e.from_user_id AS "fromUserId", fu.full_name AS "fromUserName",
  e.from_office_id AS "fromOfficeId", fb.code AS "fromOfficeCode", e.from_location AS "fromLocation",
  e.to_user_id AS "toUserId", tu.full_name AS "toUserName",
  e.to_office_id AS "toOfficeId", tb.code AS "toOfficeCode", e.to_location AS "toLocation",
  e.laboratory_id AS "laboratoryId", l.name AS "laboratoryName",
  e.occurred_at AS "occurredAt", e.recorded_by AS "recordedBy", rb.full_name AS "recordedByName",
  e.seal_state AS "sealState", e.condition, e.notes, e.media_id AS "mediaId",
  e.corrects_event_id AS "correctsEventId",
  (SELECT c.id FROM sample_custody_events c WHERE c.corrects_event_id = e.id ORDER BY c.created_at LIMIT 1)
    AS "correctedByEventId",
  e.metadata, e.created_at AS "createdAt"`;

export const CUSTODY_FROM = `
  sample_custody_events e
  LEFT JOIN users fu ON fu.id = e.from_user_id
  LEFT JOIN users tu ON tu.id = e.to_user_id
  LEFT JOIN users rb ON rb.id = e.recorded_by
  LEFT JOIN branches fb ON fb.id = e.from_office_id
  LEFT JOIN branches tb ON tb.id = e.to_office_id
  LEFT JOIN laboratories l ON l.id = e.laboratory_id`;
