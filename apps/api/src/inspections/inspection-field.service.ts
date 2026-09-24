import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import sharp from 'sharp';
import {
  AuthUser,
  EDITABLE_INSPECTION_STATUSES,
  Inspection,
  InspectionChecklist,
  InspectionChecklistItem,
  InspectionPhoto,
  PhotoCategory,
} from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { StorageService } from '../storage/storage.service';
import { AuditService } from '../common/audit.service';
import { InspectionsService } from './inspections.service';
import { InspectionWorkflowService } from './inspection-workflow.service';

export interface ChecklistAnswer {
  itemId: string;
  result?: 'ok' | 'deviation' | 'na' | null;
  value?: string | null;
  notes?: string | null;
}

export interface PhotoMeta {
  category?: PhotoCategory;
  caption?: string;
  checklistItemId?: string;
  gpsLat?: number;
  gpsLng?: number;
  gpsAccuracyM?: number;
  takenAt?: string;
}

const ITEM_COLUMNS = `
  id, inspection_id AS "inspectionId", job_id AS "jobId", item_key AS "itemKey", label,
  section, input_kind AS "inputKind", is_required AS "isRequired", sort_order AS "sortOrder",
  result, value, notes, updated_at AS "updatedAt"`;

const PHOTO_COLUMNS = `
  m.id, m.inspection_id AS "inspectionId", m.job_id AS "jobId", m.checklist_item_id AS "checklistItemId",
  m.category, m.caption, m.mime_type AS "mimeType", m.size_bytes::float8 AS "sizeBytes", m.sha256,
  m.original_name AS "originalName", m.gps_lat AS "gpsLat", m.gps_lng AS "gpsLng",
  m.gps_accuracy_m AS "gpsAccuracyM", m.taken_at AS "takenAt", m.created_at AS "createdAt",
  m.uploaded_by AS "uploadedBy", u.full_name AS "uploadedByName",
  m.storage_key AS "storageKey", m.preview_key AS "previewKey"`;

type PhotoRow = InspectionPhoto & { storageKey: string; previewKey: string | null };

// Photos only for now; the schema already carries media type 'video' for when field video arrives.
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const PREVIEW_MAX_PX = 1600;
const MAX_BATCH = 200;

/**
 * The field screen's half of the inspection: checklist answers, and the photos that prove them.
 *
 * Built for a phone with one bar of signal — answers arrive as a batch the screen has
 * debounced, so a lost connection costs the last few seconds of typing rather than the whole
 * walk round the hold.
 */
