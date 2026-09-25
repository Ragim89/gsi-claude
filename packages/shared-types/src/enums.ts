// Values here mirror the PostgreSQL enum types in apps/api/migrations/001_init.sql.
// Keep them in sync when adding a value.

/** All roles from docs/01-architecture.md. MVP-1 implements inspector / supervisor / admin. */
export const ROLES = [
  'inspector',
  'lab_technician',
  'supervisor',
  'finance_controller',
  'cfo',
  'client',
  'admin',
] as const;
export type Role = (typeof ROLES)[number];

/**
 * Roles that see data of every branch (HQ). Must match app_is_hq() in the DB.
 * ASSUMPTION: "HQ видит всё" applies to the system admin and CFO roles; a branch supervisor in
 * Istanbul is still scoped to the Türkiye branch like any other branch.
 */
export const HQ_ROLES: readonly Role[] = ['admin', 'cfo'];

export const SERVICE_TYPES = [
  'weight_supervision',
  'quality_supervision',
  'sampling',
  'loading_discharge',
  'cleanliness',
  'fumigation',
] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

/**
 * The job lifecycle (docs/WORKFLOWS.md). `under_review` is the review stage — the name
 * predates the rest of the vocabulary and reads better than "review" on screen, so it stayed.
 * The value `new` was renamed to `confirmed` in migration 012.
 */
export const JOB_STATUSES = [
  'draft',
  'confirmed',
  'assigned',
  'in_progress',
  'sampling',
  'lab',
  'report_preparation',
  'under_review',
  'approved',
  'completed',
  'invoiced',
  'closed',
  'on_hold',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Which statuses may follow which. Derived from the workflow table in `job-workflow.ts`,
 * which is the single definition — this shape is kept for the checks that only need to ask
 * "is this move legal at all".
 */
export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['assigned', 'on_hold', 'cancelled'],
  assigned: ['assigned', 'in_progress', 'on_hold', 'cancelled'],
  in_progress: ['sampling', 'report_preparation', 'under_review', 'on_hold', 'cancelled'],
  sampling: ['lab', 'report_preparation', 'under_review', 'on_hold', 'cancelled'],
  lab: ['report_preparation', 'under_review', 'on_hold', 'cancelled'],
  report_preparation: ['under_review', 'on_hold', 'cancelled'],
  under_review: ['in_progress', 'approved', 'on_hold'],
  approved: ['completed'],
  completed: ['invoiced', 'closed'],
  invoiced: ['closed'],
  // Resuming returns the job to the status it was in before the hold.
  on_hold: ['confirmed', 'assigned', 'in_progress', 'sampling', 'lab', 'report_preparation', 'under_review', 'cancelled'],
  closed: [],
  cancelled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

/** Statuses in which checklist items and media may still be changed. */
export const EDITABLE_JOB_STATUSES: readonly JobStatus[] = [
  'assigned',
  'in_progress',
  'sampling',
  'lab',
  'report_preparation',
  'under_review',
];

export const CHECKLIST_RESULTS = ['ok', 'deviation', 'na'] as const;
export type ChecklistResult = (typeof CHECKLIST_RESULTS)[number];

export const MEDIA_TYPES = ['photo', 'video'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/**
 * A document's life. `revoked` is kept because rows carry it: it predates the document
 * workflow and means what `cancelled` now means, and renaming a value nobody benefits from
 * renaming would only break the queries that already read it.
 */
export const REPORT_STATUSES = [
  'draft',
  'under_review',
  'changes_requested',
  'approved',
  'issued',
  'superseded',
  'cancelled',
  'revoked',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
