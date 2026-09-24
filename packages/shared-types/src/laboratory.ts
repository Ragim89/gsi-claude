import type { Permission } from './rbac';
import type { JobPriority } from './job-workflow';
import type { LocalizedText } from './checklist-templates';

/**
 * The laboratory: one analysis on one sample, carried from "somebody asked for it" to "the
 * laboratory has released the answer".
 *
 * Two ideas run through this file and are worth stating once. First, a result is never edited
 * once it has been approved — correcting it means a new revision, and the old one stays exactly
 * as it was signed, because a report quoted it. Second, the person who ran the analysis is not
 * the person who signs it off; that separation is the point of a laboratory record.
 */

export const LAB_RESULT_TYPES = ['numeric', 'text', 'boolean', 'qualitative', 'pass_fail'] as const;
export type LabResultType = (typeof LAB_RESULT_TYPES)[number];

export const TEST_REQUEST_STATUSES = [
  'requested',
  'assigned',
  'in_progress',
  'result_entered',
  'under_review',
  'approved',
  'released',
  'on_hold',
  'rejected',
  'cancelled',
] as const;
export type TestRequestStatus = (typeof TEST_REQUEST_STATUSES)[number];

export const TEST_REQUEST_ACTIONS = [
  'assign', 'start', 'enter', 'submit', 'review', 'return', 'approve', 'release',
  'amend', 'hold', 'resume', 'reject', 'cancel',
] as const;
export type TestRequestAction = (typeof TEST_REQUEST_ACTIONS)[number];

export type LabGuard =
  | 'hasAnalyst'
  | 'hasResult'
  | 'hasTechnicalReview'
  | 'notSelfApproval'
  | 'sampleAccepted';

export interface LabTransition {
  action: TestRequestAction;
  from: readonly TestRequestStatus[];
  to: TestRequestStatus;
  permission: Permission;
  requiresReason?: boolean;
  guards?: readonly LabGuard[];
}

export const LAB_WORKFLOW: readonly LabTransition[] = [
  /** The laboratory decides who runs it. Re-assignment is the same move again. */
  {
    action: 'assign',
    from: ['requested', 'assigned'],
    to: 'assigned',
    permission: 'lab.test.assign',
    guards: ['hasAnalyst'],
  },
  /** Only the analyst it was given to starts it; the service checks that as well. */
  { action: 'start', from: ['assigned'], to: 'in_progress', permission: 'lab.test.start' },
  /**
   * Saving a result. Writing a draft is itself a move — `result_entered` means "there is an
   * answer on this bench, not yet handed in" — so even this goes through the engine and leaves
   * a line in the history rather than a silent UPDATE of `status`.
   */
  { action: 'enter', from: ['in_progress', 'result_entered'], to: 'result_entered', permission: 'lab.result.enter' },
  /** Submitting hands the draft to the laboratory for review. */
  {
    action: 'submit',
    from: ['result_entered'],
    to: 'under_review',
    permission: 'lab.result.submit',
    guards: ['hasResult'],
  },
  /**
   * Technical review. It deliberately does not move the status: reviewing is a signature on the
   * work, and approval is a separate decision by a separate right. Without this signature the
   * approval below refuses to happen.
   */
  {
    action: 'review',
    from: ['under_review'],
    to: 'under_review',
    permission: 'lab.result.review',
    guards: ['hasResult'],
  },
  {
    action: 'return',
    from: ['under_review', 'result_entered'],
    to: 'in_progress',
    permission: 'lab.result.review',
    requiresReason: true,
  },
  {
    action: 'approve',
    from: ['under_review'],
    to: 'approved',
    permission: 'lab.result.approve',
    guards: ['hasResult', 'hasTechnicalReview', 'notSelfApproval'],
  },
  /**
   * Approved is technically settled; released is cleared for use outside the laboratory. They
   * are separate because a correct result is not automatically a result the client may see yet.
   */
  { action: 'release', from: ['approved'], to: 'released', permission: 'lab.result.release' },
  /**
   * The only way to change an approved answer: a new revision, with the reason on the record.
   * The old revision stays exactly as it was signed.
   */
  {
    action: 'amend',
    from: ['approved', 'released'],
    to: 'in_progress',
    permission: 'lab.result.amend',
    requiresReason: true,
  },
  {
    action: 'hold',
    from: ['requested', 'assigned', 'in_progress', 'result_entered', 'under_review'],
    to: 'on_hold',
    permission: 'lab.test.assign',
    requiresReason: true,
  },
  { action: 'resume', from: ['on_hold'], to: 'in_progress', permission: 'lab.test.assign' },
  /** The laboratory cannot do it: wrong matrix, too little sample, no accredited method. */
  {
    action: 'reject',
    from: ['requested', 'assigned', 'in_progress'],
    to: 'rejected',
    permission: 'lab.test.assign',
    requiresReason: true,
  },
  /** Whoever asked no longer needs it. */
  {
    action: 'cancel',
    from: ['requested', 'assigned', 'on_hold'],
    to: 'cancelled',
    permission: 'lab.test.request',
    requiresReason: true,
  },
];