@Injectable()
export class InspectionFieldService {
  private readonly logger = new Logger(InspectionFieldService.name);

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly inspections: InspectionsService,
    private readonly workflow: InspectionWorkflowService,
  ) {}

  checklist(user: AuthUser, inspectionId: string): Promise<InspectionChecklist> {
    return this.db.tx(user, async (tx) => {
      const inspection = await this.inspections.load(tx, inspectionId);
      return this.summarise(await this.itemsWithMedia(tx, inspection.id), inspection);
    });
  }

  /**
   * Saves a batch of answers. An answer naming an item of another inspection is rejected
   * rather than silently skipped: a screen sending the wrong ids is a bug, and swallowing it
   * would lose an inspector's work without telling anyone.
   */
  saveChecklist(user: AuthUser, inspectionId: string, answers: ChecklistAnswer[]): Promise<InspectionChecklist> {
    if (!answers.length) throw new BadRequestException('No answers to save');
    if (answers.length > MAX_BATCH) throw new BadRequestException(`At most ${MAX_BATCH} answers per request`);

    return this.db.tx(user, async (tx) => {
      const loaded = await this.inspections.load(tx, inspectionId, true);
      this.assertEditable(loaded);
      await this.assertMayRecord(tx, user, loaded);
      const inspection = await this.autoStart(tx, user, loaded);

      for (const a of answers) {
        // COALESCE on result and the boolean flags on value/notes let a batch carry a partial
        // answer: the screen sends the field the inspector touched, not the whole item.
        const row = await tx.one<{ id: string }>(
          `UPDATE job_checklist_items
              SET result = COALESCE($3::checklist_result, result),
                  value = CASE WHEN $4::boolean THEN $5 ELSE value END,
                  notes = CASE WHEN $6::boolean THEN $7 ELSE notes END,
                  updated_by = $8,
                  updated_at = now()
            WHERE id = $1 AND inspection_id = $2
            RETURNING id`,
          [
            a.itemId,
            inspection.id,
            a.result ?? null,
            a.value !== undefined,
            a.value ?? null,
            a.notes !== undefined,
            a.notes ?? null,
            user.id,
          ],
        );
        if (!row) throw new NotFoundException(`Checklist item ${a.itemId} does not belong to this inspection`);
      }

      const summary = this.summarise(await this.itemsWithMedia(tx, inspection.id), inspection);
      // One audit line per save, not one per answer — the trail stays readable.
      await this.audit.record(tx, user, {
        action: 'inspection.checklist_update',
        entityType: 'inspection',
        entityId: inspection.id,
        entityLabel: inspection.inspectionNumber,
        branchId: inspection.branchId,
        after: { items: answers.length, answered: summary.answered, requiredRemaining: summary.requiredRemaining },
      });
      return summary;
    });
  }

  photos(user: AuthUser, inspectionId: string): Promise<InspectionPhoto[]> {
    return this.db.tx(user, async (tx) => {
      const inspection = await this.inspections.load(tx, inspectionId);
      return this.signAll(await this.photosIn(tx, inspection.id));
    });
  }

  async addPhoto(
    user: AuthUser,
    inspectionId: string,
    file: Express.Multer.File,
    meta: PhotoMeta,
  ): Promise<InspectionPhoto> {
    if (!file) throw new BadRequestException('File is required');
    if (!ALLOWED_MIME.has(file.mimetype)) throw new BadRequestException(`Unsupported file type ${file.mimetype}`);

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const preview = await this.makePreview(file.buffer);

    return this.db.tx(user, async (tx) => {
      const loaded = await this.inspections.load(tx, inspectionId, true);
      this.assertEditable(loaded, 'added to');
      await this.assertMayRecord(tx, user, loaded);
      const inspection = await this.autoStart(tx, user, loaded);

      if (meta.checklistItemId) {
        const item = await tx.one<{ id: string }>(
          'SELECT id FROM job_checklist_items WHERE id = $1 AND inspection_id = $2',
          [meta.checklistItemId, inspection.id],
        );
        if (!item) throw new NotFoundException('That checklist item does not belong to this inspection');
      }

      const id = randomUUID();
      const ext = (file.originalname.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
      const base = `branches/${inspection.branchCode}/inspections/${inspection.inspectionNumber}`;
      const storageKey = `${base}/${id}.${ext}`;
      const previewKey = preview ? `${base}/preview/${id}.jpg` : null;

      // Originals are stored byte-for-byte (ISO 17020 audit); sha256 lets auditors verify integrity.
      await this.storage.put(storageKey, file.buffer, file.mimetype, { sha256, 'uploaded-by': user.id });
      if (preview && previewKey) await this.storage.put(previewKey, preview, 'image/jpeg');

      // Capture time comes from the device clock; reading EXIF server-side is a later refinement.
      const takenAt = meta.takenAt && !Number.isNaN(Date.parse(meta.takenAt)) ? meta.takenAt : new Date().toISOString();

      await tx.exec(
        `INSERT INTO media_attachments (id, job_id, inspection_id, checklist_item_id, type, category, caption,
                                        storage_key, preview_key, mime_type, size_bytes, sha256, original_name,
                                        gps_lat, gps_lng, gps_accuracy_m, taken_at, uploaded_by)
         VALUES ($1, $2, $3, $4, 'photo', $5::photo_category, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [id, inspection.jobId, inspection.id, meta.checklistItemId ?? null, meta.category ?? 'general',
         meta.caption ?? null, storageKey, previewKey, file.mimetype, file.size, sha256, file.originalname,
         meta.gpsLat ?? null, meta.gpsLng ?? null, meta.gpsAccuracyM ?? null, takenAt, user.id],
      );

      await this.audit.record(tx, user, {
        action: 'inspection.photo_add',
        entityType: 'inspection',
        entityId: inspection.id,
        entityLabel: inspection.inspectionNumber,
        branchId: inspection.branchId,
        after: { photoId: id, category: meta.category ?? 'general', originalName: file.originalname },
      });

      const rows = await this.photosIn(tx, inspection.id, id);
      return this.sign(rows[0]);
    });
  }

  // ---- Internals -----------------------------------------------------------------------

  private async itemsWithMedia(tx: Tx, inspectionId: string): Promise<InspectionChecklistItem[]> {
    const items = await tx.many<Omit<InspectionChecklistItem, 'media'>>(
      `SELECT ${ITEM_COLUMNS} FROM job_checklist_items
       WHERE inspection_id = $1 ORDER BY sort_order, item_key`,
      [inspectionId],
    );
    const photos = await this.signAll(await this.photosIn(tx, inspectionId));
    return items.map((it) => ({
      ...it,
      media: photos
        .filter((p) => p.checklistItemId === it.id)
        .map((p) => ({ id: p.id, url: p.url, previewUrl: p.previewUrl, caption: p.caption })),
    }));
  }

  private photosIn(tx: Tx, inspectionId: string, id?: string): Promise<PhotoRow[]> {
    return tx.many<PhotoRow>(
      `SELECT ${PHOTO_COLUMNS}
       FROM media_attachments m
       LEFT JOIN users u ON u.id = m.uploaded_by
       WHERE m.inspection_id = $1 ${id ? 'AND m.id = $2' : ''}
       ORDER BY m.created_at`,
      id ? [inspectionId, id] : [inspectionId],
    );
  }

  private summarise(items: InspectionChecklistItem[], inspection: Inspection): InspectionChecklist {
    return {
      items,
      total: items.length,
      answered: items.filter((i) => i.result !== null).length,
      requiredRemaining: items.filter((i) => i.isRequired && i.result === null).length,
      editable: EDITABLE_INSPECTION_STATUSES.includes(inspection.status),
    };
  }

  private assertEditable(inspection: Inspection, verb = 'changed'): void {
    if (!EDITABLE_INSPECTION_STATUSES.includes(inspection.status)) {
      throw new ConflictException(
        `An inspection that is ${inspection.status.replace(/_/g, ' ')} can no longer be ${verb}` +
          (inspection.status === 'approved' ? '; reopen it first, which is recorded' : ''),
      );
    }
  }

  /**
   * Field roles record their own work; the office can correct it on their behalf.
   *
   * Not-found rather than forbidden: someone with `own` scope has no business learning that
   * an inspection they are not on exists.
   */
  private async assertMayRecord(tx: Tx, user: AuthUser, inspection: Inspection): Promise<void> {
    if (user.scope !== 'own') return;
    if (inspection.leadInspectorId === user.id) return;
    const row = await tx.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM inspection_assignments
       WHERE inspection_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [inspection.id, user.id],
    );
    if (!row?.n) throw new NotFoundException('Inspection not found');
  }

  /**
   * The first answer or photo starts a scheduled inspection — the inspector is plainly on
   * site. It goes through the workflow service, so the start lands in the history, the audit
   * log and the actual-start stamp exactly as a deliberate press of Start would.
   */
  private async autoStart(tx: Tx, user: AuthUser, inspection: Inspection): Promise<Inspection> {
    if (inspection.status !== 'scheduled' && inspection.status !== 'draft') return inspection;
    if (!user.permissions?.includes('inspection.start')) return inspection;
    const status = await this.workflow.apply(tx, user, inspection, 'start', {
      metadata: { auto: true, trigger: 'field_entry' },
    });
    return { ...inspection, status };
  }

  private async makePreview(buf: Buffer): Promise<Buffer | null> {
    try {
      return await sharp(buf)
        .rotate() // honour EXIF orientation
        .resize(PREVIEW_MAX_PX, PREVIEW_MAX_PX, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch (err) {
      // e.g. HEIC without libheif support — the original is still stored, the UI falls back to it.
      this.logger.warn(`preview generation failed: ${(err as Error).message}`);
      return null;
    }
  }

  private signAll(rows: PhotoRow[]): Promise<InspectionPhoto[]> {
    return Promise.all(rows.map((r) => this.sign(r)));
  }

  private async sign(m: PhotoRow): Promise<InspectionPhoto> {
    const { storageKey, previewKey, ...rest } = m;
    const [url, previewUrl] = await Promise.all([
      this.storage.presignGet(storageKey),
      this.storage.presignGet(previewKey ?? storageKey),
    ]);
    return { ...rest, url, previewUrl };
  }
}
