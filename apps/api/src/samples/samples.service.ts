import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AuthUser,
  CustodyEventType,
  DETAIL_EDITABLE_STATUSES,
  IDENTITY_EDITABLE_STATUSES,
  Laboratory,
  Page,
  SAMPLE_IDENTITY_FIELDS,
  Sample,
  SampleAction,
  SampleCondition,
  SampleCustodyEvent,
  SampleRejectionReason,
  SampleStatus,
  SampleStatusHistoryEntry,
  SampleType,
  SamplingMethod,
  SealCondition,
} from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { buildSet } from '../common/sql';
import { AuditService } from '../common/audit.service';
import { JobsService } from '../operations/jobs.service';
import { InspectionsService } from '../inspections/inspections.service';
import { SampleWorkflowService } from './sample-workflow.service';
import { CUSTODY_COLUMNS, CUSTODY_FROM, CustodyInput, recordCustody } from './custody';

export type SampleSort = 'sampleNumber' | 'sampledAt' | 'status' | 'updatedAt';

export interface SampleFilters {
  jobId?: string;
  inspectionId?: string;
  clientId?: string;
  status?: SampleStatus;
  sampleType?: SampleType;
  samplerId?: string;
  commodityId?: string;
  laboratoryId?: string;
  branchId?: string;
  countryId?: string;
  /** Everything the caller took or is on — the field worker's own list. */
  mine?: boolean;
  /** Not accepted by a laboratory and not cancelled. */
  active?: boolean;
  search?: string;
  from?: string;
  to?: string;
  sort?: SampleSort;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface CreateSampleInput {
  jobId?: string;
  inspectionId?: string;
  sampleType?: SampleType;
  samplingMethod?: SamplingMethod;
  commodityId?: string | null;
  commodity?: string | null;
  commodityDetails?: string | null;
  quantity?: number | null;
  unit?: string | null;
  containerType?: string | null;
  batchLotNumber?: string | null;
  containerReference?: string | null;
  location?: string | null;
  sealNumber?: string | null;
  sealType?: string | null;
  sampledBy?: string | null;
  sampledAt?: string | null;
  conditionNotes?: string | null;
  instructions?: string | null;
  sampleGroup?: string | null;
  parentSampleId?: string | null;
  destinationLaboratoryId?: string | null;
}

export type UpdateSampleInput = Partial<
  Omit<CreateSampleInput, 'jobId' | 'inspectionId'> & { internalNotes: string | null; version: number }
>;

const SORT_COLUMNS: Record<SampleSort, string> = {
  sampleNumber: 's.sample_number',
  sampledAt: 's.sampled_at',
  status: 's.status',
  updatedAt: 's.updated_at',
};

const UPDATABLE = {
  sampleType: 'sample_type',
  samplingMethod: 'sampling_method',
  commodityId: 'commodity_id',
  commodity: 'commodity',
  commodityDetails: 'commodity_details',
  quantity: 'quantity',
  unit: 'unit',
  containerType: 'container_type',
  batchLotNumber: 'batch_lot_number',
  containerReference: 'container_reference',
  location: 'location',
  sampledBy: 'sampled_by',
  sampledAt: 'sampled_at',
  conditionNotes: 'condition_notes',
  instructions: 'instructions',
  internalNotes: 'internal_notes',
  sampleGroup: 'sample_group',
  destinationLaboratoryId: 'destination_laboratory_id',
};

/** The code, the office and whether it is ours are settled when a laboratory is entered. */
const LAB_UPDATABLE = {
  name: 'name',
  city: 'city',
  address: 'address',
  timezone: 'timezone',
  contactEmail: 'contact_email',
  contactPhone: 'contact_phone',
  notes: 'notes',
  isActive: 'is_active',
};

const COLUMNS = `
  s.id, s.branch_id AS "branchId", b.code AS "branchCode", s.job_id AS "jobId", j.job_number AS "jobNumber",
  s.inspection_id AS "inspectionId", i.inspection_number AS "inspectionNumber",
  s.client_id AS "clientId", c.name AS "clientName", s.sample_number AS "sampleNumber",
  s.sample_type AS "sampleType", s.sampling_method AS "samplingMethod", s.status,
  s.status_before_hold AS "statusBeforeHold",
  s.commodity_id AS "commodityId", s.commodity, cm.name AS "commodityName",
  s.commodity_details AS "commodityDetails", s.quantity::float8 AS quantity, s.unit,
  s.container_type AS "containerType", s.batch_lot_number AS "batchLotNumber",
  s.container_reference AS "containerReference", s.location,
  s.seal_number AS "sealNumber", s.seal_type AS "sealType", s.sealed_by AS "sealedBy",
  sb.full_name AS "sealedByName", s.sealed_at AS "sealedAt", s.seal_state AS "sealState",
  s.seal_broken_at AS "sealBrokenAt", s.seal_broken_by AS "sealBrokenBy",
  s.sampled_by AS "sampledBy", sm.full_name AS "sampledByName", s.sampled_at AS "sampledAt",
  s.condition_notes AS "conditionNotes", s.instructions, s.internal_notes AS "internalNotes",
  s.destination_laboratory_id AS "destinationLaboratoryId", l.name AS "destinationLaboratoryName",
  s.dispatched_at AS "dispatchedAt", s.dispatched_by AS "dispatchedBy", db.full_name AS "dispatchedByName",
  s.courier, s.tracking_reference AS "trackingReference", s.package_count AS "packageCount",
  s.received_at AS "receivedAt", s.received_by AS "receivedBy", rb.full_name AS "receivedByName",
  s.received_condition AS "receivedCondition", s.received_seal_condition AS "receivedSealCondition",
  s.lab_decision_at AS "labDecisionAt", s.lab_decision_by AS "labDecisionBy", lb.full_name AS "labDecisionByName",
  s.rejection_reason AS "rejectionReason", s.rejection_notes AS "rejectionNotes",
  s.sample_group AS "sampleGroup", s.parent_sample_id AS "parentSampleId",
  s.version, s.deleted_at AS "archivedAt",
  s.created_by AS "createdBy", cb.full_name AS "createdByName",
  s.created_at AS "createdAt", s.updated_at AS "updatedAt",
  /* Where it is now: the last custody entry, computed rather than stored so it cannot drift. */
  last_event.to_location AS "currentLocation",
  last_event.to_user_id AS "currentCustodianId",
  last_event.custodian_name AS "currentCustodianName",
  COALESCE(counts.attachments, 0)::int AS "attachmentCount",
  COALESCE(counts.custody, 0)::int AS "custodyEventCount"`;

/**
 * One LATERAL for the last custody entry and one for the counts: a list of fifty samples
 * costs three queries, not a hundred and fifty.
 */
const FROM = `
  samples s
  JOIN branches b ON b.id = s.branch_id
  JOIN inspection_jobs j ON j.id = s.job_id
  JOIN clients c ON c.id = s.client_id
  LEFT JOIN inspections i ON i.id = s.inspection_id
  LEFT JOIN commodities cm ON cm.id = s.commodity_id
  LEFT JOIN laboratories l ON l.id = s.destination_laboratory_id
  LEFT JOIN users sm ON sm.id = s.sampled_by
  LEFT JOIN users sb ON sb.id = s.sealed_by
  LEFT JOIN users db ON db.id = s.dispatched_by
  LEFT JOIN users rb ON rb.id = s.received_by
  LEFT JOIN users lb ON lb.id = s.lab_decision_by
  LEFT JOIN users cb ON cb.id = s.created_by
  LEFT JOIN LATERAL (
    SELECT e.to_location, e.to_user_id, u.full_name AS custodian_name
    FROM sample_custody_events e
    LEFT JOIN users u ON u.id = e.to_user_id
    WHERE e.sample_id = s.id
    ORDER BY e.occurred_at DESC, e.created_at DESC
    LIMIT 1
  ) last_event ON true
  LEFT JOIN LATERAL (
    SELECT (SELECT count(*) FROM media_attachments m WHERE m.sample_id = s.id) AS attachments,
           (SELECT count(*) FROM sample_custody_events e WHERE e.sample_id = s.id) AS custody
  ) counts ON true`;

/**
 * Samples and their chain of custody.
 *
 * Status moves only through SampleWorkflowService, and every move that means the sample
 * physically went somewhere writes its custody entry in the same transaction.
 */
@Injectable()
export class SamplesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly workflow: SampleWorkflowService,
    private readonly jobs: JobsService,
    private readonly inspections: InspectionsService,
  ) {}

  async list(user: AuthUser, f: SampleFilters): Promise<Page<Sample>> {
    const limit = f.limit ?? 50;
    const offset = f.offset ?? 0;
    const sort = SORT_COLUMNS[f.sort ?? 'sampledAt'] ?? SORT_COLUMNS.sampledAt;
    const dir = f.dir === 'asc' ? 'ASC' : 'DESC';

    const params = [
      f.jobId ?? null,
      f.status ?? null,
      f.sampleType ?? null,
      f.samplerId ?? null,
      f.search?.trim() || null,
      f.branchId ?? null,
      f.from ?? null,
      f.to ?? null,
      f.mine ? user.id : null,
      f.active ?? null,
      f.clientId ?? null,
      f.countryId ?? null,
      f.laboratoryId ?? null,
      f.commodityId ?? null,
      f.inspectionId ?? null,
    ];

    const where = `
      WHERE ($1::uuid IS NULL OR s.job_id = $1::uuid)
        AND ($2::sample_status IS NULL OR s.status = $2::sample_status)
        AND ($3::sample_type IS NULL OR s.sample_type = $3::sample_type)
        AND ($4::uuid IS NULL OR s.sampled_by = $4::uuid)
        AND ($5::text IS NULL OR s.sample_number ILIKE '%' || $5 || '%'
             OR j.job_number ILIKE '%' || $5 || '%' OR c.name ILIKE '%' || $5 || '%'
             /* The reference name is localised jsonb, so it is searched as text. */
             OR s.commodity ILIKE '%' || $5 || '%' OR cm.name::text ILIKE '%' || $5 || '%'
             OR s.seal_number ILIKE '%' || $5 || '%' OR s.batch_lot_number ILIKE '%' || $5 || '%'
             OR s.container_reference ILIKE '%' || $5 || '%')
        AND ($6::uuid IS NULL OR s.branch_id = $6::uuid)
        AND ($7::date IS NULL OR COALESCE(s.sampled_at, s.created_at)::date >= $7::date)
        AND ($8::date IS NULL OR COALESCE(s.sampled_at, s.created_at)::date <= $8::date)
        AND ($9::uuid IS NULL OR s.sampled_by = $9::uuid OR s.created_by = $9::uuid)
        AND ($10::boolean IS NOT TRUE OR s.status NOT IN ('accepted_by_lab', 'cancelled'))
        AND ($11::uuid IS NULL OR s.client_id = $11::uuid)
        AND ($12::uuid IS NULL OR b.country_id = $12::uuid)
        AND ($13::uuid IS NULL OR s.destination_laboratory_id = $13::uuid)
        AND ($14::uuid IS NULL OR s.commodity_id = $14::uuid)
        AND ($15::uuid IS NULL OR s.inspection_id = $15::uuid)
        AND s.deleted_at IS NULL`;

    return this.db.tx(user, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.many<Sample>(
          `SELECT ${COLUMNS} FROM ${FROM} ${where}
           ORDER BY ${sort} ${dir} NULLS LAST, s.sample_number DESC
           LIMIT ${limit} OFFSET ${offset}`,
          params,
        ),
        tx.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM samples s
             JOIN branches b ON b.id = s.branch_id
             JOIN inspection_jobs j ON j.id = s.job_id
             JOIN clients c ON c.id = s.client_id
             LEFT JOIN commodities cm ON cm.id = s.commodity_id
           ${where}`,
          params,
        ),
      ]);
      return { rows, total: total?.n ?? 0, limit, offset };
    });
  }

  get(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const sample = await this.load(tx, id);
      return { ...sample, actions: this.workflow.available(user, sample) };
    });
  }

  async load(tx: Tx, id: string, forUpdate = false): Promise<Sample> {
    // FOR UPDATE cannot be used with the LATERAL joins, so the lock is taken separately.
    if (forUpdate) await tx.one('SELECT id FROM samples WHERE id = $1 FOR UPDATE', [id]);
    const row = await tx.one<Sample>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE s.id = $1 AND s.deleted_at IS NULL`,
      [id],
    );
    if (!row) throw new NotFoundException('Sample not found');
    return row;
  }

  /**
   * Records a sample. It belongs to an inspection where one was under way and to the job in
   * every case: a sample with no job is a bag with no story.
   */
  create(user: AuthUser, input: CreateSampleInput) {
    return this.db.tx(user, async (tx) => {
      if (!input.jobId && !input.inspectionId) {
        throw new BadRequestException('A sample belongs to a job, or to an inspection of one');
      }

      let jobId = input.jobId;
      const inspectionId = input.inspectionId ?? null;
      if (inspectionId) {
        const inspection = await this.inspections.load(tx, inspectionId);
        if (jobId && jobId !== inspection.jobId) {
          throw new BadRequestException('That inspection belongs to a different job');
        }
        jobId = inspection.jobId;
      }
      const job = await this.jobs.load(tx, jobId!);
      if (['closed', 'cancelled'].includes(job.status)) {
        throw new ConflictException(`A job that is ${job.status} can no longer take new samples`);
      }
      if (input.parentSampleId) {
        const parent = await tx.one<{ id: string }>(
          'SELECT id FROM samples WHERE id = $1 AND job_id = $2 AND deleted_at IS NULL',
          [input.parentSampleId, jobId],
        );
        if (!parent) throw new BadRequestException('The parent sample belongs to a different job');
      }
      if (input.destinationLaboratoryId) await this.assertLaboratory(tx, input.destinationLaboratoryId);

      const row = await tx.one<{ id: string }>(
        `INSERT INTO samples (branch_id, job_id, inspection_id, client_id, sample_number, sample_type,
                              sampling_method, commodity_id, commodity, commodity_details, quantity, unit,
                              container_type, batch_lot_number, container_reference, location,
                              seal_number, seal_type, sampled_by, sampled_at, condition_notes, instructions,
                              sample_group, parent_sample_id, destination_laboratory_id, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, next_doc_number($1, 'SMP'),
                 COALESCE($5::sample_type, 'representative'),
                 COALESCE($6::sampling_method, 'manual'), $7::uuid, $8, $9, $10::numeric, $11, $12, $13, $14,
                 COALESCE($15, $16), $17, $18, COALESCE($19::uuid, $20::uuid),
                 COALESCE($21::timestamptz, now()),
                 $22, $23, $24, $25::uuid, $26::uuid, $20::uuid)
         RETURNING id`,
        [job.branchId, jobId, inspectionId, job.clientId, input.sampleType ?? null,
         input.samplingMethod ?? null, input.commodityId ?? job.commodityId ?? null,
         input.commodity ?? job.commodity ?? null, input.commodityDetails ?? null,
         input.quantity ?? null, input.unit ?? null, input.containerType ?? null,
         input.batchLotNumber ?? null, input.containerReference ?? null,
         input.location ?? null, job.location ?? null, input.sealNumber ?? null, input.sealType ?? null,
         input.sampledBy ?? null, user.id, input.sampledAt ?? null, input.conditionNotes ?? null,
         input.instructions ?? null, input.sampleGroup ?? null, input.parentSampleId ?? null,
         input.destinationLaboratoryId ?? null],
      );

      const sample = await this.load(tx, row!.id);
      await tx.exec(
        `INSERT INTO sample_status_history (sample_id, branch_id, from_status, to_status, changed_by, metadata)
         VALUES ($1, $2, NULL, $3::sample_status, $4, '{"action":"create"}'::jsonb)`,
        [sample.id, sample.branchId, sample.status, user.id],
      );
      await this.audit.record(tx, user, {
        action: 'sample.create',
        entityType: 'sample',
        entityId: sample.id,
        entityLabel: sample.sampleNumber,
        branchId: sample.branchId,
        after: { jobNumber: job.jobNumber, inspectionId, sampleType: sample.sampleType },
      });
      return sample;
    });
  }

  update(user: AuthUser, id: string, input: UpdateSampleInput) {
    const { version, ...fields } = input;
    const { sql, params } = buildSet(fields as Record<string, unknown>, UPDATABLE, 2);
    if (!sql) throw new BadRequestException('Nothing to update');

    return this.db.tx(user, async (tx) => {
      const sample = await this.load(tx, id, true);
      if (version !== undefined && version !== sample.version) {
        throw new ConflictException('This sample was updated by another user. Refresh before saving.');
      }
      this.assertEditable(sample, fields);
      if (fields.destinationLaboratoryId) await this.assertLaboratory(tx, fields.destinationLaboratoryId);

      await tx.exec(`UPDATE samples SET ${sql} WHERE id = $1`, [id, ...params]);
      const after = await this.load(tx, id);
      const changed = AuditService.diff(
        sample as unknown as Record<string, unknown>,
        after as unknown as Record<string, unknown>,
      );
      if (changed) {
        await this.audit.record(tx, user, {
          action: 'sample.update',
          entityType: 'sample',
          entityId: id,
          entityLabel: sample.sampleNumber,
          branchId: sample.branchId,
          before: changed.before,
          after: changed.after,
        });
      }
      return after;
    });
  }

  /**
   * The one way a sample changes status. Each move carries the columns it owns and the
   * custody entry it implies, written in the same transaction as the status itself.
   */
  transition(user: AuthUser, id: string, action: SampleAction, input: TransitionPayload = {}) {
    return this.db.tx(user, async (tx) => {
      const sample = await this.load(tx, id, true);
      const staged = this.stageFor(action, sample, input, user);

      await this.workflow.apply(tx, user, staged.sample, action, {
        reason: input.reason,
        metadata: staged.metadata,
        extraSet: staged.extraSet,
        extraParams: staged.extraParams,
        custody: staged.custody,
      });
      return this.load(tx, id);
    });
  }

  // ---- Chain of custody -----------------------------------------------------------------

  custody(user: AuthUser, sampleId: string): Promise<SampleCustodyEvent[]> {
    return this.db.tx(user, async (tx) => {
      await this.load(tx, sampleId);
      return tx.many<SampleCustodyEvent>(
        `SELECT ${CUSTODY_COLUMNS} FROM ${CUSTODY_FROM}
         WHERE e.sample_id = $1 ORDER BY e.occurred_at, e.created_at`,
        [sampleId],
      );
    });
  }

  /**
   * A handover: the sample physically changed hands without the business deciding anything
   * new about it. It is therefore a custody entry and not a status move.
   */
  handover(user: AuthUser, sampleId: string, input: HandoverInput) {
    return this.db.tx(user, async (tx) => {
      const sample = await this.load(tx, sampleId);
      if (['accepted_by_lab', 'cancelled'].includes(sample.status)) {
        throw new ConflictException(`A sample that is ${sample.status.replace(/_/g, ' ')} is no longer moving`);
      }
      if (!input.toUserId && !input.toOfficeId && !input.toLocation?.trim()) {
        throw new BadRequestException('A handover needs somebody or somewhere to hand it to');
      }
      await recordCustody(tx, user, {
        sampleId,
        branchId: sample.branchId,
        eventType: input.eventType ?? 'handover',
        fromUserId: input.fromUserId ?? sample.currentCustodianId ?? sample.sampledBy ?? null,
        fromOfficeId: input.fromOfficeId ?? null,
        fromLocation: input.fromLocation ?? sample.currentLocation ?? null,
        toUserId: input.toUserId ?? null,
        toOfficeId: input.toOfficeId ?? null,
        toLocation: input.toLocation ?? null,
        occurredAt: input.occurredAt ?? null,
        sealState: input.sealState ?? null,
        condition: input.condition ?? null,
        notes: input.notes ?? null,
      });
      await this.audit.record(tx, user, {
        action: 'sample.handover',
        entityType: 'sample',
        entityId: sampleId,
        entityLabel: sample.sampleNumber,
        branchId: sample.branchId,
        after: { to: input.toUserId ?? input.toOfficeId ?? input.toLocation },
      });
      return this.custodyIn(tx, sampleId);
    });
  }

  /**
   * Corrects an earlier custody entry without touching it. The original stays, the correction
   * points at it, and the timeline shows both — which is what "append-only" has to mean if it
   * is to mean anything.
   */
  correctCustody(user: AuthUser, sampleId: string, eventId: string, input: CorrectionInput) {
    if (!input.notes?.trim()) throw new BadRequestException('A correction has to say what was wrong');
    return this.db.tx(user, async (tx) => {
      const sample = await this.load(tx, sampleId);
      const original = await tx.one<{ id: string; event_type: CustodyEventType }>(
        'SELECT id, event_type FROM sample_custody_events WHERE id = $1 AND sample_id = $2',
        [eventId, sampleId],
      );
      if (!original) throw new NotFoundException('Custody entry not found');
      const already = await tx.one<{ id: string }>(
        'SELECT id FROM sample_custody_events WHERE corrects_event_id = $1',
        [eventId],
      );
      if (already) throw new ConflictException('That entry has already been corrected');

      await recordCustody(tx, user, {
        sampleId,
        branchId: sample.branchId,
        eventType: 'correction',
        correctsEventId: eventId,
        toLocation: input.toLocation ?? null,
        toUserId: input.toUserId ?? null,
        sealState: input.sealState ?? null,
        condition: input.condition ?? null,
        notes: input.notes,
        metadata: { corrected: original.event_type },
      });
      await this.audit.record(tx, user, {
        action: 'sample.custody_corrected',
        entityType: 'sample',
        entityId: sampleId,
        entityLabel: sample.sampleNumber,
        branchId: sample.branchId,
        after: { eventId, notes: input.notes },
      });
      return this.custodyIn(tx, sampleId);
    });
  }

  history(user: AuthUser, sampleId: string): Promise<SampleStatusHistoryEntry[]> {
    return this.db.tx(user, async (tx) => {
      await this.load(tx, sampleId);
      return tx.many<SampleStatusHistoryEntry>(
        `SELECT h.id::text AS id, h.sample_id AS "sampleId", h.from_status AS "fromStatus",
                h.to_status AS "toStatus", h.changed_by AS "changedBy", u.full_name AS "changedByName",
                h.reason, h.metadata, h.created_at AS "createdAt"
         FROM sample_status_history h LEFT JOIN users u ON u.id = h.changed_by
         WHERE h.sample_id = $1 ORDER BY h.created_at, h.id`,
        [sampleId],
      );
    });
  }

  // ---- Archive ---------------------------------------------------------------------------

  archive(user: AuthUser, id: string) {
    return this.db.tx(
      user,
      async (tx) => {
        const sample = await this.load(tx, id, true);
        if (!['draft', 'collected', 'cancelled', 'rejected_by_lab'].includes(sample.status)) {
          throw new ConflictException(
            'Only a draft, freshly collected, cancelled or rejected sample can be archived',
          );
        }
        await tx.exec('UPDATE samples SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [id, user.id]);
        await recordCustody(tx, user, {
          sampleId: id,
          branchId: sample.branchId,
          eventType: 'archived',
          notes: 'Archived',
        });
        await this.audit.record(tx, user, {
          action: 'sample.archive',
          entityType: 'sample',
          entityId: id,
          entityLabel: sample.sampleNumber,
          branchId: sample.branchId,
          before: { status: sample.status },
        });
      },
      { includeArchived: true },
    );
  }

  restore(user: AuthUser, id: string) {
    return this.db.tx(
      user,
      async (tx) => {
        const row = await tx.one<Sample>(
          `SELECT ${COLUMNS} FROM ${FROM} WHERE s.id = $1 AND s.deleted_at IS NOT NULL`,
          [id],
        );
        if (!row) throw new NotFoundException('Archived sample not found');
        await tx.exec('UPDATE samples SET deleted_at = NULL, deleted_by = NULL WHERE id = $1', [id]);
        await this.audit.record(tx, user, {
          action: 'sample.restore',
          entityType: 'sample',
          entityId: id,
          entityLabel: row.sampleNumber,
          branchId: row.branchId,
          after: { status: row.status },
        });
        return row;
      },
      { includeArchived: true },
    );
  }

  // ---- Laboratories ----------------------------------------------------------------------

  /**
   * The dispatch list carries only the laboratories still open; the administration screen asks
   * for all of them, because a closed one has to be visible to be reopened.
   */
  laboratories(user: AuthUser, includeInactive = false): Promise<Laboratory[]> {
    return this.db.tx(user, (tx) =>
      tx.many<Laboratory>(
        `SELECT l.id, l.branch_id AS "branchId", b.code AS "branchCode", l.country_id AS "countryId",
                l.code, l.name, l.city, l.address, l.timezone, l.is_external AS "isExternal",
                l.is_active AS "isActive", l.contact_email AS "contactEmail",
                l.contact_phone AS "contactPhone", l.notes
         FROM laboratories l LEFT JOIN branches b ON b.id = l.branch_id
         WHERE ($1::boolean IS TRUE OR l.is_active)
         ORDER BY l.is_active DESC, l.is_external, l.name`,
        [includeInactive],
      ),
    );
  }

  createLaboratory(user: AuthUser, input: LaboratoryInput) {
    return this.db.tx(user, async (tx) => {
      const row = await tx.one<{ id: string }>(
        `INSERT INTO laboratories (branch_id, country_id, code, name, city, address, timezone,
                                   is_external, contact_email, contact_phone, notes, created_by)
         VALUES ($1, (SELECT country_id FROM branches WHERE id = $1), upper($2), $3, $4, $5, $6,
                 COALESCE($7, false), $8, $9, $10, $11)
         RETURNING id`,
        [input.branchId ?? null, input.code.trim(), input.name.trim(), input.city ?? null,
         input.address ?? null, input.timezone ?? null, input.isExternal ?? null,
         input.contactEmail ?? null, input.contactPhone ?? null, input.notes ?? null, user.id],
      );
      await this.audit.record(tx, user, {
        action: 'laboratory.create',
        entityType: 'laboratory',
        entityId: row!.id,
        entityLabel: input.name,
        branchId: input.branchId ?? user.branchId,
        after: { code: input.code, isExternal: input.isExternal ?? false },
      });
      // Read back inside this transaction: a second one would not yet see the row.
      return this.laboratoryIn(tx, row!.id);
    });
  }

  /**
   * A laboratory is closed rather than deleted: samples already sent there keep pointing at a
   * row that still says what it was. `isActive: false` only takes it off the dispatch list.
   */
  updateLaboratory(user: AuthUser, id: string, input: UpdateLaboratoryInput) {
    const { sql, params } = buildSet(input as Record<string, unknown>, LAB_UPDATABLE, 2);
    if (!sql) throw new BadRequestException('Nothing to update');

    return this.db.tx(user, async (tx) => {
      const before = await tx.one<{ name: string; branch_id: string | null }>(
        'SELECT name, branch_id FROM laboratories WHERE id = $1',
        [id],
      );
      if (!before) throw new NotFoundException('Laboratory not found');

      await tx.exec(`UPDATE laboratories SET ${sql} WHERE id = $1`, [id, ...params]);
      await this.audit.record(tx, user, {
        action: 'laboratory.update',
        entityType: 'laboratory',
        entityId: id,
        entityLabel: before.name,
        branchId: before.branch_id ?? user.branchId,
        after: input as Record<string, unknown>,
      });
      // The list only carries active ones, so a closed laboratory is fetched on its own.
      return this.laboratoryIn(tx, id);
    });
  }

  private laboratoryIn(tx: Tx, id: string): Promise<Laboratory | null> {
    return tx.one<Laboratory>(
      `SELECT l.id, l.branch_id AS "branchId", b.code AS "branchCode", l.country_id AS "countryId",
              l.code, l.name, l.city, l.address, l.timezone, l.is_external AS "isExternal",
              l.is_active AS "isActive", l.contact_email AS "contactEmail",
              l.contact_phone AS "contactPhone", l.notes
       FROM laboratories l LEFT JOIN branches b ON b.id = l.branch_id WHERE l.id = $1`,
      [id],
    );
  }

  // ---- Internals -------------------------------------------------------------------------

  private custodyIn(tx: Tx, sampleId: string) {
    return tx.many<SampleCustodyEvent>(
      `SELECT ${CUSTODY_COLUMNS} FROM ${CUSTODY_FROM}
       WHERE e.sample_id = $1 ORDER BY e.occurred_at, e.created_at`,
      [sampleId],
    );
  }

  private async assertLaboratory(tx: Tx, id: string): Promise<void> {
    const row = await tx.one<{ is_active: boolean; name: string }>(
      'SELECT is_active, name FROM laboratories WHERE id = $1',
      [id],
    );
    if (!row) throw new BadRequestException('Unknown laboratory');
    if (!row.is_active) throw new BadRequestException(`${row.name} is not active`);
  }

  /**
   * What a sample *is* stops being editable at registration; the account around it stays open
   * until it leaves our hands. Changing the commodity of a registered sample would make its
   * seal, its label and the laboratory's paperwork describe something else.
   */
  private assertEditable(sample: Sample, fields: Record<string, unknown>): void {
    const touched = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    const identity = touched.filter((k) => (SAMPLE_IDENTITY_FIELDS as readonly string[]).includes(k));

    if (identity.length && !IDENTITY_EDITABLE_STATUSES.includes(sample.status)) {
      throw new ConflictException(
        `A sample that is ${sample.status.replace(/_/g, ' ')} cannot have its ${identity.join(', ')} changed;` +
          ' registration settles what the sample is',
      );
    }
    if (!DETAIL_EDITABLE_STATUSES.includes(sample.status)) {
      throw new ConflictException(`A sample that is ${sample.status.replace(/_/g, ' ')} can no longer be edited`);
    }
  }

  /**
   * Builds what a transition writes: the columns the move owns, the custody entry it implies,
   * and the in-memory sample the guards should judge — because the seal number, the
   * destination and the rejection reason arrive *with* the move, not before it.
   *
   * Whoever sealed, dispatched, received or decided defaults to the person doing it. The field
   * exists so somebody can record a colleague's act, not so the record can come out blank.
   */
  private stageFor(action: SampleAction, sample: Sample, input: TransitionPayload, user: AuthUser): Staged {
    const sets: string[] = [];
    const params: unknown[] = [];
    const next: Sample = { ...sample };
    const push = (column: string, value: unknown, cast = '') => {
      params.push(value);
      sets.push(`${column} = $${params.length + 1}${cast}`);
    };

    switch (action) {
      case 'collect':
        if (input.location !== undefined) {
          push('location', input.location);
          next.location = input.location;
        }
        return {
          sample: next,
          extraSet: sets.join(', ') || undefined,
          extraParams: params,
          custody: {
            eventType: 'collected',
            toUserId: sample.sampledBy,
            toLocation: input.location ?? sample.location,
            condition: input.condition ?? null,
            notes: input.notes ?? null,
          },
        };

      case 'register':
        return {
          sample: next,
          custody: { eventType: 'registered', toOfficeId: sample.branchId, notes: input.notes ?? null },
        };

      case 'seal': {
        if (!input.sealNumber?.trim()) throw new BadRequestException('A seal needs its number');
        push('seal_number', input.sealNumber.trim());
        push('seal_type', input.sealType ?? null);
        push('sealed_by', input.sealedBy ?? user.id);
        sets.push('sealed_at = now()', `seal_state = 'intact'::seal_condition`);
        next.sealNumber = input.sealNumber.trim();
        return {
          sample: next,
          extraSet: sets.join(', '),
          extraParams: params,
          metadata: { sealNumber: next.sealNumber },
          custody: {
            eventType: 'sealed',
            sealState: 'intact',
            notes: input.notes ?? null,
            metadata: { sealNumber: next.sealNumber },
          },
        };
      }

      case 'dispatch': {
        const labId = input.destinationLaboratoryId ?? sample.destinationLaboratoryId;
        if (labId) {
          push('destination_laboratory_id', labId);
          next.destinationLaboratoryId = labId;
        }
        push('courier', input.courier ?? null);
        push('tracking_reference', input.trackingReference ?? null);
        push('package_count', input.packageCount ?? null);
        sets.push('dispatched_at = now()');
        push('dispatched_by', input.dispatchedBy ?? user.id);
        return {
          sample: next,
          extraSet: sets.join(', '),
          extraParams: params,
          metadata: { laboratoryId: labId, courier: input.courier ?? null },
          custody: {
            eventType: 'dispatched',
            fromOfficeId: sample.branchId,
            laboratoryId: labId,
            toLocation: input.toLocation ?? null,
            notes: input.notes ?? null,
            metadata: { courier: input.courier ?? null, trackingReference: input.trackingReference ?? null },
          },
        };
      }

      case 'receive': {
        sets.push('received_at = now()');
        push('received_by', input.receivedBy ?? user.id);
        push('received_condition', input.condition ?? null, '::sample_condition');
        push('received_seal_condition', input.sealState ?? null, '::seal_condition');
        if (input.sealState && input.sealState !== 'intact') {
          sets.push('seal_broken_at = now()');
          push('seal_broken_by', input.receivedBy ?? user.id);
        }
        return {
          sample: next,
          extraSet: sets.join(', '),
          extraParams: params,
          metadata: { sealState: input.sealState ?? null, condition: input.condition ?? null },
          custody: {
            eventType: 'lab_received',
            laboratoryId: sample.destinationLaboratoryId,
            toLocation: input.toLocation ?? sample.destinationLaboratoryName ?? null,
            sealState: input.sealState ?? null,
            condition: input.condition ?? null,
            notes: input.notes ?? null,
          },
        };
      }

      case 'accept':
        sets.push('lab_decision_at = now()');
        push('lab_decision_by', input.decidedBy ?? user.id);
        return {
          sample: next,
          extraSet: sets.join(', '),
          extraParams: params,
          custody: {
            eventType: 'lab_accepted',
            laboratoryId: sample.destinationLaboratoryId,
            notes: input.notes ?? null,
          },
        };

      case 'reject': {
        if (!input.rejectionReason) throw new BadRequestException('A rejection reason is required');
        sets.push('lab_decision_at = now()');
        push('lab_decision_by', input.decidedBy ?? user.id);
        push('rejection_reason', input.rejectionReason, '::sample_rejection_reason');
        push('rejection_notes', input.notes ?? input.reason ?? null);
        next.rejectionReason = input.rejectionReason;
        return {
          sample: next,
          extraSet: sets.join(', '),
          extraParams: params,
          metadata: { rejectionReason: input.rejectionReason },
          custody: {
            eventType: 'lab_rejected',
            laboratoryId: sample.destinationLaboratoryId,
            notes: input.notes ?? input.reason ?? null,
            metadata: { rejectionReason: input.rejectionReason },
          },
        };
      }

      case 'return':
        return {
          sample: next,
          custody: {
            eventType: 'returned',
            laboratoryId: sample.destinationLaboratoryId,
            toOfficeId: sample.branchId,
            notes: input.notes ?? input.reason ?? null,
          },
        };

      default:
        // hold, resume, cancel: business decisions that move nothing physical.
        return { sample: next };
    }
  }
}