export function labTransitionFor(action: TestRequestAction): LabTransition | undefined {
  return LAB_WORKFLOW.find((t) => t.action === action);
}

export function labActionsFrom(status: TestRequestStatus): LabTransition[] {
  return LAB_WORKFLOW.filter((t) => t.from.includes(status));
}

/** Work the laboratory still owes an answer on. */
export const ACTIVE_TEST_STATUSES: readonly TestRequestStatus[] = [
  'requested', 'assigned', 'in_progress', 'result_entered', 'under_review', 'on_hold',
];

/** Nothing more will happen without a deliberate amendment. */
export const TERMINAL_TEST_STATUSES: readonly TestRequestStatus[] = ['released', 'rejected', 'cancelled'];

/** Statuses in which an analyst may still write to the result. */
export const RESULT_EDITABLE_STATUSES: readonly TestRequestStatus[] = ['in_progress', 'result_entered'];

export function canLabTransition(from: TestRequestStatus, to: TestRequestStatus): boolean {
  return labActionsFrom(from).some((t) =>
    t.action === 'resume' ? ACTIVE_TEST_STATUSES.includes(to) : t.to === to,
  );
}

export const LAB_TRANSITIONS: Record<TestRequestStatus, LabTransition[]> = Object.fromEntries(
  TEST_REQUEST_STATUSES.map((s) => [s, labActionsFrom(s)]),
) as Record<TestRequestStatus, LabTransition[]>;

export const SPEC_EVALUATIONS = ['within_spec', 'out_of_spec', 'not_evaluated'] as const;
export type SpecEvaluation = (typeof SPEC_EVALUATIONS)[number];

export const INSTRUMENT_STATUSES = ['active', 'maintenance', 'out_of_service', 'retired'] as const;
export type InstrumentStatus = (typeof INSTRUMENT_STATUSES)[number];

export interface LabUnit {
  code: string;
  name: LocalizedText;
  kind: string;
}

export interface LabTest {
  id: string;
  code: string;
  name: LocalizedText;
  category: string;
  description: string | null;
  defaultUnit: string | null;
  resultType: LabResultType;
  isActive: boolean;
  sortOrder: number;
  /** How many active methods exist for it; a test with none cannot be requested. */
  methodCount?: number;
}

export interface TestMethod {
  id: string;
  labTestId: string;
  testCode?: string;
  testName?: LocalizedText;
  code: string;
  name: string;
  standardReference: string | null;
  description: string | null;
  defaultUnit: string | null;
  detectionLimit: number | null;
  quantificationLimit: number | null;
  accreditationScope: string | null;
  /** Bumped by the database whenever anything substantive changes. */
  version: number;
  effectiveFrom: string;
  retiredAt: string | null;
  isActive: boolean;
}

export interface TestSpecification {
  id: string;
  labTestId: string;
  testCode?: string;
  testName?: LocalizedText;
  testMethodId: string | null;
  methodCode?: string | null;
  commodityId: string | null;
  commodityName?: LocalizedText | null;
  clientId: string | null;
  clientName?: string | null;
  contractId: string | null;
  contractRef?: string | null;
  minValue: number | null;
  maxValue: number | null;
  targetValue: number | null;
  unit: string | null;
  qualitativeRequirement: string | null;
  notes: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  /** contract → client → commodity → default; filled when a specification was resolved. */
  scope?: 'contract' | 'client' | 'commodity' | 'default';
}

export interface LabInstrument {
  id: string;
  laboratoryId: string;
  laboratoryName?: string;
  code: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  status: InstrumentStatus;
  calibrationDueAt: string | null;
  notes: string | null;
  /** Computed: calibration due date in the past. Warned about, never a block. */
  calibrationOverdue?: boolean;
}

/** The method as it was when a result was entered; frozen into the result row. */
export interface MethodSnapshot {
  id: string;
  code: string;
  name: string;
  version: number;
  standardReference: string | null;
  defaultUnit: string | null;
  detectionLimit: number | null;
  quantificationLimit: number | null;
  accreditationScope: string | null;
}

/** The limits the result was judged against; frozen into the result row. */
export interface SpecificationSnapshot {
  id: string | null;
  scope: 'contract' | 'client' | 'commodity' | 'default' | 'none';
  minValue: number | null;
  maxValue: number | null;
  targetValue: number | null;
  unit: string | null;
  qualitativeRequirement: string | null;
}

