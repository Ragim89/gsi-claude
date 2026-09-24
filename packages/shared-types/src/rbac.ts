/**
 * Permissions and roles. The lists here mirror the catalogue seeded in
 * apps/api/migrations/008_rbac.sql — the database is the source of truth at runtime, these
 * types exist so a typo in a permission code is a compile error rather than a silent "denied".
 */

export const PERMISSIONS = [
  // Operations
  'job.read', 'job.create', 'job.update', 'job.assign', 'job.start', 'job.submit',
  'job.approve', 'job.cancel', 'job.delete', 'checklist.update', 'media.upload', 'media.delete',
  // CRM
  'client.read', 'client.create', 'client.update', 'client.archive',
  // Documents
  'report.read', 'report.download', 'report.preview',
  // Finance
  'finance.read', 'dashboard.read', 'invoice.create', 'invoice.issue', 'invoice.pay',
  'invoice.cancel', 'invoice.delete', 'expense.create', 'expense.delete', 'fx.manage',
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
