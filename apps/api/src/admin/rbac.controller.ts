import { Body, Controller, Get, NotFoundException, Param, Put, Query } from '@nestjs/common';
import { ArrayUnique, IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { AuthUser, PERMISSIONS, Permission } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { DbService } from '../db/db.service';
import { RbacService } from '../auth/rbac.service';
import { AuditService } from '../common/audit.service';

class SetPermissionsDto {
  @IsArray()
  @ArrayUnique()
  @IsIn(PERMISSIONS, { each: true })
  permissions: Permission[];
}

class SetRolesDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  roles: string[];
}

class AuditQueryDto {
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsString() @MaxLength(60) action?: string;
  @IsOptional() @IsString() @MaxLength(40) entityType?: string;
  @IsOptional() @IsUUID() entityId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

const AUDIT_COLUMNS = `
  a.id::text AS id, a.occurred_at AS "occurredAt", a.user_id AS "userId", a.user_email AS "userEmail",
  a.user_role AS "userRole", a.branch_id AS "branchId", b.code AS "branchCode", a.action,
  a.entity_type AS "entityType", a.entity_id AS "entityId", a.entity_label AS "entityLabel",
  a.before_data AS "beforeData", a.after_data AS "afterData", a.metadata, a.request_id AS "requestId"`;

/**
 * Administration of who may do what, and the record of what was done.
 *
 * Roles and their permissions are data, not code: a laboratory manager can be given the right
 * to approve results without touching a single line of TypeScript.
 */
@Controller('admin')
export class RbacController {
  constructor(
    private readonly db: DbService,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
  ) {}

  /** The full vocabulary, for the role editor. */
  @Get('permissions')
  @RequirePermission('role.manage', 'user.read')
  permissions(@CurrentUser() user: AuthUser) {
    return this.db.tx(user, (tx) =>
      tx.many('SELECT code, category, description FROM permissions ORDER BY category, code'),
    );
  }

  @Get('roles')
  @RequirePermission('role.manage', 'user.read')
  roles(@CurrentUser() user: AuthUser) {
    return this.db.tx(user, (tx) =>
      tx.many(
        `SELECT r.code, r.name, r.description, r.scope::text AS scope, r.is_system AS "isSystem",
                COALESCE((SELECT array_agg(rp.permission_code ORDER BY rp.permission_code)
                          FROM role_permissions rp WHERE rp.role_code = r.code), ARRAY[]::text[]) AS permissions,
                (SELECT count(*)::int FROM user_roles ur WHERE ur.role_code = r.code) AS users
         FROM roles r ORDER BY r.sort_order, r.code`,
      ),
    );
  }

  /** Replaces the permission set of a role. Takes effect for everyone within a minute. */
  @Put('roles/:code/permissions')
  @RequirePermission('role.manage')
  async setRolePermissions(
    @CurrentUser() user: AuthUser,
    @Param('code') code: string,
    @Body() dto: SetPermissionsDto,
  ) {
    const result = await this.db.tx(user, async (tx) => {
      const role = await tx.one<{ code: string; name: string }>('SELECT code, name FROM roles WHERE code = $1', [code]);
      if (!role) throw new NotFoundException('Role not found');
      const before = await tx.many<{ permission_code: string }>(
        'SELECT permission_code FROM role_permissions WHERE role_code = $1 ORDER BY permission_code',
        [code],
      );
      await tx.exec('DELETE FROM role_permissions WHERE role_code = $1', [code]);
      for (const permission of dto.permissions) {
        await tx.exec('INSERT INTO role_permissions (role_code, permission_code) VALUES ($1, $2)', [code, permission]);
      }
      await this.audit.record(tx, user, {
        action: 'role.manage',
        entityType: 'role',
        entityLabel: role.name,
        before: { permissions: before.map((b) => b.permission_code) },
        after: { permissions: [...dto.permissions].sort() },
      });
      return { code, permissions: dto.permissions };
    });
    // The cache would otherwise serve the old set for up to a minute.
    await this.rbac.invalidate();
    return result;
  }

  @Get('users/:id/roles')
  @RequirePermission('user.read')
  userRoles(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.db.tx(user, (tx) =>
      tx.many('SELECT role_code AS "roleCode" FROM user_roles WHERE user_id = $1 ORDER BY role_code', [id]),
    );
  }

  /** Replaces the roles of one user. */
  @Put('users/:id/roles')
  @RequirePermission('role.manage')
  async setUserRoles(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SetRolesDto) {
    const result = await this.db.tx(user, async (tx) => {
      // RLS makes a user outside the caller's scope invisible, so this is also the access check.
      const target = await tx.one<{ email: string; branch_id: string }>(
        'SELECT email, branch_id FROM users WHERE id = $1',
        [id],
      );
      if (!target) throw new NotFoundException('User not found');
      const known = await tx.many<{ code: string }>('SELECT code FROM roles WHERE code = ANY($1::text[])', [dto.roles]);
      if (known.length !== dto.roles.length) throw new NotFoundException('Unknown role');

      const before = await tx.many<{ role_code: string }>(
        'SELECT role_code FROM user_roles WHERE user_id = $1 ORDER BY role_code',
        [id],
      );
      await tx.exec('DELETE FROM user_roles WHERE user_id = $1', [id]);
      for (const role of dto.roles) {
        await tx.exec('INSERT INTO user_roles (user_id, role_code, granted_by) VALUES ($1, $2, $3)', [id, role, user.id]);
      }
      await this.audit.record(tx, user, {
        action: 'role.manage',
        entityType: 'user',
        entityId: id,
        entityLabel: target.email,
        branchId: target.branch_id,
        before: { roles: before.map((b) => b.role_code) },
        after: { roles: [...dto.roles].sort() },
      });
      return { userId: id, roles: dto.roles };
    });
    this.rbac.invalidateUser(id);
    return result;
  }

  /**
   * The audit trail. Read-only by design — there is no endpoint that edits or removes an
   * entry, and the application's database role has no grant to do so either.
   */
  @Get('audit')
  @RequirePermission('audit.read')
  audit_(@CurrentUser() user: AuthUser, @Query() q: AuditQueryDto) {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    return this.db.tx(user, async (tx) => {
      const params = [
        q.userId ?? null,
        q.branchId ?? null,
        q.action ?? null,
        q.entityType ?? null,
        q.entityId ?? null,
        q.from ?? null,
        q.to ?? null,
        q.search?.trim() || null,
      ];
      const where = `
        WHERE ($1::uuid IS NULL OR a.user_id = $1::uuid)
          AND ($2::uuid IS NULL OR a.branch_id = $2::uuid)
          AND ($3::text IS NULL OR a.action LIKE $3 || '%')
          AND ($4::text IS NULL OR a.entity_type = $4)
          AND ($5::uuid IS NULL OR a.entity_id = $5::uuid)
          AND ($6::date IS NULL OR a.occurred_at >= $6::date)
          AND ($7::date IS NULL OR a.occurred_at < $7::date + 1)
          AND ($8::text IS NULL OR a.entity_label ILIKE '%' || $8 || '%' OR a.user_email ILIKE '%' || $8 || '%')`;

      const [rows, total] = await Promise.all([
        tx.many(
          `SELECT ${AUDIT_COLUMNS}
           FROM audit_logs a LEFT JOIN branches b ON b.id = a.branch_id
           ${where}
           ORDER BY a.occurred_at DESC, a.id DESC
           LIMIT ${limit} OFFSET ${offset}`,
          params,
        ),
        tx.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_logs a ${where}`,
          params,
        ),
      ]);
      return { rows, total: total?.n ?? 0, limit, offset };
    });
  }
}
