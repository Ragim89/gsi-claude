import { describe, expect, it } from 'vitest';
import { canTransition, EDITABLE_JOB_STATUSES, JOB_STATUSES, JOB_TRANSITIONS, JobStatus } from '@gsi/shared-types';

/**
 * The job lifecycle is the one rule the whole operations module leans on: a report may only be
 * issued from a reviewed job, and a finished job must not quietly move back into the field.
 */
describe('job status machine', () => {
  it('follows the documented happy path', () => {
    const path: JobStatus[] = ['new', 'assigned', 'in_progress', 'under_review', 'approved'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('lets a supervisor send work back for rework', () => {
    expect(canTransition('under_review', 'in_progress')).toBe(true);
  });

  it('treats approved and cancelled as final', () => {
    for (const status of JOB_STATUSES) {
      expect(canTransition('approved', status)).toBe(false);
      expect(canTransition('cancelled', status)).toBe(false);
    }
  });

  it('refuses to skip steps', () => {
    expect(canTransition('new', 'in_progress')).toBe(false);
    expect(canTransition('new', 'approved')).toBe(false);
    expect(canTransition('assigned', 'under_review')).toBe(false);
    expect(canTransition('in_progress', 'approved')).toBe(false);
  });

  it('cannot be cancelled once it is under review or finished', () => {
    expect(canTransition('under_review', 'cancelled')).toBe(false);
    expect(canTransition('approved', 'cancelled')).toBe(false);
  });

  it('defines transitions for every status, so no status is a dead end by accident', () => {
    for (const status of JOB_STATUSES) {
      expect(JOB_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('allows checklist edits only while the job is still in the field or under review', () => {
    expect(EDITABLE_JOB_STATUSES).toEqual(['assigned', 'in_progress', 'under_review']);
    expect(EDITABLE_JOB_STATUSES).not.toContain('approved');
    expect(EDITABLE_JOB_STATUSES).not.toContain('cancelled');
  });
});
