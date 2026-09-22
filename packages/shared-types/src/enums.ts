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

export const JOB_STATUSES = [
  'new',
  'assigned',
  'in_progress',
  'under_review',
  'approved',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Job lifecycle (docs/01-architecture.md, module 2):
 * Заявка → назначение инспектора → чек-лист + фото → проверка супервайзером → утверждённый отчёт (PDF).
 */
export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  new: ['assigned', 'cancelled'],
  assigned: ['in_progress', 'cancelled'],
  in_progress: ['under_review', 'cancelled'],
  under_review: ['in_progress', 'approved'],
  approved: [],
  cancelled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

/** Statuses in which checklist items and media may still be changed. */
export const EDITABLE_JOB_STATUSES: readonly JobStatus[] = ['assigned', 'in_progress', 'under_review'];

export const CHECKLIST_RESULTS = ['ok', 'deviation', 'na'] as const;
export type ChecklistResult = (typeof CHECKLIST_RESULTS)[number];

export const MEDIA_TYPES = ['photo', 'video'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const REPORT_STATUSES = ['draft', 'issued', 'revoked'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
