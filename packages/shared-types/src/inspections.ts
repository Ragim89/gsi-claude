import type { ServiceType } from './enums';
import type { Permission } from './rbac';
import type { AssignmentRole } from './job-workflow';
import type { LocalizedText, ChecklistInputKind } from './checklist-templates';

/**
 * The inspection: the field work itself, as opposed to the job it belongs to.
 *
 * One job can hold several — a loading and a discharge survey, a re-inspection after a
 * finding is fixed, different service types on one nomination — which is why the work does
 * not live in the job row.
 */

export const INSPECTION_STATUSES = [
  'draft',
  'scheduled',
  'in_progress',
  'completed',
  'under_review',
  'approved',
  'on_hold',
  'cancelled',
] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

export const INSPECTION_ACTIONS = [
  'schedule', 'start', 'complete', 'submit_review', 'return', 'approve', 'hold', 'resume', 'cancel', 'reopen',
] as const;
export type InspectionAction = (typeof INSPECTION_ACTIONS)[number];

/** Business rules checked before a move is allowed. */
export type InspectionGuard = 'hasSchedule' | 'hasLead' | 'requiredChecklistDone' | 'hasConclusion';

export interface InspectionTransition {
  action: InspectionAction;
  from: readonly InspectionStatus[];
  to: InspectionStatus;
  permission: Permission;
  requiresReason?: boolean;
  guards?: readonly InspectionGuard[];
}

export const INSPECTION_WORKFLOW: readonly InspectionTransition[] = [
  {
    action: 'schedule',
    from: ['draft'],
    to: 'scheduled',
    permission: 'inspection.update',
    guards: ['hasSchedule'],
  },
  // Starting is the inspector's own act: it stamps the actual start and opens the checklist.
  { action: 'start', from: ['scheduled', 'draft'], to: 'in_progress', permission: 'inspection.start' },
  {
    action: 'complete',
    from: ['in_progress'],
    to: 'completed',
    permission: 'inspection.complete',
    guards: ['requiredChecklistDone'],
  },
  /**
   * Handing the work in is the inspector's own act, like completing it — the review
   * permission is what it takes to judge the work, not to submit it.
   */
  { action: 'submit_review', from: ['completed'], to: 'under_review', permission: 'inspection.complete' },
  {
    action: 'return',
    from: ['under_review', 'completed'],
    to: 'in_progress',
    permission: 'inspection.review',
    requiresReason: true,
  },
  { action: 'approve', from: ['under_review'], to: 'approved', permission: 'inspection.approve' },
  /**
   * An approved inspection is closed for editing. Correcting one is a deliberate act with
   * its own permission and a reason on the record — never a silent edit.
   */
  { action: 'reopen', from: ['approved'], to: 'in_progress', permission: 'inspection.approve', requiresReason: true },
  {
    action: 'hold',
    from: ['scheduled', 'in_progress', 'completed', 'under_review'],
    to: 'on_hold',
    permission: 'inspection.cancel',
    requiresReason: true,
  },
  { action: 'resume', from: ['on_hold'], to: 'in_progress', permission: 'inspection.cancel' },
  {
    action: 'cancel',
    from: ['draft', 'scheduled', 'in_progress', 'on_hold'],
    to: 'cancelled',
    permission: 'inspection.cancel',
    requiresReason: true,
  },
];

export const TERMINAL_INSPECTION_STATUSES: readonly InspectionStatus[] = ['approved', 'cancelled'];

/** Statuses in which the field data may still be entered or corrected. */
export const EDITABLE_INSPECTION_STATUSES: readonly InspectionStatus[] = ['draft', 'scheduled', 'in_progress'];

export function inspectionTransitionFor(action: InspectionAction): InspectionTransition | undefined {
  return INSPECTION_WORKFLOW.find((t) => t.action === action);
}

export function inspectionActionsFrom(status: InspectionStatus): InspectionTransition[] {
  return INSPECTION_WORKFLOW.filter((t) => t.from.includes(status));
}

/**
 * Whether one status can legally become another. `resume` is the exception the table cannot
 * express: it returns to whatever the inspection was doing before the hold, so any live
 * status is a legal target for it.
 */
export function canInspectionTransition(from: InspectionStatus, to: InspectionStatus): boolean {
  return inspectionActionsFrom(from).some((t) =>
    t.action === 'resume' ? ACTIVE_INSPECTION_STATUSES.includes(to) : t.to === to,
  );
}

/** Work that is still live: not approved, not cancelled. */
export const ACTIVE_INSPECTION_STATUSES: readonly InspectionStatus[] = [
  'draft', 'scheduled', 'in_progress', 'completed', 'under_review', 'on_hold',
];

