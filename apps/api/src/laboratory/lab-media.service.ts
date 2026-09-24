import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import sharp from 'sharp';
import { AuthUser, LabAttachment, RESULT_EDITABLE_STATUSES } from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { StorageService } from '../storage/storage.service';
import { AuditService } from '../common/audit.service';
import { config } from '../config';
import { LabRequestsService } from './lab-requests.service';

const PHOTO_COLUMNS = `
  m.id, m.inspection_id AS "inspectionId", m.job_id AS "jobId", m.checklist_item_id AS "checklistItemId",
  m.category, m.caption, m.mime_type AS "mimeType", m.size_bytes::float8 AS "sizeBytes", m.sha256,
  m.original_name AS "originalName", m.gps_lat AS "gpsLat", m.gps_lng AS "gpsLng",
  m.gps_accuracy_m AS "gpsAccuracyM", m.taken_at AS "takenAt", m.created_at AS "createdAt",
  m.uploaded_by AS "uploadedBy", u.full_name AS "uploadedByName",
  m.storage_key AS "storageKey", m.preview_key AS "previewKey"`;

type PhotoRow = LabAttachment & { storageKey: string; previewKey: string | null };

// An instrument printout is usually a PDF and a worksheet is usually a photograph of paper.
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
]);
const PREVIEW_MAX_PX = 1600;

/**
 * The paper behind a result: instrument printouts, weighing records, worksheets.
 *
 * Attached to the **revision**, not to the analysis, because that is what they are evidence
 * for. When a result is amended, the new revision starts with its own paperwork and the old
 * revision keeps the printout that was actually read when it was signed.
 *
 * Same `media_attachments` table as everything else: a scan is a scan, and a second media
 * system would only be a second place to look for evidence.
 */
@Injectable()
export class LabMediaService {
  private readonly logger = new Logger(LabMediaService.name);

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly requests: LabRequestsService,
  ) {}

  /** Everything attached to any revision of this analysis, oldest first. */
  list(user: AuthUser, requestId: string): Promise<LabAttachment[]> {
    return this.db.tx(user, async (tx) => {
      await this.requests.load(tx, requestId);
      return this.signAll(await this.rowsIn(tx, requestId));
    });
  }

  async add(user: AuthUser, requestId: string, file: Express.Multer.File, caption?: string) {
    if (!file) throw new BadRequestException('File is required');
    if (!ALLOWED_MIME.has(file.mimetype)) throw new BadRequestException(`Unsupported file type ${file.mimetype}`);
    if (file.size > config.maxUploadBytes) throw new BadRequestException('File is too large');

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const preview = file.mimetype.startsWith('image/') ? await this.makePreview(file.buffer) : null;

    return this.db.tx(user, async (tx) => {
      const request = await this.requests.load(tx, requestId);
      if (!request.result) {
        throw new ConflictException('Enter the result first; the paperwork belongs to a revision');
      }
      if (!RESULT_EDITABLE_STATUSES.includes(request.status)) {
        throw new ConflictException(
          'This revision has been handed in; its paperwork can no longer be changed. An amendment starts a new revision',
        );
      }

      const id = randomUUID();
      const ext = (file.originalname.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
      const base = `branches/${request.branchCode}/lab/${request.sampleNumber}/${request.testCode}`;
      const storageKey = `${base}/${id}.${ext}`;
      const previewKey = preview ? `${base}/preview/${id}.jpg` : null;

      await this.storage.put(storageKey, file.buffer, file.mimetype, { sha256, 'uploaded-by': user.id });
      if (preview && previewKey) await this.storage.put(previewKey, preview, 'image/jpeg');

      await tx.exec(
        `INSERT INTO media_attachments (id, job_id, inspection_id, sample_id, test_result_id, type, category,
                                        caption, storage_key, preview_key, mime_type, size_bytes, sha256,
                                        original_name, taken_at, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, 'photo', 'document', $6, $7, $8, $9, $10, $11, $12, now(), $13)`,
        [id, request.jobId ?? null, request.inspectionId ?? null, request.sampleId, request.result.id,
         caption ?? null, storageKey, previewKey, file.mimetype, file.size, sha256, file.originalname, user.id],
      );

      await this.audit.record(tx, user, {
        action: 'lab.result.attachment_added',
        entityType: 'test_request',
        entityId: request.id,
        entityLabel: `${request.sampleNumber} · ${request.testCode}`,
        branchId: request.branchId,
        after: { mediaId: id, revision: request.result.revision, originalName: file.originalname },
      });

      const rows = await this.rowsIn(tx, requestId, id);
      return this.sign(rows[0]);
    });
  }

  // ---- Internals -------------------------------------------------------------------------

  private rowsIn(tx: Tx, requestId: string, id?: string): Promise<PhotoRow[]> {
    return tx.many<PhotoRow>(
      `SELECT ${PHOTO_COLUMNS}, r.revision FROM media_attachments m
       JOIN test_results r ON r.id = m.test_result_id
       LEFT JOIN users u ON u.id = m.uploaded_by
       WHERE r.test_request_id = $1 ${id ? 'AND m.id = $2' : ''}
       ORDER BY r.revision, m.created_at`,
      id ? [requestId, id] : [requestId],
    );
  }

  private async makePreview(buf: Buffer): Promise<Buffer | null> {
    try {
      return await sharp(buf)
        .rotate()
        .resize(PREVIEW_MAX_PX, PREVIEW_MAX_PX, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch (err) {
      this.logger.warn(`preview generation failed: ${(err as Error).message}`);
      return null;
    }
  }

  private signAll(rows: PhotoRow[]): Promise<LabAttachment[]> {
    return Promise.all(rows.map((r) => this.sign(r)));
  }

  private async sign(m: PhotoRow): Promise<LabAttachment> {
    const { storageKey, previewKey, ...rest } = m;
    const [url, previewUrl] = await Promise.all([
      this.storage.presignGet(storageKey),
      this.storage.presignGet(previewKey ?? storageKey),
    ]);
    return { ...rest, url, previewUrl };
  }
}
