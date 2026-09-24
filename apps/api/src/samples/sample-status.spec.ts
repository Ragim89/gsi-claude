import { describe, expect, it } from 'vitest';
import {
  ACTIVE_SAMPLE_STATUSES,
  DETAIL_EDITABLE_STATUSES,
  IDENTITY_EDITABLE_STATUSES,
  SAMPLE_IDENTITY_FIELDS,
  SAMPLE_STATUSES,
  SAMPLE_TRANSITIONS,
  SAMPLE_WORKFLOW,
  SampleStatus,
  TERMINAL_SAMPLE_STATUSES,
  canSampleTransition,
  sampleActionsFrom,
  sampleTransitionFor,
} from '@gsi/shared-types';

/**
 * The custody chain is only as trustworthy as the rule that a sample cannot skip a step. A
 * sample that arrives at a laboratory without having been sealed, or whose commodity changed
 * after registration, makes every document downstream of it a guess.
 */
describe('sample status machine', () => {
  it('follows the documented path from the quay to the laboratory bench', () => {
    const path: SampleStatus[] = [
      'draft', 'collected', 'registered', 'sealed', 'dispatched', 'received_by_lab', 'accepted_by_lab',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canSampleTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('refuses to skip the steps that make the chain worth keeping', () => {
    expect(canSampleTransition('draft', 'registered')).toBe(false);
    expect(canSampleTransition('collected', 'sealed')).toBe(false);
    // Dispatching an unsealed sample is exactly the gap a chain of custody exists to close.
    expect(canSampleTransition('registered', 'dispatched')).toBe(false);
    expect(canSampleTransition('sealed', 'received_by_lab')).toBe(false);
    expect(canSampleTransition('dispatched', 'accepted_by_lab')).toBe(false);
  });

  it('lets a laboratory accept or reject what it received, and nothing else', () => {
    expect(sampleActionsFrom('received_by_lab').map((t) => t.action).sort()).toEqual(['accept', 'reject']);
    expect(sampleTransitionFor('reject')!.requiresReason).toBe(true);
    expect(sampleTransitionFor('reject')!.guards).toContain('hasRejectionReason');
  });

  it('sends a rejected sample back to the office rather than into a dead end', () => {
    expect(canSampleTransition('rejected_by_lab', 'registered')).toBe(true);
    expect(sampleTransitionFor('return')!.requiresReason).toBe(true);
  });

  it('treats acceptance and cancellation as final', () => {
    for (const status of SAMPLE_STATUSES) {
      expect(canSampleTransition('accepted_by_lab', status)).toBe(false);
      expect(canSampleTransition('cancelled', status)).toBe(false);
    }
    expect(TERMINAL_SAMPLE_STATUSES).toEqual(['accepted_by_lab', 'cancelled']);
  });

  it('cannot be cancelled once it has left our hands', () => {
    expect(canSampleTransition('dispatched', 'cancelled')).toBe(false);
    expect(canSampleTransition('received_by_lab', 'cancelled')).toBe(false);
    expect(canSampleTransition('sealed', 'cancelled')).toBe(true);
  });

  it('guards each move on what that move needs', () => {
    expect(sampleTransitionFor('collect')!.guards).toContain('hasSampler');
    expect(sampleTransitionFor('register')!.guards).toContain('hasIdentity');
    expect(sampleTransitionFor('seal')!.guards).toContain('hasSeal');
    expect(sampleTransitionFor('dispatch')!.guards).toContain('hasDestination');
  });

  it('insists on a reason for the moves that need explaining', () => {
    expect(sampleTransitionFor('hold')!.requiresReason).toBe(true);
    expect(sampleTransitionFor('cancel')!.requiresReason).toBe(true);
    expect(sampleTransitionFor('seal')!.requiresReason).toBeUndefined();
    expect(sampleTransitionFor('accept')!.requiresReason).toBeUndefined();
  });

  it('can be held from any stage where we still hold it, and resumed', () => {
    const hold = sampleTransitionFor('hold')!;
    for (const status of ACTIVE_SAMPLE_STATUSES) {
      if (['draft', 'on_hold', 'received_by_lab', 'rejected_by_lab'].includes(status)) continue;
      expect(hold.from).toContain(status);
    }
    expect(sampleTransitionFor('resume')!.from).toEqual(['on_hold']);
  });

  it('defines transitions for every status, so no status is a dead end by accident', () => {
    for (const status of SAMPLE_STATUSES) {
      expect(Array.isArray(SAMPLE_TRANSITIONS[status])).toBe(true);
    }
    expect(SAMPLE_TRANSITIONS.accepted_by_lab).toHaveLength(0);
    expect(SAMPLE_TRANSITIONS.cancelled).toHaveLength(0);
  });

  it('names one sample permission per action, so nothing is allowed by accident', () => {
    for (const transition of SAMPLE_WORKFLOW) {
      expect(transition.permission).toMatch(/^sample\./);
    }
  });

  it('separates the laboratory decision from the office that sent the sample', () => {
    expect(sampleTransitionFor('receive')!.permission).toBe('sample.receive');
    expect(sampleTransitionFor('accept')!.permission).toBe('sample.accept_lab');
    expect(sampleTransitionFor('reject')!.permission).toBe('sample.reject_lab');
    expect(sampleTransitionFor('dispatch')!.permission).toBe('sample.dispatch');
  });

  it('freezes what the sample is at registration, and only then', () => {
    expect(IDENTITY_EDITABLE_STATUSES).toEqual(['draft', 'collected']);
    expect(IDENTITY_EDITABLE_STATUSES).not.toContain('registered');
    // The seal, the label and the laboratory's paperwork all describe these.
    expect(SAMPLE_IDENTITY_FIELDS).toContain('commodity');
    expect(SAMPLE_IDENTITY_FIELDS).toContain('quantity');
    expect(SAMPLE_IDENTITY_FIELDS).toContain('sampledAt');
  });

  it('keeps notes open longer than identity, and closes both once it is dispatched', () => {
    expect(DETAIL_EDITABLE_STATUSES).toContain('registered');
    expect(DETAIL_EDITABLE_STATUSES).toContain('sealed');
    expect(DETAIL_EDITABLE_STATUSES).not.toContain('dispatched');
    expect(DETAIL_EDITABLE_STATUSES).not.toContain('accepted_by_lab');
  });
});