/** Every status with the transitions leaving it, so no status is a dead end by accident. */
export const INSPECTION_TRANSITIONS: Record<InspectionStatus, InspectionTransition[]> = Object.fromEntries(
  INSPECTION_STATUSES.map((s) => [s, inspectionActionsFrom(s)]),
) as Record<InspectionStatus, InspectionTransition[]>;

export const FINDING_SEVERITIES = ['info', 'minor', 'major', 'critical'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_STATUSES = ['open', 'acknowledged', 'resolved', 'withdrawn'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const PHOTO_CATEGORIES = [
  'general', 'cargo', 'damage', 'seal', 'container', 'document', 'equipment', 'sampling', 'other',
] as const;
export type PhotoCategory = (typeof PHOTO_CATEGORIES)[number];

/** Readings the field templates already ask for; the list is open by design. */
export const MEASUREMENT_TYPES = [
  'temperature', 'moisture', 'weight', 'density', 'draft', 'dimension', 'count', 'ph', 'other',
] as const;
export type MeasurementType = (typeof MEASUREMENT_TYPES)[number];

export interface Inspection {
  id: string;
  branchId: string;
  branchCode?: string;
  jobId: string;
  jobNumber?: string;
  clientId?: string;
  clientName?: string;
  inspectionNumber: string;
  type: ServiceType;
  status: InspectionStatus;
  leadInspectorId: string | null;
  leadInspectorName?: string | null;
  assignees?: { id: string; userId: string; userName: string; role: AssignmentRole }[];
  location: string | null;
  city: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  weatherConditions: string | null;
  siteConditions: string | null;
  generalObservations: string | null;
  conclusion: string | null;
  /** Ours to read; never printed for the client. */
  internalNotes?: string | null;
  instructions: string | null;
  statusBeforeHold?: InspectionStatus | null;
  reviewedBy?: string | null;
  reviewedByName?: string | null;
  reviewedAt?: string | null;
  reviewComment?: string | null;
  version?: number;
  /** Computed: scheduled in the past while the work is still open. */
  overdue?: boolean;
  /** Progress over the checklist, so a list can show it without loading the items. */
  checklistTotal?: number;
  checklistDone?: number;
  requiredRemaining?: number;
  findingCount?: number;
  photoCount?: number;
  measurementCount?: number;
  /** What this user may do right now; only the single-inspection endpoint fills it. */
  actions?: InspectionAction[];
  createdBy?: string | null;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}

export interface InspectionFinding {
  id: string;
  inspectionId: string;
  category: string | null;
  severity: FindingSeverity;
  status: FindingStatus;
  title: string;
  description: string | null;
  recommendation: string | null;
  isInternal: boolean;
  createdBy: string | null;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InspectionMeasurement {
  id: string;
  inspectionId: string;
  measurementType: string;
  label: string | null;
  valueNumeric: number | null;
  valueText: string | null;
  unit: string | null;
  position: string | null;
  measuredAt: string;
  measuredBy: string | null;
  measuredByName?: string | null;
  metadata: Record<string, unknown> | null;
}

export interface InspectionStatusHistoryEntry {
  id: string;
  inspectionId: string;
  fromStatus: InspectionStatus | null;
  toStatus: InspectionStatus;
  changedBy: string | null;
  changedByName?: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** A checklist item as the field screen works with it. */
export interface InspectionChecklistItem {
  id: string;
  inspectionId: string | null;
  jobId: string;
  itemKey: string;
  label: LocalizedText;
  section: string | null;
  inputKind: ChecklistInputKind;
  isRequired: boolean;
  sortOrder: number;
  result: 'ok' | 'deviation' | 'na' | null;
  value: string | null;
  notes: string | null;
  updatedAt: string;
  media: { id: string; url?: string; previewUrl?: string; caption?: string | null }[];
}

/**
 * A photo taken on the inspection. Same row as the job's media attachments — a photo is
 * evidence of the job as much as of the inspection — with the category and caption the
 * field screen needs to group them.
 */
export interface InspectionPhoto {
  id: string;
  inspectionId: string | null;
  jobId: string;
  checklistItemId: string | null;
  category: PhotoCategory;
  caption: string | null;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  originalName: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  gpsAccuracyM: number | null;
  takenAt: string | null;
  createdAt: string;
  uploadedBy: string | null;
  uploadedByName?: string | null;
  /** Short-lived presigned URLs, generated per request. */
  url?: string;
  previewUrl?: string;
}

/** What the checklist endpoint returns: the items plus the progress the field screen shows. */
export interface InspectionChecklist {
  items: InspectionChecklistItem[];
  total: number;
  answered: number;
  requiredRemaining: number;
  /** False once the inspection is completed, reviewed or approved — the screen goes read-only. */
  editable: boolean;
}
