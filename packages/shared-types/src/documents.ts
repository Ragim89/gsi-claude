/**
 * PHASE 10 — General documents registry.
 *
 * Separate from `ReportDocument` (packages/shared-types/src/reports.ts): a report is a document
 * whose content this system generated and whose lifecycle it governs. A row here is a file
 * someone uploaded about an existing record — a client's signed KYC form, a photo of a
 * container seal, a scan of a customs paper. When one of these happens to *be* an issued
 * report's PDF, it references the report version instead of holding a second copy of the bytes.
 */

export const DOCUMENT_ENTITY_TYPES = [
  'client', 'job', 'inspection', 'sample', 'report', 'invoice',
] as const;
export type DocumentEntityType = (typeof DOCUMENT_ENTITY_TYPES)[number];

export const DOCUMENT_CATEGORIES = [
  'contract', 'certificate', 'correspondence', 'customs', 'identity', 'photo', 'invoice', 'other',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const DOCUMENT_VISIBILITIES = ['internal', 'client_visible'] as const;
export type DocumentVisibility = (typeof DOCUMENT_VISIBILITIES)[number];

export interface DocumentRecord {
  id: string;
  branchId: string;
  entityType: DocumentEntityType;
  entityId: string;
  category: DocumentCategory;
  title: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  version: number;
  replacesId: string | null;
  visibility: DocumentVisibility;
  /** Set only for a row that references an issued report/certificate instead of storing a copy. */
  reportVersionId: string | null;
  metadata: Record<string, unknown> | null;
  uploadedBy: string;
  uploadedByName?: string;
  uploadedAt: string;
  archivedAt: string | null;
  downloadUrl?: string | null;
}

export interface DocumentUploadInput {
  entityType: DocumentEntityType;
  entityId: string;
  category: DocumentCategory;
  title: string;
  visibility?: DocumentVisibility;
  metadata?: Record<string, unknown>;
  /** Replacing a previous version keeps the same logical document, bumping `version`. */
  replacesId?: string;
}
