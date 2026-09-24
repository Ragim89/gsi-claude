import { describe, expect, it } from 'vitest';
import {
  ACTIVE_TEST_STATUSES,
  LAB_TRANSITIONS,
  LAB_WORKFLOW,
  RESULT_EDITABLE_STATUSES,
  TEST_REQUEST_STATUSES,
  TERMINAL_TEST_STATUSES,
  TestRequestStatus,
  canLabTransition,
  labActionsFrom,
  labTransitionFor,
} from '@gsi/shared-types';

/**
 * The laboratory lifecycle carries the rule the whole module exists to enforce: a result is
 * entered by one person, checked by another and signed by a third, and once signed it is never
 * edited — only superseded.
 */
describe('laboratory status machine', () => {
  it('follows the documented path from request to release', () => {
    const path: TestRequestStatus[] = [
      'requested', 'assigned', 'in_progress', 'result_entered', 'under_review', 'approved', 'released',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canLabTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('refuses to skip the steps that make a result worth signing', () => {
    expect(canLabTransition('requested', 'in_progress')).toBe(false);
    expect(canLabTransition('assigned', 'result_entered')).toBe(false);
    expect(canLabTransition('in_progress', 'under_review')).toBe(false);
    expect(canLabTransition('result_entered', 'approved')).toBe(false);
    // The big one: nothing reaches a client document without passing through approval.
    expect(canLabTransition('under_review', 'released')).toBe(false);
  });

  it('separates entering, reviewing and approving into three different rights', () => {
    expect(labTransitionFor('enter')!.permission).toBe('lab.result.enter');
    expect(labTransitionFor('submit')!.permission).toBe('lab.result.submit');
    expect(labTransitionFor('review')!.permission).toBe('lab.result.review');
    expect(labTransitionFor('approve')!.permission).toBe('lab.result.approve');
    expect(labTransitionFor('release')!.permission).toBe('lab.result.release');
  });

  it('will not approve what nobody reviewed, nor what the approver ran themselves', () => {
    const approve = labTransitionFor('approve')!;
    expect(approve.guards).toContain('hasResult');
    expect(approve.guards).toContain('hasTechnicalReview');
    expect(approve.guards).toContain('notSelfApproval');
  });

  it('keeps technical review as a signature rather than a status change', () => {
    const review = labTransitionFor('review')!;
    expect(review.from).toEqual(['under_review']);
    expect(review.to).toBe('under_review');
  });

  it('treats released, rejected and cancelled as the end of the road', () => {
    expect(TERMINAL_TEST_STATUSES).toEqual(['released', 'rejected', 'cancelled']);
    for (const status of TEST_REQUEST_STATUSES) {
      expect(canLabTransition('rejected', status)).toBe(false);
      expect(canLabTransition('cancelled', status)).toBe(false);
    }
  });

  it('lets an approved or released result be amended, and nothing else', () => {
    expect(labActionsFrom('approved').map((t) => t.action).sort()).toEqual(['amend', 'release']);
    expect(labActionsFrom('released').map((t) => t.action)).toEqual(['amend']);
    expect(labTransitionFor('amend')!.requiresReason).toBe(true);
    // An amendment goes back to the bench: it is a new analysis of the same sample, not an edit.
    expect(labTransitionFor('amend')!.to).toBe('in_progress');
  });

  it('insists on a reason for every move that needs explaining', () => {
    for (const action of ['return', 'amend', 'hold', 'reject', 'cancel'] as const) {
      expect(labTransitionFor(action)!.requiresReason).toBe(true);
    }
    for (const action of ['start', 'enter', 'submit', 'approve', 'release'] as const) {
      expect(labTransitionFor(action)!.requiresReason).toBeUndefined();
    }
  });

  it('can be held from any live stage and resumed', () => {
    const hold = labTransitionFor('hold')!;
    for (const status of ACTIVE_TEST_STATUSES) {
      if (status === 'on_hold') continue;
      expect(hold.from).toContain(status);
    }
    expect(labTransitionFor('resume')!.from).toEqual(['on_hold']);
  });

  it('cannot be cancelled once somebody has started work', () => {
    expect(labTransitionFor('cancel')!.from).not.toContain('in_progress');
    expect(labTransitionFor('reject')!.from).toContain('in_progress');
  });

  it('defines transitions for every status, so no status is a dead end by accident', () => {
    for (const status of TEST_REQUEST_STATUSES) {
      expect(Array.isArray(LAB_TRANSITIONS[status])).toBe(true);
    }
    expect(LAB_TRANSITIONS.rejected).toHaveLength(0);
    expect(LAB_TRANSITIONS.cancelled).toHaveLength(0);
  });

  it('names one laboratory permission per action, so nothing is allowed by accident', () => {
    for (const transition of LAB_WORKFLOW) {
      expect(transition.permission).toMatch(/^lab\./);
    }
  });

  it('lets the analyst write only while the work is on the bench', () => {
    expect(RESULT_EDITABLE_STATUSES).toEqual(['in_progress', 'result_entered']);
    expect(RESULT_EDITABLE_STATUSES).not.toContain('under_review');
    expect(RESULT_EDITABLE_STATUSES).not.toContain('approved');
    expect(RESULT_EDITABLE_STATUSES).not.toContain('released');
  });

  it('offers exactly the actions that are legal from a status', () => {
    expect(labActionsFrom('requested').map((t) => t.action).sort()).toEqual(['assign', 'cancel', 'hold', 'reject']);
    expect(labActionsFrom('under_review').map((t) => t.action).sort()).toEqual(
      ['approve', 'hold', 'return', 'review'],
    );
    expect(labActionsFrom('rejected')).toHaveLength(0);
  });
});
