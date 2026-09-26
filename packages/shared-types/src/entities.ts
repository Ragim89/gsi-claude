import type { ChecklistResult, JobStatus, MediaType, ReportStatus, Role, ServiceType } from './enums';
import type { LocalizedText, ChecklistInputKind } from './checklist-templates';
import type { AccessScope, Organization, Permission } from './rbac';
import type { AssignmentRole, JobAction, JobObjectKind, JobPriority } from './job-workflow';

/** ISO-8601 timestamp string as returned by the API. */
export type Timestamp = string;

export interface Branch {
  id: string;
  code: string;
  country: string;
  city: string;
  currency: string;
  locale: string;
  uiLocales: string[];
  timezone: string;
  legalName: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  accreditation: string | null;
  isHq: boolean;
  letterheadTemplateId: string;
  // Profile (migration 003) — requisites, the person heading the entity, photos.
  legalForm?: string | null;
  registrationNo?: string | null;
  taxId?: string | null;
  vatNumber?: string | null;
  bankName?: string | null;
  bankAccount?: string | null;
  bankSwift?: string | null;
  website?: string | null;
  establishedYear?: number | null;
  description?: string | null;
  headUserId?: string | null;
  headTitle?: string | null;
  headName?: string | null;
  headEmail?: string | null;
  headRole?: Role | null;
  /** Short-lived presigned URLs, generated per request. */
  headPhotoUrl?: string | null;
  photoUrl?: string | null;
}

/** The subset of `Organization` (./rbac) safe to serve without authentication (login screen, PWA shell). */
export type OrganizationBrand = Pick<
  Organization,
  'name' | 'shortName' | 'productName' | 'primaryColor' | 'secondaryColor' | 'logoUrl' | 'logoLightUrl' | 'supportEmail' | 'supportPhone'
>;

export interface User {
  id: string;
  branchId: string;
  branchCode?: string;
  email: string;
  fullName: string;
  role: Role;
  locale: string;
  isActive: boolean;
}

/** Authenticated principal carried in the access token. */
export interface AuthUser {
  id: string;
  branchId: string;
  /** The country the user's office belongs to — drives `country` scope in the policies. */
  countryId?: string | null;
  /** Primary (legacy) role. Kept for display and for tokens issued before RBAC existed. */
  role: Role;
  email: string;
  fullName: string;
  locale: string;
  /** All roles assigned to the user, by code. */
  roles?: string[];
  /** How far this user can see: global / country / office / own. */
  scope?: AccessScope;
  /** Everything the user may do, resolved from their roles. */
  permissions?: Permission[];
}

/** What the API returns from the body of /auth/login and /auth/refresh. The refresh token
 *  itself never appears here — it travels only as an httpOnly cookie (PHASE 12). */
export interface AuthTokens {
  accessToken: string;
  user: AuthUser;
}

export interface Client {
  id: string;
  branchId: string;
  branchCode?: string;
  name: string;
  gaftaFosfaRef: string | null;
  taxId: string | null;
  country: string | null;
  address: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
  jobCount?: number;
  /** Contracts currently in force — what the list screen shows at a glance. */
  activeContracts?: number;
  /** Name of the contact marked as primary, when there is one. */
  primaryContact?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface InspectionJob {
  id: string;
  branchId: string;
  branchCode?: string;
  jobNumber: string;
  clientId: string;
  clientName?: string;
  countryId?: string;
  type: ServiceType;
  status: JobStatus;
  priority: JobPriority;
  /** The lead of the job; everyone else working on it is in `assignees`. */
  assignedInspectorId: string | null;
  assignedInspectorName?: string | null;
  assignees?: { id: string; userId: string; userName: string; role: AssignmentRole }[];
  /** The person at the client this job is agreed with. */
  clientContactId?: string | null;
  clientContactName?: string | null;
  /** The office that asked for the work, when it is not the one performing it. */
  requestingBranchId?: string | null;
  requestingBranchCode?: string | null;
  /** The client's own reference for this job. */
  clientReference?: string | null;
  /** Ours to see, never printed for the client. */
  internalNotes?: string | null;
  location: string;
  city?: string | null;
  vesselOrObject: string | null;
  objectKind?: JobObjectKind | null;
  containerNo?: string | null;
  transportRef?: string | null;
  /** Free text from the client's nomination; the structured value is commodityId. */
  commodity: string | null;
  quantity: string | null;
  // Structured reference data (migration 004) — what filters and reporting work on.
  commodityId: string | null;
  commodityName?: LocalizedText | null;
  commodityGroup?: string | null;
  portId: string | null;
  portName?: string | null;
  portCountry?: string | null;
  contractNo: string | null;
  /** The contract record this job belongs to, when one is on file. */
  contractId?: string | null;
  /** Its number, for showing the link without a second request. */
  contractRef?: string | null;
  quantityValue: number | null;
  quantityUnit: string;
  /** The day the client asked for (a calendar date, not an instant). */
  requestedDate?: string | null;
  scheduledAt: Timestamp | null;
  instructions: string | null;
  reviewComment: string | null;
  /** Where a job on hold came from, so resuming puts it back. */
  statusBeforeHold?: JobStatus | null;
  /** Bumped on every save; a form loaded with an older one is refused. */
  version?: number;
  /** Computed, never stored: scheduled in the past while the work is still open. */
  overdue?: boolean;
  submittedAt: Timestamp | null;
  approvedAt: Timestamp | null;
  approvedBy: string | null;
  archivedAt?: Timestamp | null;
  /** What this user may do with the job right now; only the single-job endpoint fills it. */
  actions?: JobAction[];
  createdBy?: string | null;
  createdByName?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface MediaAttachment {
  id: string;
  jobId: string;
  checklistItemId: string | null;
  type: MediaType;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  originalName: string | null;
  gpsLat: number | null;
  gpsLng: number | null;
  gpsAccuracyM: number | null;
  takenAt: Timestamp | null;
  createdAt: Timestamp;
  /** Short-lived presigned URLs, generated per request. */
  url?: string;
  previewUrl?: string;
}

export interface ChecklistItem {
  id: string;
  jobId: string;
  itemKey: string;
  label: LocalizedText;
  inputKind: ChecklistInputKind;
  sortOrder: number;
  result: ChecklistResult | null;
  value: string | null;
  notes: string | null;
  updatedAt: Timestamp;
  media: MediaAttachment[];
}

export interface Report {
  id: string;
  branchId: string;
  jobId: string;
  jobNumber?: string;
  clientId?: string;
  clientName?: string;
  serviceType?: ServiceType;
  reportNumber: string;
  version: number;
  status: ReportStatus;
  templateId: string;
  approvedBy: string | null;
  approvedByName?: string | null;
  approvedAt: Timestamp | null;
  verificationToken: string;
  createdAt: Timestamp;
}

export interface ReportVerification {
  valid: boolean;
  reportNumber?: string;
  status?: ReportStatus;
  issuedAt?: Timestamp;
  branch?: string;
  jobNumber?: string;
  serviceType?: ServiceType;
  clientName?: string;
}
