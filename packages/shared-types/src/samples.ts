import type { Permission } from './rbac';
import type { LocalizedText } from './checklist-templates';

/**
 * The sample: the physical thing that leaves the quay in a sealed bag and arrives at a
 * laboratory bench, and the paper trail that has to arrive with it.
 *
 * Two different records are kept deliberately. The **status** is what the business believes
 * about the sample. The **chain of custody** is where it physically was and who held it. A
 * sample can change hands three times without its status moving, and "in transit" is a place
 * it is, not a decision anyone made — which is why that is a custody event and not a status.
 */

export const SAMPLE_STATUSES = [
  'draft',
  'collected',
  'registered',
  'sealed',
  'dispatched',
  'received_by_lab',
  'accepted_by_lab',
  'rejected_by_lab',
  'on_hold',
  'cancelled',
] as const;
export type SampleStatus = (typeof SAMPLE_STATUSES)[number];

export const SAMPLE_ACTIONS = [
  'collect', 'register', 'seal', 'dispatch', 'receive',
  'accept', 'reject', 'return', 'hold', 'resume', 'cancel',
] as const;
export type SampleAction = (typeof SAMPLE_ACTIONS)[number];

export type SampleGuard =
  | 'hasSampler'
  | 'hasIdentity'
  | 'hasSeal'
  | 'hasDestination'
  | 'hasRejectionReason';

export interface SampleTransition {
  action: SampleAction;
  from: readonly SampleStatus[];
  to: SampleStatus;
  permission: Permission;
  requiresReason?: boolean;
  guards?: readonly SampleGuard[];
}

export const SAMPLE_WORKFLOW: readonly SampleTransition[] = [
  /** Taken on site. Until this point it is a form somebody started filling in. */
  { action: 'collect', from: ['draft'], to: 'collected', permission: 'sample.create', guards: ['hasSampler'] },
  /**
   * Registration is the controlled check that the sample is what the paperwork says. After it,
   * the identity fields are frozen: changing what a registered sample is would make every
   * downstream record a lie.
   */
  { action: 'register', from: ['collected'], to: 'registered', permission: 'sample.register', guards: ['hasIdentity'] },
  { action: 'seal', from: ['registered'], to: 'sealed', permission: 'sample.seal', guards: ['hasSeal'] },
  {
    action: 'dispatch',
    from: ['sealed'],
    to: 'dispatched',
    permission: 'sample.dispatch',
    guards: ['hasDestination'],
  },
  { action: 'receive', from: ['dispatched'], to: 'received_by_lab', permission: 'sample.receive' },
  { action: 'accept', from: ['received_by_lab'], to: 'accepted_by_lab', permission: 'sample.accept_lab' },
  {
    action: 'reject',
    from: ['received_by_lab'],
    to: 'rejected_by_lab',
    permission: 'sample.reject_lab',
    requiresReason: true,
    guards: ['hasRejectionReason'],
  },
  /** A rejected sample goes back to the office, which may re-seal and send it again. */
  {
    action: 'return',
    from: ['rejected_by_lab'],
    to: 'registered',
    permission: 'sample.dispatch',
    requiresReason: true,
  },
  {
    action: 'hold',
    from: ['collected', 'registered', 'sealed', 'dispatched'],
    to: 'on_hold',
    permission: 'sample.update',
    requiresReason: true,
  },
  { action: 'resume', from: ['on_hold'], to: 'registered', permission: 'sample.update' },
  {
    action: 'cancel',
    from: ['draft', 'collected', 'registered', 'sealed', 'on_hold'],
    to: 'cancelled',
    permission: 'sample.update',
    requiresReason: true,
  },
];

export function sampleTransitionFor(action: SampleAction): SampleTransition | undefined {
  return SAMPLE_WORKFLOW.find((t) => t.action === action);
}

export function sampleActionsFrom(status: SampleStatus): SampleTransition[] {
  return SAMPLE_WORKFLOW.filter((t) => t.from.includes(status));
}