export interface TestRequest {
  id: string;
  branchId: string;
  branchCode?: string;
  sampleId: string;
  sampleNumber?: string;
  jobId?: string;
  jobNumber?: string;
  inspectionId?: string | null;
  clientId?: string;
  clientName?: string;
  commodityId?: string | null;
  commodityName?: LocalizedText | null;
  commodity?: string | null;
  laboratoryId: string;
  laboratoryName?: string;
  labTestId: string;
  testCode?: string;
  testName?: LocalizedText;
  resultType?: LabResultType;
  testMethodId: string;
  methodCode?: string;
  methodName?: string;
  methodVersion?: number;
  specificationId: string | null;
  status: TestRequestStatus;
  statusBeforeHold?: TestRequestStatus | null;
  priority: JobPriority;
  requestedBy: string | null;
  requestedByName?: string | null;
  requestedAt: string;
  assignedAnalystId: string | null;
  assignedAnalystName?: string | null;
  assignedAt: string | null;
  startedAt: string | null;
  dueAt: string | null;
  instructions: string | null;
  cancelReason: string | null;
  version?: number;
  /** Computed: due in the past while the laboratory still owes an answer. */
  overdue?: boolean;
  /** The live revision, when one exists. */
  result?: TestResult | null;
  revisionCount?: number;
  attachmentCount?: number;
  /** What this user may do right now; only the single-request endpoint fills it. */
  actions?: TestRequestAction[];
  createdAt: string;
  updatedAt: string;
}

export interface TestResult {
  id: string;
  testRequestId: string;
  revision: number;
  isCurrent: boolean;
  supersedesResultId: string | null;
  resultType: LabResultType;
  numericValue: number | null;
  textValue: string | null;
  booleanValue: boolean | null;
  qualitativeValue: string | null;
  unit: string | null;
  methodSnapshot: MethodSnapshot;
  specificationSnapshot: SpecificationSnapshot | null;
  evaluation: SpecEvaluation;
  instrumentId: string | null;
  instrumentName?: string | null;
  instrumentOverdue: boolean;
  analystId: string | null;
  analystName?: string | null;
  enteredAt: string;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedByName?: string | null;
  reviewedAt: string | null;
  approvedBy: string | null;
  approvedByName?: string | null;
  approvedAt: string | null;
  releasedBy: string | null;
  releasedByName?: string | null;
  releasedAt: string | null;
  comments: string | null;
  reviewComment: string | null;
  amendmentReason: string | null;
  version?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TestRequestHistoryEntry {
  id: string;
  testRequestId: string;
  fromStatus: TestRequestStatus | null;
  toStatus: TestRequestStatus;
  changedBy: string | null;
  changedByName?: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * What a report may quote. Only released revisions appear here — approved is the laboratory's
 * word that the number is right, released is its word that the number may leave the building.
 */
export interface ReleasedResult {
  testRequestId: string;
  resultId: string;
  revision: number;
  sampleId: string;
  sampleNumber: string;
  jobId: string;
  jobNumber: string;
  testCode: string;
  testName: LocalizedText;
  methodCode: string;
  methodName: string;
  methodVersion: number;
  standardReference: string | null;
  resultType: LabResultType;
  numericValue: number | null;
  textValue: string | null;
  booleanValue: boolean | null;
  qualitativeValue: string | null;
  unit: string | null;
  evaluation: SpecEvaluation;
  specificationSnapshot: SpecificationSnapshot | null;
  analystName: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  releasedAt: string;
}

/** What the laboratory dashboard counts. Every number is a query, not an estimate. */
export interface LabDashboard {
  samplesAwaitingTests: number;
  unassigned: number;
  inProgress: number;
  awaitingReview: number;
  awaitingApproval: number;
  awaitingRelease: number;
  overdue: number;
  outOfSpec: number;
}

/**
 * A commodity's standard panel: the analyses already recorded against it in
 * `commodities.lab_methods`, resolved to catalogue entries. There is deliberately no separate
 * panel table — the list has lived on the commodity since the reference data was first loaded,
 * and a second copy of it would only be a second thing to keep in step.
 */
export interface TestPanel {
  commodityId: string;
  commodityName: LocalizedText;
  tests: Array<{
    labTestId: string;
    code: string;
    name: LocalizedText;
    resultType: LabResultType;
    defaultUnit: string | null;
    /** The method that would be used, if the laboratory has declared one. */
    testMethodId: string | null;
    methodCode: string | null;
    /** True when this analysis is already requested on the sample. */
    alreadyRequested?: boolean;
  }>;
}
