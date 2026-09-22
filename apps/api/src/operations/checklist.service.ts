import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import sharp from 'sharp';
import { AuthUser, ChecklistItem, ChecklistResult, InspectionJob, MediaAttachment } from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { StorageService } from '../storage/storage.service';
import { buildSet } from '../common/sql';
import { JobsService } from './jobs.service';

const ITEM_COLUMNS = `
  id, job_id AS "jobId", item_key AS "itemKey", label, input_kind AS "inputKind", sort_order AS "sortOrder",
  result, value, notes, updated_at AS "updatedAt"`;

const MEDIA_COLUMNS = `
  id, job_id AS "jobId", checklist_item_id AS "checklistItemId", type, mime_type AS "mimeType",
  size_bytes::float8 AS "sizeBytes", sha256, original_name AS "originalName", gps_lat AS "gpsLat",
  gps_lng AS "gpsLng", gps_accuracy_m AS "gpsAccuracyM", taken_at AS "takenAt", created_at AS "createdAt",
  storage_key AS "storageKey", preview_key AS "previewKey"`;

type MediaRow = MediaAttachment & { storageKey: string; previewKey: string | null };

export interface UpdateItemInput {
  result?: ChecklistResult | null;
  value?: string | null;
  notes?: string | null;
}

export interface UploadMeta {
  gpsLat?: number;
  gpsLng?: number;
  gpsAccuracyM?: number;
  takenAt?: string;
}

// ASSUMPTION: MVP-1 accepts photos only (the web checklist). Video capture/transcoding comes with
// the mobile app; the schema already supports media_type 'video'.
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const PREVIEW_MAX_PX = 1600;

