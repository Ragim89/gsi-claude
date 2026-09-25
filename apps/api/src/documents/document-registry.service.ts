import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AuthUser,
  DocumentCategory,
  DocumentEntityType,
  DocumentRecord,
  DocumentVisibility,
} from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../common/audit.service';
import { StorageService } from '../storage/storage.service';

export interface DocumentFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

/** mime → accepted extensions. Both must agree, so a renamed file cannot slip past the mime check alone. */
const ALLOWED_TYPES: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
};

/** The table each entity type's branch and existence are checked against. Fixed set, never user input. */
const ENTITY_TABLES: Record<DocumentEntityType, string> = {
  client: 'clients',
  job: 'inspection_jobs',
  inspection: 'inspections',
  sample: 'samples',
  report: 'reports',
  invoice: 'invoices',
};

function extensionOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i === -1 ? '' : filename.slice(i).toLowerCase();
}

function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 100);
}

const row = (r: Record<string, unknown>): DocumentRecord & { storageKey: string | null } => ({
  id: String(r.id),
  branchId: String(r.branchId),
  entityType: r.entityType as DocumentEntityType,
  entityId: String(r.entityId),
  category: r.category as DocumentCategory,
  title: String(r.title),
  filename: String(r.filename),
  mimeType: String(r.mimeType),
  sizeBytes: Number(r.sizeBytes),
  version: Number(r.version),
  replacesId: r.replacesId ? String(r.replacesId) : null,
  visibility: r.visibility as DocumentVisibility,
  reportVersionId: r.reportVersionId ? String(r.reportVersionId) : null,
  metadata: (r.metadata as Record<string, unknown> | null) ?? null,
  uploadedBy: String(r.uploadedBy),
  uploadedByName: r.uploadedByName ? String(r.uploadedByName) : undefined,
  uploadedAt: String(r.uploadedAt),
  archivedAt: r.archivedAt ? String(r.archivedAt) : null,
  storageKey: r.storageKey ? String(r.storageKey) : null,
});

const SELECT = `
  SELECT d.id::text, d.branch_id::text AS "branchId", d.entity_type::text AS "entityType",
         d.entity_id::text AS "entityId", d.category::text AS category, d.title, d.filename,
         d.mime_type AS "mimeType", d.size_bytes::bigint AS "sizeBytes", d.version,
         d.replaces_id::text AS "replacesId", d.visibility::text AS visibility,
         d.report_version_id::text AS "reportVersionId", d.metadata, d.storage_key AS "storageKey",
         d.uploaded_by::text AS "uploadedBy", u.full_name AS "uploadedByName",
         d.uploaded_at AS "uploadedAt", d.archived_at AS "archivedAt"
  FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by`;

/**
 * The general documents registry (PHASE 10) — everything that is not a report/certificate's
 * own generated PDF (that stays ReportDocumentsService's, see documents.module.ts). Storage
 * always goes through the one `StorageService` the media and contract uploads already use.
 */
