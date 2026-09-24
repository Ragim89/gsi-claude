import { describe, expect, it } from 'vitest';
import {
  ACTIVE_JOB_STATUSES,
  EDITABLE_JOB_STATUSES,
  JOB_STATUSES,
  JOB_TRANSITIONS,
  JOB_WORKFLOW,
  JobStatus,
  TERMINAL_JOB_STATUSES,
  actionsFrom,
  canTransition,
  transitionFor,
} from '@gsi/shared-types';

/**
 * The job lifecycle is the one rule the whole operations module leans on: a report may only
 * be issued from a reviewed job, and a finished job must not quietly move back into the field.
 */
describe('job status machine', () => {
  it('follows the documented happy path', () => {
    const path: JobStatus[] = ['draft', 'confirmed', 'assigned', 'in_progress', 'under_review', 'approved', 'completed'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('follows the sampling and laboratory path', () => {
    expect(canTransition('in_progress', 'sampling')).toBe(true);
    expect(canTransition('sampling', 'lab')).toBe(true);
    expect(canTransition('lab', 'report_preparation')).toBe(true);
    expect(canTransition('report_preparation', 'under_review')).toBe(true);
  });

  it('lets a supervisor send work back for rework', () => {
    expect(canTransition('under_review', 'in_progress')).toBe(true);
  });

  it('treats closed and cancelled as final', () => {
    for (const status of JOB_STATUSES) {
      expect(canTransition('closed', status)).toBe(false);
      expect(canTransition('cancelled', status)).toBe(false);
    }
    expect(TERMINAL_JOB_STATUSES).toEqual(['closed', 'cancelled']);
  });

  it('refuses to skip steps', () => {
    expect(canTransition('draft', 'in_progress')).toBe(false);
    expect(canTransition('draft', 'approved')).toBe(false);
    expect(canTransition('confirmed', 'under_review')).toBe(false);
    expect(canTransition('in_progress', 'approved')).toBe(false);
    expect(canTransition('approved', 'closed')).toBe(false);
  });

  it('cannot be cancelled once it has been approved', () => {
    expect(canTransition('approved', 'cancelled')).toBe(false);
    expect(canTransition('completed', 'cancelled')).toBe(false);
    expect(canTransition('in_progress', 'cancelled')).toBe(true);
  });

  it('can be put on hold from any live stage and resumed', () => {
    const hold = transitionFor('hold')!;
    for (const status of ACTIVE_JOB_STATUSES) {
      if (status === 'draft' || status === 'on_hold') continue;
      expect(hold.from).toContain(status);
    }
    expect(transitionFor('resume')!.from).toEqual(['on_hold']);
  });

  it('insists on a reason for the moves that need explaining', () => {
    expect(transitionFor('hold')!.requiresReason).toBe(true);
    expect(transitionFor('cancel')!.requiresReason).toBe(true);
    expect(transitionFor('return')!.requiresReason).toBe(true);
    expect(transitionFor('start')!.requiresReason).toBeUndefined();
  });

  it('guards the moves that must not happen on incomplete work', () => {
    expect(transitionFor('confirm')!.guards).toContain('hasClient');
    expect(transitionFor('confirm')!.guards).toContain('hasOffice');
    expect(transitionFor('submit')!.guards).toContain('checklistComplete');
    expect(transitionFor('complete')!.guards).toContain('hasReport');
    expect(transitionFor('close')!.guards).toContain('noOpenInvoice');
  });

  it('defines transitions for every status, so no status is a dead end by accident', () => {
    for (const status of JOB_STATUSES) {
      expect(Array.isArray(JOB_TRANSITIONS[status])).toBe(true);
    }
  });

  it('offers exactly the actions that are legal from a status', () => {
    expect(actionsFrom('draft').map((t) => t.action).sort()).toEqual(['cancel', 'confirm']);
    expect(actionsFrom('under_review').map((t) => t.action).sort()).toEqual(['approve', 'hold', 'return']);
    expect(actionsFrom('closed')).toHaveLength(0);
  });

  it('names one permission per action, so nothing is allowed by accident', () => {
    for (const transition of JOB_WORKFLOW) {
      expect(transition.permission).toMatch(/^job\./);
    }
  });

  it('allows checklist edits while the work is open, and not after', () => {
    expect(EDITABLE_JOB_STATUSES).toContain('in_progress');
    expect(EDITABLE_JOB_STATUSES).toContain('under_review');
    expect(EDITABLE_JOB_STATUSES).not.toContain('approved');
    expect(EDITABLE_JOB_STATUSES).not.toContain('closed');
    expect(EDITABLE_JOB_STATUSES).not.toContain('cancelled');
  });
});
