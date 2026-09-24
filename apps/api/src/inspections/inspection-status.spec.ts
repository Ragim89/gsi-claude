import { describe, expect, it } from 'vitest';
import {
  ACTIVE_INSPECTION_STATUSES,
  EDITABLE_INSPECTION_STATUSES,
  INSPECTION_STATUSES,
  INSPECTION_TRANSITIONS,
  INSPECTION_WORKFLOW,
  InspectionStatus,
  TERMINAL_INSPECTION_STATUSES,
  canInspectionTransition,
  inspectionActionsFrom,
  inspectionTransitionFor,
} from '@gsi/shared-types';

/**
 * The inspection lifecycle carries the evidence rule the whole module rests on: work that has
 * been approved cannot be quietly edited, and an inspection cannot be declared complete while
 * the questions it was sent to answer are still blank.
 */
describe('inspection status machine', () => {
  it('follows the documented happy path', () => {
    const path: InspectionStatus[] = ['draft', 'scheduled', 'in_progress', 'completed', 'under_review', 'approved'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canInspectionTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('lets an inspection start straight from a draft, without being scheduled first', () => {
    expect(canInspectionTransition('draft', 'in_progress')).toBe(true);
  });

  it('sends work back for rework from review and from completed', () => {
    expect(canInspectionTransition('under_review', 'in_progress')).toBe(true);
    expect(canInspectionTransition('completed', 'in_progress')).toBe(true);
  });

  it('refuses to skip steps', () => {
    expect(canInspectionTransition('draft', 'approved')).toBe(false);
    expect(canInspectionTransition('scheduled', 'completed')).toBe(false);
    expect(canInspectionTransition('in_progress', 'under_review')).toBe(false);
    expect(canInspectionTransition('in_progress', 'approved')).toBe(false);
  });

  it('treats cancelled as final, and approved as changeable only by reopening', () => {
    for (const status of INSPECTION_STATUSES) {
      expect(canInspectionTransition('cancelled', status)).toBe(false);
    }
    expect(TERMINAL_INSPECTION_STATUSES).toEqual(['approved', 'cancelled']);
    // The one way out of approved, and it costs a permission and a written reason.
    expect(inspectionActionsFrom('approved').map((t) => t.action)).toEqual(['reopen']);
    expect(inspectionTransitionFor('reopen')!.requiresReason).toBe(true);
    expect(inspectionTransitionFor('reopen')!.permission).toBe('inspection.approve');
  });

  it('cannot be cancelled once the field work is done', () => {
    expect(canInspectionTransition('completed', 'cancelled')).toBe(false);
    expect(canInspectionTransition('under_review', 'cancelled')).toBe(false);
    expect(canInspectionTransition('in_progress', 'cancelled')).toBe(true);
  });

  it('can be held from any live stage and resumed', () => {
    const hold = inspectionTransitionFor('hold')!;
    for (const status of ACTIVE_INSPECTION_STATUSES) {
      if (status === 'draft' || status === 'on_hold') continue;
      expect(hold.from).toContain(status);
    }
    expect(inspectionTransitionFor('resume')!.from).toEqual(['on_hold']);
  });

  it('insists on a reason for the moves that need explaining', () => {
    expect(inspectionTransitionFor('hold')!.requiresReason).toBe(true);
    expect(inspectionTransitionFor('cancel')!.requiresReason).toBe(true);
    expect(inspectionTransitionFor('return')!.requiresReason).toBe(true);
    expect(inspectionTransitionFor('start')!.requiresReason).toBeUndefined();
    expect(inspectionTransitionFor('approve')!.requiresReason).toBeUndefined();
  });

  it('guards completion on the required checklist items', () => {
    expect(inspectionTransitionFor('complete')!.guards).toContain('requiredChecklistDone');
    expect(inspectionTransitionFor('schedule')!.guards).toContain('hasSchedule');
  });

  it('defines transitions for every status, so no status is a dead end by accident', () => {
    for (const status of INSPECTION_STATUSES) {
      expect(Array.isArray(INSPECTION_TRANSITIONS[status])).toBe(true);
    }
    expect(INSPECTION_TRANSITIONS.cancelled).toHaveLength(0);
  });

  it('offers exactly the actions that are legal from a status', () => {
    expect(inspectionActionsFrom('draft').map((t) => t.action).sort()).toEqual(['cancel', 'schedule', 'start']);
    expect(inspectionActionsFrom('completed').map((t) => t.action).sort()).toEqual(['hold', 'return', 'submit_review']);
    expect(inspectionActionsFrom('under_review').map((t) => t.action).sort()).toEqual(['approve', 'hold', 'return']);
    expect(inspectionActionsFrom('cancelled')).toHaveLength(0);
  });

  it('names one inspection permission per action, so nothing is allowed by accident', () => {
    for (const transition of INSPECTION_WORKFLOW) {
      expect(transition.permission).toMatch(/^inspection\./);
    }
  });

  it('allows field edits only while the work is open', () => {
    expect(EDITABLE_INSPECTION_STATUSES).toEqual(['draft', 'scheduled', 'in_progress']);
    expect(EDITABLE_INSPECTION_STATUSES).not.toContain('completed');
    expect(EDITABLE_INSPECTION_STATUSES).not.toContain('under_review');
    expect(EDITABLE_INSPECTION_STATUSES).not.toContain('approved');
  });
});