export interface TransitionPayload {
  reason?: string | null;
  notes?: string | null;
  location?: string | null;
  toLocation?: string | null;
  sealNumber?: string | null;
  sealType?: string | null;
  sealedBy?: string | null;
  sealState?: SealCondition | null;
  condition?: SampleCondition | null;
  destinationLaboratoryId?: string | null;
  courier?: string | null;
  trackingReference?: string | null;
  packageCount?: number | null;
  dispatchedBy?: string | null;
  receivedBy?: string | null;
  decidedBy?: string | null;
  rejectionReason?: SampleRejectionReason | null;
}

export interface HandoverInput {
  eventType?: CustodyEventType;
  fromUserId?: string | null;
  fromOfficeId?: string | null;
  fromLocation?: string | null;
  toUserId?: string | null;
  toOfficeId?: string | null;
  toLocation?: string | null;
  occurredAt?: string | null;
  sealState?: SealCondition | null;
  condition?: SampleCondition | null;
  notes?: string | null;
}

export type UpdateLaboratoryInput = Partial<Omit<LaboratoryInput, 'code' | 'branchId' | 'isExternal'>> & {
  isActive?: boolean;
};

export interface LaboratoryInput {
  code: string;
  name: string;
  branchId?: string | null;
  city?: string | null;
  address?: string | null;
  timezone?: string | null;
  isExternal?: boolean;
  contactEmail?: string | null;
  contactPhone?: string | null;
  notes?: string | null;
}

export interface CorrectionInput {
  notes: string;
  toUserId?: string | null;
  toLocation?: string | null;
  sealState?: SealCondition | null;
  condition?: SampleCondition | null;
}

interface Staged {
  sample: Sample;
  extraSet?: string;
  extraParams?: unknown[];
  metadata?: Record<string, unknown>;
  custody?: Omit<CustodyInput, 'sampleId' | 'branchId' | 'eventType'> & { eventType: CustodyEventType };
}