/** Work still moving: not accepted by a laboratory, not cancelled. */
export const ACTIVE_SAMPLE_STATUSES: readonly SampleStatus[] = [
  'draft', 'collected', 'registered', 'sealed', 'dispatched', 'received_by_lab', 'rejected_by_lab', 'on_hold',
];

/** Once here, the sample's journey through this phase is over. */
export const TERMINAL_SAMPLE_STATUSES: readonly SampleStatus[] = ['accepted_by_lab', 'cancelled'];

/**
 * Whether one status can legally become another. `resume` is the exception the table cannot
 * express: it returns to whatever the sample was doing before the hold.
 */
export function canSampleTransition(from: SampleStatus, to: SampleStatus): boolean {
  return sampleActionsFrom(from).some((t) =>
    t.action === 'resume' ? ACTIVE_SAMPLE_STATUSES.includes(to) : t.to === to,
  );
}

export const SAMPLE_TRANSITIONS: Record<SampleStatus, SampleTransition[]> = Object.fromEntries(
  SAMPLE_STATUSES.map((s) => [s, sampleActionsFrom(s)]),
) as Record<SampleStatus, SampleTransition[]>;

/**
 * What the sample *is*: changing any of these after registration would make the seal, the
 * label and the laboratory's paperwork describe something else. Editable only while the
 * sample is a draft or freshly collected.
 */
export const SAMPLE_IDENTITY_FIELDS = [
  'sampleType', 'samplingMethod', 'commodityId', 'commodity', 'quantity', 'unit',
  'batchLotNumber', 'containerReference', 'containerType', 'sampledAt', 'sampledBy',
] as const;

/** Identity is settled here; after that only the account around it may be added to. */
export const IDENTITY_EDITABLE_STATUSES: readonly SampleStatus[] = ['draft', 'collected'];

/** Notes and instructions stay open until the sample is out of our hands. */
export const DETAIL_EDITABLE_STATUSES: readonly SampleStatus[] = [
  'draft', 'collected', 'registered', 'sealed', 'on_hold',
];

export const SAMPLE_TYPES = [
  'representative', 'composite', 'increment', 'retention', 'reference',
  'control', 'counter_sample', 'other',
] as const;
export type SampleType = (typeof SAMPLE_TYPES)[number];

export const SAMPLING_METHODS = [
  'manual', 'automatic', 'systematic', 'random', 'composite', 'incremental', 'other',
] as const;
export type SamplingMethod = (typeof SAMPLING_METHODS)[number];

export const SEAL_CONDITIONS = ['intact', 'damaged', 'broken', 'missing'] as const;
export type SealCondition = (typeof SEAL_CONDITIONS)[number];

export const SAMPLE_CONDITIONS = ['good', 'damaged', 'leaking', 'contaminated', 'insufficient', 'other'] as const;
export type SampleCondition = (typeof SAMPLE_CONDITIONS)[number];

export const SAMPLE_REJECTION_REASONS = [
  'damaged', 'broken_seal', 'insufficient_quantity', 'wrong_sample',
  'missing_documentation', 'container_damage', 'other',
] as const;
export type SampleRejectionReason = (typeof SAMPLE_REJECTION_REASONS)[number];

/**
 * The physical story. Not every status change is a custody event and not every custody event
 * moves the status — a sample handed from the inspector to the office courier has changed
 * hands without changing what the business thinks of it.
 */
export const CUSTODY_EVENT_TYPES = [
  'collected', 'registered', 'sealed', 'handover', 'dispatched', 'in_transit',
  'received', 'lab_received', 'lab_accepted', 'lab_rejected', 'returned', 'archived', 'correction',
] as const;
export type CustodyEventType = (typeof CUSTODY_EVENT_TYPES)[number];

export interface Sample {
  id: string;
  branchId: string;
  branchCode?: string;
  jobId: string;
  jobNumber?: string;
  inspectionId: string | null;
  inspectionNumber?: string | null;
  clientId: string;
  clientName?: string;
  sampleNumber: string;

  sampleType: SampleType;
  samplingMethod: SamplingMethod;
  status: SampleStatus;
  statusBeforeHold?: SampleStatus | null;

