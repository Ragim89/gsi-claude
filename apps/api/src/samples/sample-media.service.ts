import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import sharp from 'sharp';
import * as QRCode from 'qrcode';
import {
  AuthUser,
  InspectionPhoto,
  PhotoCategory,
  Sample,
  SampleLabel,
  localize,
} from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { StorageService } from '../storage/storage.service';
import { AuditService } from '../common/audit.service';
import { config } from '../config';
import { SamplesService } from './samples.service';

export interface SampleMediaMeta {
  category?: PhotoCategory;
  caption?: string;
  gpsLat?: number;
  gpsLng?: number;
  gpsAccuracyM?: number;
  takenAt?: string;
}

const PHOTO_COLUMNS = `
  m.id, m.inspection_id AS "inspectionId", m.job_id AS "jobId", m.checklist_item_id AS "checklistItemId",
  m.category, m.caption, m.mime_type AS "mimeType", m.size_bytes::float8 AS "sizeBytes", m.sha256,
  m.original_name AS "originalName", m.gps_lat AS "gpsLat", m.gps_lng AS "gpsLng",
  m.gps_accuracy_m AS "gpsAccuracyM", m.taken_at AS "takenAt", m.created_at AS "createdAt",
  m.uploaded_by AS "uploadedBy", u.full_name AS "uploadedByName",
  m.storage_key AS "storageKey", m.preview_key AS "previewKey"`;

type PhotoRow = InspectionPhoto & { storageKey: string; previewKey: string | null };

// Photos and scanned paperwork: a handover note is as much evidence as a photograph of a seal.
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
]);
const PREVIEW_MAX_PX = 1600;

/**
 * Photographs and documents attached to a sample, and the printable label that travels with it.
 *
 * Same `media_attachments` table as everything else — a seal photograph is a photograph, and a
 * second media system would only be a second place to look for evidence.
 */
@Injectable()
export class SampleMediaService {
  private readonly logger = new Logger(SampleMediaService.name);

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly samples: SamplesService,
  ) {}

  list(user: AuthUser, sampleId: string): Promise<InspectionPhoto[]> {
    return this.db.tx(user, async (tx) => {
      await this.samples.load(tx, sampleId);
      return this.signAll(await this.rowsIn(tx, sampleId));
    });
  }

  async add(user: AuthUser, sampleId: string, file: Express.Multer.File, meta: SampleMediaMeta) {
    if (!file) throw new BadRequestException('File is required');
    if (!ALLOWED_MIME.has(file.mimetype)) throw new BadRequestException(`Unsupported file type ${file.mimetype}`);
    if (file.size > config.maxUploadBytes) throw new BadRequestException('File is too large');

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const preview = file.mimetype.startsWith('image/') ? await this.makePreview(file.buffer) : null;

    return this.db.tx(user, async (tx) => {
      const sample = await this.samples.load(tx, sampleId);
      if (sample.status === 'cancelled') {
        throw new ConflictException('A cancelled sample takes no further evidence');
      }

      const id = randomUUID();
      const ext = (file.originalname.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
      const base = `branches/${sample.branchCode}/samples/${sample.sampleNumber}`;
      const storageKey = `${base}/${id}.${ext}`;
      const previewKey = preview ? `${base}/preview/${id}.jpg` : null;

      // Originals byte for byte, sha256 alongside: an auditor has to be able to check them.
      await this.storage.put(storageKey, file.buffer, file.mimetype, { sha256, 'uploaded-by': user.id });
      if (preview && previewKey) await this.storage.put(previewKey, preview, 'image/jpeg');

      const takenAt = meta.takenAt && !Number.isNaN(Date.parse(meta.takenAt)) ? meta.takenAt : new Date().toISOString();

      await tx.exec(
        `INSERT INTO media_attachments (id, job_id, inspection_id, sample_id, type, category, caption,
                                        storage_key, preview_key, mime_type, size_bytes, sha256, original_name,
                                        gps_lat, gps_lng, gps_accuracy_m, taken_at, uploaded_by)
         VALUES ($1, $2, $3, $4, 'photo', $5::photo_category, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [id, sample.jobId, sample.inspectionId, sample.id, meta.category ?? 'sampling', meta.caption ?? null,
         storageKey, previewKey, file.mimetype, file.size, sha256, file.originalname,
         meta.gpsLat ?? null, meta.gpsLng ?? null, meta.gpsAccuracyM ?? null, takenAt, user.id],
      );

      await this.audit.record(tx, user, {
        action: 'sample.attachment_added',
        entityType: 'sample',
        entityId: sample.id,
        entityLabel: sample.sampleNumber,
        branchId: sample.branchId,
        after: { mediaId: id, category: meta.category ?? 'sampling', originalName: file.originalname },
      });

      const rows = await this.rowsIn(tx, sample.id, id);
      return this.sign(rows[0]);
    });
  }

  /**
   * The printable label.
   *
   * The QR is a deep link into the application, not a public page: a report's QR proves a
   * document genuine to an outside party, but a label taped to a bag in a port should not tell
   * a stranger whose cargo it is or where it is going. Scanning it without a session gets a
   * login screen; with one, the same Row-Level Security applies as everywhere else.
   */
  label(user: AuthUser, sampleId: string, locale = 'en'): Promise<SampleLabel> {
    return this.db.tx(user, async (tx) => {
      const sample = await this.samples.load(tx, sampleId);
      const url = `${config.publicWebUrl}/samples/${sample.id}`;
      const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: 'M' });

      await this.audit.record(tx, user, {
        action: 'sample.label_printed',
        entityType: 'sample',
        entityId: sample.id,
        entityLabel: sample.sampleNumber,
        branchId: sample.branchId,
      });

      return {
        sampleNumber: sample.sampleNumber,
        jobNumber: sample.jobNumber ?? '',
        clientName: sample.clientName ?? '',
        commodity: this.commodityLabel(sample, locale),
        sampleType: sample.sampleType,
        quantity: sample.quantity != null ? `${sample.quantity} ${sample.unit ?? ''}`.trim() : null,
        sealNumber: sample.sealNumber,
        sampledAt: sample.sampledAt,
        branchCode: sample.branchCode ?? '',
        destination: sample.destinationLaboratoryName ?? null,
        url,
        qrDataUrl,
      };
    });
  }

  // ---- Internals -------------------------------------------------------------------------

  /** The reference name in the reader's language, or whatever the inspector wrote by hand. */
  private commodityLabel(sample: Sample, locale: string): string | null {
    return sample.commodityName ? localize(sample.commodityName, locale) : sample.commodity;
  }

  private rowsIn(tx: Tx, sampleId: string, id?: string): Promise<PhotoRow[]> {
    return tx.many<PhotoRow>(
      `SELECT ${PHOTO_COLUMNS} FROM media_attachments m
       LEFT JOIN users u ON u.id = m.uploaded_by
       WHERE m.sample_id = $1 ${id ? 'AND m.id = $2' : ''}
       ORDER BY m.created_at`,
      id ? [sampleId, id] : [sampleId],
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


