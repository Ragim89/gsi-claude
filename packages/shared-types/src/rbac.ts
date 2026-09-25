/**
 * Permissions and roles. The lists here mirror the catalogue seeded in
 * apps/api/migrations/008_rbac.sql — the database is the source of truth at runtime, these
 * types exist so a typo in a permission code is a compile error rather than a silent "denied".
 */

export const PERMISSIONS = [
  // Operations
  'job.read', 'job.create', 'job.update', 'job.assign', 'job.start', 'job.submit',
  'job.approve', 'job.cancel', 'job.archive', 'job.restore', 'job.change_status', 'job.close',
  'job.read_history', 'job.read_finance',
  'checklist.update', 'media.upload', 'media.delete',
  // Inspections
  'inspection.read', 'inspection.create', 'inspection.update', 'inspection.assign',
  'inspection.start', 'inspection.complete', 'inspection.review', 'inspection.approve',
  'inspection.cancel', 'inspection.archive', 'inspection.restore',
  'inspection.add_finding', 'inspection.add_measurement',
  // Samples and chain of custody
  'sample.read', 'sample.create', 'sample.update', 'sample.register', 'sample.seal',
  'sample.dispatch', 'sample.receive', 'sample.accept_lab', 'sample.reject_lab',
  'sample.archive', 'sample.restore', 'sample.read_custody', 'sample.add_attachment',
  'sample.print_label',
  // Laboratory
  'lab.test.read', 'lab.test.request', 'lab.test.assign', 'lab.test.start',
  'lab.result.enter', 'lab.result.submit', 'lab.result.review', 'lab.result.approve',
  'lab.result.release', 'lab.result.amend', 'lab.result.self_approve',
  'lab.method.read', 'lab.method.manage', 'lab.specification.read', 'lab.specification.manage',
  'lab.instrument.read', 'lab.instrument.manage',
  // CRM
  'client.read', 'client.create', 'client.update', 'client.archive',
  // Documents
  'report.read', 'report.download', 'report.preview',
  'report.create', 'report.update', 'report.submit_review', 'report.review', 'report.approve',
  'report.issue', 'report.revise', 'report.cancel', 'report.archive', 'report.restore',
  'report.manage_templates', 'report.self_approve',
  // Finance
  'finance.read', 'dashboard.read', 'invoice.create', 'invoice.issue', 'invoice.pay',
  'invoice.cancel', 'invoice.delete', 'invoice.remind', 'expense.create', 'expense.delete',
  'expense.pay', 'fx.manage',
  // Services, pricing, quotes
  'service.read', 'service.manage', 'pricing.read', 'pricing.manage',
  'quote.read', 'quote.create', 'quote.update', 'quote.send', 'quote.decide', 'quote.cancel',
  'quote.archive', 'quote.restore',
  // Payments
  'payment.read', 'payment.create', 'payment.allocate',
  // Assets
  'asset.read', 'asset.create', 'asset.update', 'asset.delete', 'asset.depreciate',
  // Reference data
  'reference.read', 'reference.manage',
  // Contracts
  'contract.read', 'contract.manage',
  // Administration
  'branch.read', 'branch.manage', 'org.manage', 'user.read', 'user.manage', 'role.manage',
  'audit.read',
  // Data movement
  'export.run', 'import.run',
  // Analytics
  'analytics.read', 'analytics.workload',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * How far a role reaches. Row-Level Security reads this, not the role name:
 * `global` — the whole group, `country` — every office in one country,
 * `office` — one office, `own` — only records assigned to that person.
 */
export const ACCESS_SCOPES = ['global', 'country', 'office', 'own'] as const;
export type AccessScope = (typeof ACCESS_SCOPES)[number];

/** Broadest first — used to pick the effective scope of a user with several roles. */
export function widestScope(scopes: readonly AccessScope[]): AccessScope {
  for (const scope of ACCESS_SCOPES) {
    if (scopes.includes(scope)) return scope;
  }
  return 'own';
}

export interface RoleDefinition {
  code: string;
  name: string;
  description: string | null;
  scope: AccessScope;
  isSystem: boolean;
  permissions: Permission[];
  users?: number;
}

export interface PermissionDefinition {
  code: Permission;
  category: string;
  description: string;
}

export interface AuditEntry {
  id: string;
  occurredAt: string;
  userId: string | null;
  userEmail: string | null;
  userRole: string | null;
  branchId: string | null;
  branchCode?: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  entityLabel: string | null;
  beforeData: Record<string, unknown> | null;
  afterData: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  requestId: string | null;
}

export interface Organization {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  baseCurrency: string;
  website: string | null;
}

export interface Country {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  locale: string | null;
  timezone: string | null;
  isActive: boolean;
  offices?: number;
}

export const DEPARTMENT_KINDS = [
  'operations', 'laboratory', 'finance', 'administration', 'sales', 'other',
] as const;
export type DepartmentKind = (typeof DEPARTMENT_KINDS)[number];

export interface Department {
  id: string;
  branchId: string;
  branchCode?: string;
  code: string;
  name: string;
  kind: DepartmentKind;
  headUserId: string | null;
  headName?: string | null;
  isActive: boolean;
  users?: number;
}