  commodityId: string | null;
  commodity: string | null;
  commodityName?: LocalizedText | null;
  commodityDetails: string | null;
  quantity: number | null;
  unit: string | null;
  containerType: string | null;
  batchLotNumber: string | null;
  containerReference: string | null;
  location: string | null;

  sealNumber: string | null;
  sealType: string | null;
  sealedBy: string | null;
  sealedByName?: string | null;
  sealedAt: string | null;
  sealState: SealCondition | null;
  sealBrokenAt: string | null;
  sealBrokenBy: string | null;

  sampledBy: string | null;
  sampledByName?: string | null;
  sampledAt: string | null;
  conditionNotes: string | null;
  instructions: string | null;
  /** Ours to read; never printed for the client. */
  internalNotes?: string | null;

  destinationLaboratoryId: string | null;
  destinationLaboratoryName?: string | null;
  dispatchedAt: string | null;
  dispatchedBy: string | null;
  dispatchedByName?: string | null;
  courier: string | null;
  trackingReference: string | null;
  packageCount: number | null;
  receivedAt: string | null;
  receivedBy: string | null;
  receivedByName?: string | null;
  receivedCondition: SampleCondition | null;
  receivedSealCondition: SealCondition | null;
  labDecisionAt: string | null;
  labDecisionBy: string | null;
  labDecisionByName?: string | null;
  rejectionReason: SampleRejectionReason | null;
  rejectionNotes: string | null;

  sampleGroup: string | null;
  parentSampleId: string | null;

  /** Where the sample is right now, from the last custody event — computed, never stored. */
  currentLocation?: string | null;
  currentCustodianId?: string | null;
  currentCustodianName?: string | null;

  attachmentCount?: number;
  custodyEventCount?: number;

  version?: number;
  /** What this user may do right now; only the single-sample endpoint fills it. */
  actions?: SampleAction[];
  createdBy?: string | null;
  createdByName?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}

export interface SampleStatusHistoryEntry {
  id: string;
  sampleId: string;
  fromStatus: SampleStatus | null;
  toStatus: SampleStatus;
  changedBy: string | null;
  changedByName?: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface SampleCustodyEvent {
  id: string;
  sampleId: string;
  eventType: CustodyEventType;
  fromUserId: string | null;
  fromUserName?: string | null;
  fromOfficeId: string | null;
  fromOfficeCode?: string | null;
  fromLocation: string | null;
  toUserId: string | null;
  toUserName?: string | null;
  toOfficeId: string | null;
  toOfficeCode?: string | null;
  toLocation: string | null;
  laboratoryId: string | null;
  laboratoryName?: string | null;
  occurredAt: string;
  recordedBy: string | null;
  recordedByName?: string | null;
  sealState: SealCondition | null;
  condition: SampleCondition | null;
  notes: string | null;
  mediaId: string | null;
  correctsEventId: string | null;
  /** Set on the entry a later correction supersedes, so the timeline can show it as amended. */
  correctedByEventId?: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface Laboratory {
  id: string;
  branchId: string | null;
  branchCode?: string | null;
  countryId: string | null;
  code: string;
  name: string;
  city: string | null;
  address: string | null;
  timezone: string | null;
  isExternal: boolean;
  isActive: boolean;
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
}

/**
 * What a printed sample label carries. It travels taped to a bag through a port, so it says
 * only what somebody holding the bag already knows.
 *
 * The QR code is a deep link into the application, not a public verification page. A report's
 * QR proves a document is genuine to an outside party, which is why it is public; a sample
 * label exists so our own people can find the record on a phone, and a sample's commodity,
 * client and destination are nobody else's business. Scanning it without a session gets a
 * login screen, and with one it is still subject to the same Row-Level Security as the list.
 */
export interface SampleLabel {
  sampleNumber: string;
  jobNumber: string;
  clientName: string;
  commodity: string | null;
  sampleType: SampleType;
  quantity: string | null;
  sealNumber: string | null;
  sampledAt: string | null;
  branchCode: string;
  destination: string | null;
  /** Authenticated deep link to the sample card; encoded in the QR image. */
  url: string;
  /** PNG data URL, rendered with the same library the report QR uses. */
  qrDataUrl: string;
}