@Injectable()
export class ChecklistService {
  private readonly logger = new Logger(ChecklistService.name);

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly jobs: JobsService,
  ) {}

  list(user: AuthUser, jobId: string): Promise<ChecklistItem[]> {
    return this.db.tx(user, async (tx) => {
      await this.jobs.load(tx, jobId);
      const items = await tx.many<ChecklistItem>(
        `SELECT ${ITEM_COLUMNS} FROM job_checklist_items WHERE job_id = $1 ORDER BY sort_order, item_key`,
        [jobId],
      );
      const media = await tx.many<MediaRow>(
        `SELECT ${MEDIA_COLUMNS} FROM media_attachments WHERE job_id = $1 ORDER BY created_at`,
        [jobId],
      );
      const signed = await Promise.all(media.map((m) => this.sign(m)));
      return items.map((it) => ({ ...it, media: signed.filter((m) => m.checklistItemId === it.id) }));
    });
  }

  updateItem(user: AuthUser, jobId: string, itemId: string, input: UpdateItemInput) {
    const { sql, params } = buildSet(input as Record<string, unknown>, { result: 'result', value: 'value', notes: 'notes' }, 3);
    if (!sql) throw new BadRequestException('Nothing to update');
    return this.db.tx(user, async (tx) => {
      await this.lockEditableJob(tx, user, jobId);
      const row = await tx.one<ChecklistItem>(
        `UPDATE job_checklist_items SET ${sql}, updated_by = $${3 + params.length}
         WHERE id = $1 AND job_id = $2 RETURNING ${ITEM_COLUMNS}`,
        [itemId, jobId, ...params, user.id],
      );
      if (!row) throw new NotFoundException('Checklist item not found');
      return row;
    });
  }

  async upload(user: AuthUser, jobId: string, itemId: string, file: Express.Multer.File, meta: UploadMeta) {
    if (!file) throw new BadRequestException('File is required');
    if (!ALLOWED_MIME.has(file.mimetype)) throw new BadRequestException(`Unsupported file type ${file.mimetype}`);

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const preview = await this.makePreview(file.buffer);

    return this.db.tx(user, async (tx) => {
      const job = await this.lockEditableJob(tx, user, jobId);
      const item = await tx.one<{ item_key: string }>(
        'SELECT item_key FROM job_checklist_items WHERE id = $1 AND job_id = $2',
        [itemId, jobId],
      );
      if (!item) throw new NotFoundException('Checklist item not found');

      const id = randomUUID();
      const ext = (file.originalname.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
      const base = `branches/${job.branchCode}/jobs/${job.jobNumber}/${item.item_key}`;
      const storageKey = `${base}/${id}.${ext}`;
      const previewKey = preview ? `${base}/preview/${id}.jpg` : null;

      // Originals are stored byte-for-byte (ISO 17020 audit); sha256 lets auditors verify integrity.
      await this.storage.put(storageKey, file.buffer, file.mimetype, { sha256, 'uploaded-by': user.id });
      if (preview && previewKey) await this.storage.put(previewKey, preview, 'image/jpeg');

      // ASSUMPTION: capture time comes from the client (file lastModified / device clock) and GPS
      // from the browser Geolocation API. Reading EXIF DateTimeOriginal/GPS server-side is MVP-2.
      const takenAt = meta.takenAt && !Number.isNaN(Date.parse(meta.takenAt)) ? meta.takenAt : new Date().toISOString();

      const row = await tx.one<MediaRow>(
        `INSERT INTO media_attachments (id, job_id, checklist_item_id, type, storage_key, preview_key, mime_type,
                                        size_bytes, sha256, original_name, gps_lat, gps_lng, gps_accuracy_m,
                                        taken_at, uploaded_by)
         VALUES ($1, $2, $3, 'photo', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING ${MEDIA_COLUMNS}`,
        [id, jobId, itemId, storageKey, previewKey, file.mimetype, file.size, sha256, file.originalname,
         meta.gpsLat ?? null, meta.gpsLng ?? null, meta.gpsAccuracyM ?? null, takenAt, user.id],
      );
      return this.sign(row!);
    });
  }

  removeMedia(user: AuthUser, mediaId: string) {
    return this.db.tx(user, async (tx) => {
      const m = await tx.one<{ job_id: string; storage_key: string; preview_key: string | null }>(
        'SELECT job_id, storage_key, preview_key FROM media_attachments WHERE id = $1',
        [mediaId],
      );
      if (!m) throw new NotFoundException('Media not found');
      await this.lockEditableJob(tx, user, m.job_id);
      await tx.exec('DELETE FROM media_attachments WHERE id = $1', [mediaId]);
      // Evidence is only deletable before approval; once a report is issued the job is locked.
      await this.storage.delete(m.storage_key).catch((e) => this.logger.warn(`delete ${m.storage_key}: ${e.message}`));
      if (m.preview_key) await this.storage.delete(m.preview_key).catch(() => undefined);
    });
  }

  /**
   * Inspectors edit while the job is assigned / in progress (first edit starts the job);
   * supervisors and admins may also correct items while the job is under review.
   */
  private async lockEditableJob(tx: Tx, user: AuthUser, jobId: string): Promise<InspectionJob> {
    const job = await this.jobs.load(tx, jobId, true);
    const isInspector = user.role === 'inspector';
    if (isInspector && job.assignedInspectorId !== user.id) throw new ForbiddenException('Job is not assigned to you');

    const editable = isInspector ? ['assigned', 'in_progress'] : ['assigned', 'in_progress', 'under_review'];
    if (!editable.includes(job.status)) {
      throw new ConflictException(`Checklist cannot be changed while the job is ${job.status}`);
    }
    if (job.status === 'assigned') {
      await tx.exec(`UPDATE inspection_jobs SET status = 'in_progress' WHERE id = $1`, [jobId]);
      job.status = 'in_progress';
    }
    return job;
  }

  private async makePreview(buf: Buffer): Promise<Buffer | null> {
    try {
      return await sharp(buf)
        .rotate() // honour EXIF orientation
        .resize(PREVIEW_MAX_PX, PREVIEW_MAX_PX, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch (err) {
      // e.g. HEIC without libheif support — original is still stored, UI falls back to it.
      this.logger.warn(`preview generation failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async sign(m: MediaRow): Promise<MediaAttachment> {
    const { storageKey, previewKey, ...rest } = m;
    const [url, previewUrl] = await Promise.all([
      this.storage.presignGet(storageKey),
      this.storage.presignGet(previewKey ?? storageKey),
    ]);
    return { ...rest, url, previewUrl };
  }
}
