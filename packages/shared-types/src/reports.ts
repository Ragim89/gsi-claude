import type { Permission } from './rbac';
import type { ReportStatus } from './enums';
import type { LocalizedText } from './checklist-templates';
import type { SpecEvaluation } from './laboratory';

/**
 * Reports and certificates: the documents that leave the building.
 *
 * Two ideas carry this file. First, an issued document is frozen — not by convention but by
 * having stopped reading the database: what it says was copied into it when it was issued, so
 * editing a method or a client next year cannot change a certificate signed this year.
 * Second, a document is never corrected in place; a revision is a new document with the same
 * number, and the one that was sent to the client stays exactly as it was sent.
 */

export const REPORT_TYPES = [
  'inspection_report',
  'survey_report',
  'laboratory_report',
  'certificate_of_analysis',
  'certificate',
  'sampling_report',
  'custom',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** Types whose numbers come from the certificate sequence rather than the report one. */
export const CERTIFICATE_TYPES: readonly ReportType[] = ['certificate_of_analysis', 'certificate'];

export const REPORT_ACTIONS = [
  'submit',
  'review',
  'request_changes',
  'approve',
  'issue',
  'revise',
  'cancel',
] as const;
export type ReportAction = (typeof REPORT_ACTIONS)[number];

export type ReportGuard =
  | 'hasContent'
  | 'hasTemplate'
  | 'notSelfApproval'
  | 'reviewed';

export interface ReportTransition {
  action: ReportAction;
  from: readonly ReportStatus[];
  to: ReportStatus;
  permission: Permission;
  requiresReason?: boolean;
  guards?: readonly ReportGuard[];
}

export const REPORT_WORKFLOW: readonly ReportTransition[] = [
  /** Handing the draft in. From here the author stops writing. */
  {
    action: 'submit',
    from: ['draft', 'changes_requested'],
    to: 'under_review',
    permission: 'report.submit_review',
    guards: ['hasContent', 'hasTemplate'],
  },
  /**
   * Review is a signature, not a status change — the same shape as the laboratory's technical
   * review. Without it the approval below refuses to happen.
   */
  {
    action: 'review',
    from: ['under_review'],
    to: 'under_review',
    permission: 'report.review',
  },
  {
    action: 'request_changes',
    from: ['under_review'],
    to: 'changes_requested',
    permission: 'report.review',
    requiresReason: true,
  },
  {
    action: 'approve',
    from: ['under_review'],
    to: 'approved',
    permission: 'report.approve',
    guards: ['reviewed', 'notSelfApproval'],
  },
  /**
   * Approved says the document is right. Issued says it may carry a client's name out of the
   * building — and that is when the PDF is rendered, hashed, stored and made verifiable.
   */
  { action: 'issue', from: ['approved'], to: 'issued', permission: 'report.issue' },
  /** The only way to change an issued document: a new revision, with the reason on the record. */
  {
    action: 'revise',
    from: ['issued'],
    to: 'draft',
    permission: 'report.revise',
    requiresReason: true,
  },
  {
    action: 'cancel',
    from: ['draft', 'changes_requested', 'under_review', 'approved', 'issued'],
    to: 'cancelled',
    permission: 'report.cancel',
    requiresReason: true,
  },
];

export function reportTransitionFor(action: ReportAction): ReportTransition | undefined {
  return REPORT_WORKFLOW.find((t) => t.action === action);
}

export function reportActionsFrom(status: ReportStatus): ReportTransition[] {
  return REPORT_WORKFLOW.filter((t) => t.from.includes(status));
}

export function canReportTransition(from: ReportStatus, to: ReportStatus): boolean {
  return reportActionsFrom(from).some((t) => t.to === to);
}

export const REPORT_TRANSITIONS: Record<ReportStatus, ReportTransition[]> = Object.fromEntries(
  (['draft', 'under_review', 'changes_requested', 'approved', 'issued', 'superseded', 'cancelled', 'revoked'] as const)
    .map((s) => [s, reportActionsFrom(s)]),
) as Record<ReportStatus, ReportTransition[]>;

/** Statuses in which the author may still write. */
export const REPORT_EDITABLE_STATUSES: readonly ReportStatus[] = ['draft', 'changes_requested'];

/** Nothing further happens without a deliberate revision. */
export const REPORT_FINAL_STATUSES: readonly ReportStatus[] = ['issued', 'superseded', 'cancelled', 'revoked'];

// ---- Templates ------------------------------------------------------------------------------

/**
 * The sections a template can put on a page. A document type is a choice of sections and their
 * options, which is why adding one does not mean writing another screen.
 */
export const REPORT_SECTIONS = [
  'header',
  'client',
  'job',
  'inspection',
  'samples',
  'lab_results',
  'checklist',
  'findings',
  'measurements',
  'observations',
  'photos',
  'conclusion',
  'signatures',
  'footer',
  'qr',
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export interface ReportSectionSpec {
  section: ReportSection;
  /** Heading override; the template's own wording wins over the default for the section. */
  title?: LocalizedText;
  /** Section-specific switches — `showGps`, `showSpecification`, `showMethod`, and so on. */
  options?: Record<string, unknown>;
}

export interface ReportTemplateDefinition {
  sections: ReportSectionSpec[];
  /** Printed under the signatures: the statement of limitation this document carries. */
  statement?: LocalizedText;
}

export interface ReportTemplate {
  id: string;
  code: string;
  name: string;
  reportType: ReportType;
  branchId: string | null;
  branchCode?: string | null;
  language: string | null;
  version: number;
  isActive: boolean;
  definition: ReportTemplateDefinition;
  description: string | null;
  effectiveFrom: string;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---- What a person writes -------------------------------------------------------------------

/**
 * The authored part of a document. Everything else on the page is a fact the system already
 * holds; these are the paragraphs a surveyor actually writes, plus which evidence to print.
 */
export interface ReportContent {
  executiveSummary?: string | null;
  observations?: string | null;
  conclusions?: string | null;
  recommendations?: string | null;
  /** Ids of `media_attachments` rows, in the order they should be printed. */
  photoIds?: string[];
  /** Which inspections, samples and analyses this document covers; empty means all of the job's. */
  inspectionIds?: string[];
  sampleIds?: string[];
  testRequestIds?: string[];
  /** Free-form per-section switches the template reads. */
  options?: Record<string, unknown>;
}

// ---- What the system freezes ------------------------------------------------------------------

export interface ReportSnapshotPhoto {
  id: string;
  caption: string | null;
  category: string | null;
  takenAt: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  /** Storage key, so the same image can be printed again years later. */
  storageKey: string;
  mimeType: string;
}

export interface ReportSnapshotResult {
  testRequestId: string;
  resultId: string;
  revision: number;
  sampleNumber: string;
  testCode: string;
  testName: LocalizedText;
  methodCode: string;
  methodName: string;
  methodVersion: number;
  standardReference: string | null;
  /** Exactly as the analyst typed it — 12.40 stays 12.40. */
  value: string;
  unit: string | null;
  specification: string | null;
  evaluation: SpecEvaluation;
  analystName: string | null;
  approvedByName: string | null;
  releasedAt: string;
}

/**
 * The facts as they were when the document was issued. Nothing here is read back from the
 * live tables when the PDF is reprinted — that is the whole point of it existing.
 */
export interface ReportDataSnapshot {
  takenAt: string;
  branch: {
    code: string;
    legalName: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    accreditation: string | null;
    country: string;
    timezone: string;
  };
  client: {
    id: string;
    name: string;
    address: string | null;
    country: string | null;
    gaftaFosfaRef: string | null;
  };
  job: {
    id: string;
    jobNumber: string;
    type: string;
    location: string | null;
    city: string | null;
    vesselOrObject: string | null;
    commodity: string | null;
    quantity: string | null;
    clientReference: string | null;
    requestedDate: string | null;
    scheduledAt: string | null;
  };
  inspections: Array<{
    id: string;
    inspectionNumber: string;
    type: string;
    status: string;
    actualStart: string | null;
    actualEnd: string | null;
    weatherConditions: string | null;
    siteConditions: string | null;
    generalObservations: string | null;
    conclusion: string | null;
    inspectors: string[];
    checklist: Array<{ label: LocalizedText; result: string | null; value: string | null; notes: string | null }>;
    findings: Array<{ severity: string; title: string; description: string | null; recommendation: string | null }>;
    measurements: Array<{ type: string; value: string; unit: string | null; location: string | null }>;
  }>;
  samples: Array<{
    id: string;
    sampleNumber: string;
    sampleType: string;
    samplingMethod: string;
    commodity: string | null;
    quantity: string | null;
    unit: string | null;
    sealNumber: string | null;
    sampledAt: string | null;
    sampledByName: string | null;
    location: string | null;
    laboratoryName: string | null;
    custodySummary: Array<{ event: string; at: string; by: string | null }>;
  }>;
  results: ReportSnapshotResult[];
  photos: ReportSnapshotPhoto[];
  /** Who signed what, at the moment of issue. */
  approvals: {
    preparedByName: string | null;
    reviewedByName: string | null;
    approvedByName: string | null;
    issuedByName: string | null;
    approvedAt: string | null;
    issuedAt: string | null;
  };
}

// ---- The document -----------------------------------------------------------------------------

export interface ReportVersion {
  id: string;
  reportId: string;
  versionNumber: number;
  status: ReportStatus;
  content: ReportContent;
  dataSnapshot: ReportDataSnapshot | null;
  language: string;
  templateId: string | null;
  templateCode: string | null;
  templateVersion: number | null;
  pdfStorageKey: string | null;
  pdfSha256: string | null;
  pdfBytes: number | null;
  preparedBy: string | null;
  preparedByName?: string | null;
  preparedAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedByName?: string | null;
  reviewedAt: string | null;
  reviewComment: string | null;
  approvedBy: string | null;
  approvedByName?: string | null;
  approvedAt: string | null;
  issuedBy: string | null;
  issuedByName?: string | null;
  issuedAt: string | null;
  revisionReason: string | null;
  /** The verification code printed on this revision, once it has been issued. */
  qrToken: string | null;
  /** Issued before this module existed: number, PDF and QR are real, the rest was never recorded. */
  isLegacy: boolean;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReportDocument {
  id: string;
  branchId: string;
  branchCode?: string;
  reportNumber: string;
  reportType: ReportType;
  title: string | null;
  status: ReportStatus;
  /** The current revision number. Revision 1 is the first issue. */
  version: number;
  language: string;
  jobId: string;
  jobNumber?: string;
  clientId: string | null;
  clientName?: string | null;
  inspectionId: string | null;
  inspectionNumber?: string | null;
  sampleId: string | null;
  sampleNumber?: string | null;
  templateId: string | null;
  templateCode?: string | null;
  templateName?: string | null;
  preparedBy: string | null;
  preparedByName?: string | null;
  preparedAt: string | null;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedByName?: string | null;
  reviewedAt: string | null;
  approvedBy: string | null;
  approvedByName?: string | null;
  approvedAt: string | null;
  issuedBy: string | null;
  issuedByName?: string | null;
  issuedAt: string | null;
  cancelReason: string | null;
  verificationToken: string;
  pdfSha256: string | null;
  /** The revision being written, when one is. */
  currentVersion?: ReportVersion | null;
  versionCount?: number;
  /** What this user may do right now; only the single-document endpoint fills it. */
  actions?: ReportAction[];
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface ReportHistoryEntry {
  id: string;
  reportId: string;
  versionNumber: number | null;
  fromStatus: ReportStatus | null;
  toStatus: ReportStatus;
  changedBy: string | null;
  changedByName?: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * What the public QR check answers. Deliberately thin: whoever holds the document already
 * knows whose it is, and whoever merely found the code should not learn it here.
 */
export interface DocumentVerification {
  valid: boolean;
  reportNumber?: string;
  reportType?: ReportType;
  documentTitle?: string | null;
  status?: ReportStatus;
  version?: number;
  issuedAt?: string | null;
  issuer?: string | null;
  branchCode?: string | null;
  checksum?: string | null;
  language?: string | null;
  /** Set when this document has been replaced by a later revision. */
  supersededBy?: string | null;
  cancelledReason?: string | null;
}

/** What the builder needs to offer: the material a document of this type can be made from. */
export interface ReportSources {
  jobId: string;
  jobNumber: string;
  clientName: string;
  inspections: Array<{ id: string; inspectionNumber: string; type: string; status: string; actualStart: string | null }>;
  samples: Array<{ id: string; sampleNumber: string; commodity: string | null; sealNumber: string | null }>;
  results: ReportSnapshotResult[];
  photos: ReportSnapshotPhoto[];
}
