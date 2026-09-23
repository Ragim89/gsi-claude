import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { AuthUser, HQ_ROLES, Role, ROLES } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { DbService } from '../db/db.service';
import { buildSet } from '../common/sql';
import { AuditService } from '../common/audit.service';

const USER_COLUMNS = `
  u.id, u.branch_id AS "branchId", b.code AS "branchCode", u.email, u.full_name AS "fullName",
  u.role, u.locale, u.is_active AS "isActive", u.department_id AS "departmentId",
  COALESCE((SELECT array_agg(ur.role_code ORDER BY ur.role_code)
            FROM user_roles ur WHERE ur.user_id = u.id), ARRAY[]::text[]) AS roles`;

class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(2)
  fullName: string;

  @IsIn(ROLES)
  role: Role;

  @IsUUID()
  branchId: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsOptional()
  @IsString()
  locale?: string;
}

class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(2) fullName?: string;
  @IsOptional() @IsIn(ROLES) role?: Role;
  @IsOptional() @IsString() locale?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() @MinLength(8) password?: string;
}

// Roles available so far: MVP-1 operations + MVP-3 finance. Lab and client-portal roles
// are enabled together with their modules.
const ENABLED_ROLES: Role[] = ['inspector', 'supervisor', 'finance_controller', 'cfo', 'admin'];

@Controller('users')
export class UsersController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** Supervisors need this to pick inspectors for assignment. */
  @Get()
  @RequirePermission('user.read')
  list(@CurrentUser() user: AuthUser, @Query('role') role?: string, @Query('branchId') branchId?: string) {
    return this.db.tx(user, (tx) =>
      tx.many(
        `SELECT ${USER_COLUMNS} FROM users u JOIN branches b ON b.id = u.branch_id
         WHERE ($1::user_role IS NULL OR u.role = $1::user_role)
           AND ($2::uuid IS NULL OR u.branch_id = $2::uuid)
         ORDER BY b.code, u.full_name`,
        [role || null, branchId || null],
      ),
    );
  }

  @Post()
  @RequirePermission('user.manage')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto) {
    if (!ENABLED_ROLES.includes(dto.role)) {
      throw new BadRequestException(`Role ${dto.role} is not available yet`);
    }
    const hash = await bcrypt.hash(dto.password, 10);
    return this.db.tx(user, async (tx) => {
      const row = await tx.one<{ id: string }>(
        `INSERT INTO users (branch_id, email, password_hash, full_name, role, locale)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [dto.branchId, dto.email.trim(), hash, dto.fullName.trim(), dto.role, dto.locale ?? 'en'],
      );
      // Give the new account the role that matches its type; finer-grained roles are assigned
      // afterwards on the roles screen.
      await tx.exec(
        `INSERT INTO user_roles (user_id, role_code, granted_by)
         SELECT $1, r.code, $3 FROM roles r
         WHERE r.legacy_role = $2::user_role
           AND r.sort_order = (SELECT min(r2.sort_order) FROM roles r2 WHERE r2.legacy_role = $2::user_role)
         ON CONFLICT DO NOTHING`,
        [row!.id, dto.role, user.id],
      );
      await this.audit.record(tx, user, {
        action: 'user.manage',
        entityType: 'user',
        entityId: row!.id,
        entityLabel: dto.email.trim(),
        branchId: dto.branchId,
        after: { email: dto.email.trim(), fullName: dto.fullName.trim(), role: dto.role },
      });
      return tx.one(`SELECT ${USER_COLUMNS} FROM users u JOIN branches b ON b.id = u.branch_id WHERE u.id = $1`, [row!.id]);
    });
  }

  @Patch(':id')
  @RequirePermission('user.manage')
  async update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    if (dto.role && !ENABLED_ROLES.includes(dto.role)) {
      throw new BadRequestException(`Role ${dto.role} is not available yet`);
    }
    if (id === user.id && (dto.isActive === false || (dto.role && !HQ_ROLES.includes(dto.role)))) {
      throw new BadRequestException('You cannot deactivate or demote yourself');
    }
    const patch: Record<string, unknown> = { ...dto };
    if (dto.password) patch.passwordHash = await bcrypt.hash(dto.password, 10);
    const { sql, params } = buildSet(patch, {
      fullName: 'full_name',
      role: 'role',
      locale: 'locale',
      isActive: 'is_active',
      passwordHash: 'password_hash',
    }, 2);
    if (!sql) throw new BadRequestException('Nothing to update');
    return this.db.tx(user, async (tx) => {
      const before = await tx.one<Record<string, unknown>>(
        'SELECT email, full_name, role::text AS role, locale, is_active FROM users WHERE id = $1',
        [id],
      );
      const n = await tx.exec(`UPDATE users SET ${sql} WHERE id = $1`, [id, ...params]);
      if (!n) throw new NotFoundException('User not found');
      const after = await tx.one<Record<string, unknown>>(
        'SELECT email, full_name, role::text AS role, locale, is_active FROM users WHERE id = $1',
        [id],
      );
      const changed = AuditService.diff(before, after);
      await this.audit.record(tx, user, {
        action: 'user.manage',
        entityType: 'user',
        entityId: id,
        entityLabel: String(after?.email ?? ''),
        // A password change shows up as an action, never as a value.
        before: dto.password ? { ...changed?.before, password: '***' } : changed?.before,
        after: dto.password ? { ...changed?.after, password: '***' } : changed?.after,
      });
      return tx.one(`SELECT ${USER_COLUMNS} FROM users u JOIN branches b ON b.id = u.branch_id WHERE u.id = $1`, [id]);
    });
  }
}
