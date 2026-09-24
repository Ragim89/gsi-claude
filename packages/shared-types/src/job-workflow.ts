import type { JobStatus } from './enums';
import type { Permission } from './rbac';

/**
 * The job lifecycle, in one place.
 *
 * Every status change in the system goes through this table — there is no endpoint that
 * simply writes a status. The shape is deliberately data, not code: adding the laboratory
 * stages in Phase 6 means adding rows here, not editing branching logic in a service.
 */

export const JOB_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type JobPriority = (typeof JOB_PRIORITIES)[number];

export const JOB_OBJECT_KINDS = [
  'vessel', 'warehouse', 'terminal', 'truck', 'rail', 'container', 'other',
] as const;
export type JobObjectKind = (typeof JOB_OBJECT_KINDS)[number];

export const ASSIGNMENT_ROLES = [
  'lead_inspector', 'inspector', 'sampler', 'lab_coordinator', 'report_reviewer', 'operations_coordinator',
] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

/** What a person does to a job, as opposed to the status the job ends up in. */
export const JOB_ACTIONS = [
  'confirm', 'assign', 'start', 'sample', 'send_to_lab', 'prepare_report', 'submit',
  'return', 'approve', 'complete', 'invoice', 'close', 'hold', 'resume', 'cancel',
] as const;
export type JobAction = (typeof JOB_ACTIONS)[number];

export interface JobTransition {
  action: JobAction;
  /** Statuses this action may be taken from. */
  from: readonly JobStatus[];
  to: JobStatus;
  permission: Permission;
  /** A reason is recorded on the history entry and is mandatory for these actions. */
  requiresReason?: boolean;
  /** Checks that run against the job before the change is allowed. */
  guards?: readonly JobGuard[];
}

/**
 * Business rules, named so a refusal can explain itself:
 * "Job cannot be confirmed because the responsible office is missing."
 */
export type JobGuard =
  | 'hasClient'
  | 'hasOffice'
  | 'hasServiceType'
  | 'hasRequestedDate'
  | 'hasAssignee'
  | 'checklistComplete'
  | 'hasReport'
  | 'noOpenInvoice';

export const JOB_WORKFLOW: readonly JobTransition[] = [
  {
    action: 'confirm',
    from: ['draft'],
    to: 'confirmed',
    permission: 'job.change_status',
    guards: ['hasClient', 'hasOffice', 'hasServiceType', 'hasRequestedDate'],
  },
  // Assigning is what moves a confirmed job forward; the assignment endpoint performs it.
  { action: 'assign', from: ['confirmed', 'assigned'], to: 'assigned', permission: 'job.assign', guards: ['hasAssignee'] },
  { action: 'start', from: ['assigned'], to: 'in_progress', permission: 'job.start' },
  { action: 'sample', from: ['in_progress'], to: 'sampling', permission: 'job.change_status' },
  { action: 'send_to_lab', from: ['sampling'], to: 'lab', permission: 'job.change_status' },
  {
    action: 'prepare_report',
    from: ['in_progress', 'sampling', 'lab'],
    to: 'report_preparation',
    permission: 'job.change_status',
  },
  // Submitting the field checklist is what "under review" has always meant here.
  {
    action: 'submit',
    from: ['in_progress', 'sampling', 'lab', 'report_preparation'],
    to: 'under_review',
    permission: 'job.submit',
    guards: ['checklistComplete'],
  },
  { action: 'return', from: ['under_review'], to: 'in_progress', permission: 'job.cancel', requiresReason: true },
  { action: 'approve', from: ['under_review'], to: 'approved', permission: 'job.approve' },
  { action: 'complete', from: ['approved'], to: 'completed', permission: 'job.change_status', guards: ['hasReport'] },
  { action: 'invoice', from: ['completed'], to: 'invoiced', permission: 'job.change_status' },
  { action: 'close', from: ['completed', 'invoiced'], to: 'closed', permission: 'job.close', guards: ['noOpenInvoice'] },
  {
    action: 'hold',
    from: ['confirmed', 'assigned', 'in_progress', 'sampling', 'lab', 'report_preparation', 'under_review'],
    to: 'on_hold',
    permission: 'job.change_status',
    requiresReason: true,
  },
  // Resuming returns the job to whatever it was doing before; the target is read from the row.
  { action: 'resume', from: ['on_hold'], to: 'confirmed', permission: 'job.change_status' },
  {
    action: 'cancel',
    from: ['draft', 'confirmed', 'assigned', 'in_progress', 'sampling', 'lab', 'report_preparation', 'on_hold'],
    to: 'cancelled',
    permission: 'job.cancel',
    requiresReason: true,
  },
];

/** Statuses a job never leaves on its own. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['closed', 'cancelled'];

/** Statuses that mean the work is still live — what "active" means on a list screen. */
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = [
  'draft', 'confirmed', 'assigned', 'in_progress', 'sampling', 'lab', 'report_preparation', 'under_review', 'on_hold',
];

export function transitionFor(action: JobAction): JobTransition | undefined {
  return JOB_WORKFLOW.find((t) => t.action === action);
}

/** The actions available from a status — what the interface offers as buttons. */
export function actionsFrom(status: JobStatus): JobTransition[] {
  return JOB_WORKFLOW.filter((t) => t.from.includes(status));
}

export function canTransitionTo(from: JobStatus, to: JobStatus): boolean {
  return JOB_WORKFLOW.some((t) => t.from.includes(from) && t.to === to);
}

export interface JobStatusHistoryEntry {
  id: string;
  jobId: string;
  fromStatus: JobStatus | null;
  toStatus: JobStatus;
  changedBy: string | null;
  changedByName?: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface JobAssignment {
  id: string;
  jobId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  role: AssignmentRole;
  assignedBy: string | null;
  assignedByName?: string | null;
  assignedAt: string;
  removedAt: string | null;
  note: string | null;
}