@Injectable()
export class DocumentRegistryService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  list(user: AuthUser, entityType: DocumentEntityType, entityId: string): Promise<DocumentRecord[]> {
    return this.db.tx(user, async (tx) => {
      const rows = await tx.many<Record<string, unknown>>(
        `${SELECT} WHERE d.entity_type = $1::document_entity_type AND d.entity_id = $2
         ORDER BY d.uploaded_at DESC`,
        [entityType, entityId],
      );
      return Promise.all(rows.map((r) => this.withUrl(row(r))));
    });
  }

  async upload(
    user: AuthUser,
    file: DocumentFile,
    input: { entityType: DocumentEntityType; entityId: string; category: DocumentCategory; title: string; visibility?: DocumentVisibility; replacesId?: string },
  ): Promise<DocumentRecord> {
    const table = ENTITY_TABLES[input.entityType];
    if (!table) throw new BadRequestException(`Unknown entity type "${input.entityType}"`);

    const ext = extensionOf(file.originalname);
    const allowedExt = ALLOWED_TYPES[file.mimetype];
    if (!allowedExt) throw new BadRequestException(`Unsupported file type: ${file.mimetype}`);
    if (!allowedExt.includes(ext)) {
      throw new BadRequestException(`File extension "${ext}" does not match content type ${file.mimetype}`);
    }

    const entity = await this.db.tx(user, (tx) =>
      tx.one<{ branch_id: string }>(`SELECT branch_id FROM ${table} WHERE id = $1`, [input.entityId]),
    );
    if (!entity) throw new NotFoundException(`${input.entityType} not found`);

    let version = 1;
    if (input.replacesId) {
      const previous = await this.db.tx(user, (tx) =>
        tx.one<{ version: number; branch_id: string }>('SELECT version, branch_id FROM documents WHERE id = $1', [input.replacesId]),
      );
      if (!previous) throw new NotFoundException('Document being replaced not found');
      version = previous.version + 1;
    }

    const key = `documents/${input.entityType}/${input.entityId}/${Date.now()}-${safeName(file.originalname)}`;
    await this.storage.put(key, file.buffer, file.mimetype, { 'uploaded-by': user.id });

    return this.db.tx(user, async (tx) => {
      const inserted = await tx.one<{ id: string }>(
        `INSERT INTO documents (branch_id, entity_type, entity_id, category, title, filename, mime_type,
                                 size_bytes, storage_key, version, replaces_id, visibility, uploaded_by)
         VALUES ($1, $2::document_entity_type, $3, $4::document_category, $5, $6, $7, $8, $9, $10, $11, $12::document_visibility, $13)
         RETURNING id::text`,
        [
          entity.branch_id, input.entityType, input.entityId, input.category, input.title.slice(0, 200),
          file.originalname.slice(0, 200), file.mimetype, file.size, key, version,
          input.replacesId ?? null, input.visibility ?? 'internal', user.id,
        ],
      );

      await this.audit.record(tx, user, {
        action: 'document.upload',
        entityType: input.entityType,
        entityId: input.entityId,
        entityLabel: input.title,
        branchId: entity.branch_id,
        after: { documentId: inserted!.id, category: input.category, filename: file.originalname },
      });

      return this.load(tx, inserted!.id);
    }).then((r) => this.withUrl(r));
  }

  /**
   * Registers an already-issued report/certificate in the same registry without copying its
   * PDF — called by `ReportDocumentsService` right after it stores the file, so a report shows
   * up in a job's or client's document list alongside everything else uploaded about it.
   */
  async reference(
    tx: Tx,
    user: AuthUser,
    input: { entityType: DocumentEntityType; entityId: string; branchId: string; title: string; filename: string; reportVersionId: string },
  ): Promise<void> {
    await tx.exec(
      `INSERT INTO documents (branch_id, entity_type, entity_id, category, title, filename, mime_type,
                               size_bytes, report_version_id, uploaded_by)
       VALUES ($1, $2::document_entity_type, $3, 'certificate'::document_category, $4, $5, 'application/pdf', 1, $6, $7)`,
      [input.branchId, input.entityType, input.entityId, input.title, input.filename, input.reportVersionId, user.id],
    );
  }

  async archive(user: AuthUser, id: string, reason?: string): Promise<void> {
    // Archiving sets archived_at, which is exactly the column app_is_live() (and therefore
    // documents_read) hides on — without this switch Postgres would refuse the UPDATE outright:
    // Row-Level Security requires the row to remain visible to the same policy after it changes,
    // the same reason every other archive endpoint in this codebase sets it (see DbService.tx).
    await this.db.tx(user, async (tx) => {
      const doc = await tx.one<{ branch_id: string; storage_key: string | null; title: string; entity_type: string; entity_id: string }>(
        'SELECT branch_id, storage_key, title, entity_type::text, entity_id::text FROM documents WHERE id = $1 AND archived_at IS NULL',
        [id],
      );
      if (!doc) throw new NotFoundException('Document not found');
      if (!user.permissions?.includes('document.archive')) throw new ForbiddenException('Requires permission: document.archive');

      await tx.exec('UPDATE documents SET archived_at = now(), archived_by = $2 WHERE id = $1', [id, user.id]);

      await this.audit.record(tx, user, {
        action: 'document.archive',
        entityType: doc.entity_type,
        entityId: doc.entity_id,
        entityLabel: doc.title,
        branchId: doc.branch_id,
        metadata: reason ? { reason } : undefined,
      });
    }, { includeArchived: true });
    // Archiving keeps the row (audit trail); the object itself can go once nothing serves it any more.
  }

  private async load(tx: Tx, id: string): Promise<DocumentRecord & { storageKey: string | null }> {
    const r = await tx.one<Record<string, unknown>>(`${SELECT} WHERE d.id = $1`, [id]);
    return row(r!);
  }

  private async withUrl(doc: DocumentRecord & { storageKey?: string | null }): Promise<DocumentRecord> {
    const { storageKey, ...rest } = doc;
    if (!storageKey) return { ...rest, downloadUrl: null };
    return { ...rest, downloadUrl: await this.storage.presignGet(storageKey, doc.filename) };
  }
}
