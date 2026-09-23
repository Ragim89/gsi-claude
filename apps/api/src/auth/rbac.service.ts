import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { AccessScope, Permission } from '@gsi/shared-types';
import { DbService } from '../db/db.service';

interface RoleRow {
  code: string;
  scope: AccessScope;
  permission_code: string | null;
}

/**
 * Resolves roles to permissions.
 *
 * Tokens carry role codes, not the permissions themselves: a token stays small, and changing
 * what a role may do takes effect for everyone within a minute instead of at their next
 * sign-in. The map is tiny (a few dozen rows), so it is held in memory and refreshed lazily.
 */
@Injectable()
export class RbacService implements OnModuleInit {
  private readonly logger = new Logger(RbacService.name);
  private permissionsByRole = new Map<string, Permission[]>();
  private scopeByRole = new Map<string, AccessScope>();
  private loadedAt = 0;
  private loading: Promise<void> | null = null;
  private readonly rolesByUser = new Map<string, { roles: string[]; at: number }>();

  /** How long a cached copy is served before it is refreshed in the background. */
  private static readonly TTL_MS = 60_000;
  /** Role assignments are per user and change rarely, but must apply quickly when they do. */
  private static readonly USER_TTL_MS = 10_000;

  constructor(private readonly db: DbService) {}

  async onModuleInit() {
    // Failing here would leave every request unauthorised, so a cold start retries lazily.
    await this.reload().catch((err) => this.logger.error(`could not load roles: ${err.message}`));
  }

  /** Forces a refresh — called after roles or their permissions are edited. */
  async invalidate(): Promise<void> {
    this.loadedAt = 0;
    await this.ensureFresh();
  }

  /** Drops one user's cached role assignment, so a change applies on their next request. */
  invalidateUser(userId: string): void {
    this.rolesByUser.delete(userId);
  }

  /**
   * The roles a user has right now. Read from the database rather than taken from the token:
   * an access token lives for fifteen minutes, and an administrator who removes someone's
   * access should not have to wait that long for it to mean anything.
   */
  async rolesFor(userId: string, fallback: string[]): Promise<string[]> {
    const cached = this.rolesByUser.get(userId);
    if (cached && Date.now() - cached.at < RbacService.USER_TTL_MS) return cached.roles;
    try {
      const row = await this.db.tx(null, (tx) =>
        tx.one<{ roles: string[] }>('SELECT auth_user_roles($1) AS roles', [userId]),
      );
      const roles = row?.roles?.length ? row.roles : fallback;
      this.rolesByUser.set(userId, { roles, at: Date.now() });
      return roles;
    } catch (err) {
      // A database blip must not lock everyone out: fall back to what the token says.
      this.logger.warn(`could not read roles of ${userId}: ${(err as Error).message}`);
      return fallback;
    }
  }

  async permissionsFor(roles: string[]): Promise<Permission[]> {
    await this.ensureFresh();
    const out = new Set<Permission>();
    for (const role of roles) {
      for (const code of this.permissionsByRole.get(role) ?? []) out.add(code);
    }
    return [...out];
  }

  async scopeFor(roles: string[]): Promise<AccessScope> {
    await this.ensureFresh();
    const order: AccessScope[] = ['global', 'country', 'office', 'own'];
    let best = 3;
    for (const role of roles) {
      const scope = this.scopeByRole.get(role);
      if (scope) best = Math.min(best, order.indexOf(scope));
    }
    return order[best];
  }

  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.loadedAt < RbacService.TTL_MS) return;
    this.loading ??= this.reload().finally(() => {
      this.loading = null;
    });
    await this.loading;
  }

  private async reload(): Promise<void> {
    // rbac_role_matrix() is SECURITY DEFINER: the cache is filled before any user context
    // exists, exactly like login.
    const rows = await this.db.tx(null, (tx) => tx.many<RoleRow>('SELECT * FROM rbac_role_matrix()'));
    const permissions = new Map<string, Permission[]>();
    const scopes = new Map<string, AccessScope>();
    for (const row of rows) {
      scopes.set(row.code, row.scope);
      if (!permissions.has(row.code)) permissions.set(row.code, []);
      if (row.permission_code) permissions.get(row.code)!.push(row.permission_code as Permission);
    }
    this.permissionsByRole = permissions;
    this.scopeByRole = scopes;
    this.loadedAt = Date.now();
  }
}
