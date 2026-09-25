import { describe, expect, it } from 'vitest';
import {
  REPORT_ACTIONS,
  REPORT_EDITABLE_STATUSES,
  REPORT_FINAL_STATUSES,
  REPORT_TRANSITIONS,
  REPORT_TYPES,
  REPORT_WORKFLOW,
  ReportStatus,
  canReportTransition,
  reportActionsFrom,
  reportTransitionFor,
} from '@gsi/shared-types';

/**
 * A document's lifecycle carries the rule the module exists to enforce: what leaves the
 * building was written by one person, checked by another and signed by a third, and once it
 * has left it is never edited — only superseded.
 */
describe('document status machine', () => {
  it('follows the documented path from draft to issued', () => {
    const path: ReportStatus[] = ['draft', 'under_review', 'approved', 'issued'];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canReportTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('refuses to skip the steps that make a document worth signing', () => {
    expect(canReportTransition('draft', 'approved')).toBe(false);
    expect(canReportTransition('draft', 'issued')).toBe(false);
    expect(canReportTransition('under_review', 'issued')).toBe(false);
    // The big one: nothing is issued that has not been approved.
    expect(canReportTransition('changes_requested', 'issued')).toBe(false);
  });

  it('separates writing, checking, approving and issuing into four different rights', () => {
    expect(reportTransitionFor('submit')!.permission).toBe('report.submit_review');
    expect(reportTransitionFor('review')!.permission).toBe('report.review');
    expect(reportTransitionFor('approve')!.permission).toBe('report.approve');
    expect(reportTransitionFor('issue')!.permission).toBe('report.issue');
    expect(reportTransitionFor('revise')!.permission).toBe('report.revise');
  });

  it('will not approve what nobody reviewed, nor what the approver wrote', () => {
    const approve = reportTransitionFor('approve')!;
    expect(approve.guards).toContain('reviewed');
    expect(approve.guards).toContain('notSelfApproval');
  });

  it('keeps review as a signature rather than a status change', () => {
    const review = reportTransitionFor('review')!;
    expect(review.from).toEqual(['under_review']);
    expect(review.to).toBe('under_review');
  });

  it('lets an issued document be revised or cancelled, and nothing else', () => {
    expect(reportActionsFrom('issued').map((t) => t.action).sort()).toEqual(['cancel', 'revise']);
    expect(reportTransitionFor('revise')!.requiresReason).toBe(true);
    // A revision goes back to a draft: it is a new document with the same number, not an edit.
    expect(reportTransitionFor('revise')!.to).toBe('draft');
  });

  it('treats superseded and cancelled as the end of the road', () => {
    expect(reportActionsFrom('superseded')).toHaveLength(0);
    expect(reportActionsFrom('cancelled')).toHaveLength(0);
    expect(reportActionsFrom('revoked')).toHaveLength(0);
  });

  it('insists on a reason for every move that needs explaining', () => {
    for (const action of ['request_changes', 'revise', 'cancel'] as const) {
      expect(reportTransitionFor(action)!.requiresReason).toBe(true);
    }
    for (const action of ['submit', 'review', 'approve', 'issue'] as const) {
      expect(reportTransitionFor(action)!.requiresReason).toBeUndefined();
    }
  });

  it('lets the author write only while the document is still being written', () => {
    expect(REPORT_EDITABLE_STATUSES).toEqual(['draft', 'changes_requested']);
    expect(REPORT_EDITABLE_STATUSES).not.toContain('under_review');
    expect(REPORT_EDITABLE_STATUSES).not.toContain('approved');
    expect(REPORT_EDITABLE_STATUSES).not.toContain('issued');
  });

  it('can be cancelled at any point, including after it has been issued', () => {
    const cancel = reportTransitionFor('cancel')!;
    for (const status of ['draft', 'changes_requested', 'under_review', 'approved', 'issued'] as const) {
      expect(cancel.from).toContain(status);
    }
  });

  it('takes a document that came back for changes and sends it round again', () => {
    expect(reportActionsFrom('changes_requested').map((t) => t.action).sort()).toEqual(['cancel', 'submit']);
    expect(canReportTransition('changes_requested', 'under_review')).toBe(true);
  });

  it('offers exactly the actions that are legal from a status', () => {
    expect(reportActionsFrom('draft').map((t) => t.action).sort()).toEqual(['cancel', 'submit']);
    expect(reportActionsFrom('under_review').map((t) => t.action).sort())
      .toEqual(['approve', 'cancel', 'request_changes', 'review']);
    expect(reportActionsFrom('approved').map((t) => t.action).sort()).toEqual(['cancel', 'issue']);
  });

  it('names one document permission per action, so nothing is allowed by accident', () => {
    for (const transition of REPORT_WORKFLOW) {
      expect(transition.permission).toMatch(/^report\./);
    }
    expect(REPORT_WORKFLOW.map((t) => t.action).sort()).toEqual([...REPORT_ACTIONS].sort());
  });

  it('defines transitions for every status, so no status is a dead end by accident', () => {
    for (const status of ['draft', 'under_review', 'changes_requested', 'approved', 'issued',
      'superseded', 'cancelled', 'revoked'] as const) {
      expect(Array.isArray(REPORT_TRANSITIONS[status])).toBe(true);
    }
    for (const status of REPORT_FINAL_STATUSES) {
      if (status === 'issued') continue; // issued can still be revised or cancelled
      expect(REPORT_TRANSITIONS[status]).toHaveLength(0);
    }
  });

  it('covers every document type the group issues', () => {
    expect(REPORT_TYPES).toContain('inspection_report');
    expect(REPORT_TYPES).toContain('certificate_of_analysis');
    expect(REPORT_TYPES).toContain('sampling_report');
    expect(REPORT_TYPES).toHaveLength(7);
  });
});
