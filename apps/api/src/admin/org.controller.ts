import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, MaxLength, MinLength } from 'class-validator';
import { AuthUser, DEPARTMENT_KINDS, DepartmentKind } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { DbService } from '../db/db.service';
import { AuditService } from '../common/audit.service';
import { buildSet } from '../common/sql';

class CountryDto {
  @IsString() @Length(2, 2) code: string;
  @IsString() @MinLength(2) @MaxLength(100) name: string;
  @IsOptional() @IsString() @MaxLength(10) locale?: string;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
}

class UpdateCountryDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(10) locale?: string;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class DepartmentDto {
  @IsUUID() branchId: string;
  @IsString() @MinLength(2) @MaxLength(30) code: string;
  @IsString() @MinLength(2) @MaxLength(100) name: string;
  @IsIn(DEPARTMENT_KINDS) kind: DepartmentKind;
  @IsOptional() @IsUUID() headUserId?: string | null;
}

class UpdateDepartmentDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(100) name?: string;
  @IsOptional() @IsIn(DEPARTMENT_KINDS) kind?: DepartmentKind;
  @IsOptional() @IsUUID() headUserId?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/**
 * The shape of the group: organisation → country → office → department.
 *
 * Offices themselves live in the branches controller, because that is where their requisites,
 * letterhead and accounting currency already are.
 */
@Controller('org')
export class OrgController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  @Get()
  organization(@CurrentUser() user: AuthUser) {
    return this.db.tx(user, (tx) =>
      tx.one(
        `SELECT id, code, name, legal_name AS "legalName", base_currency AS "baseCurrency", website
         FROM organizations ORDER BY code LIMIT 1`,
      ),
    );
  }

  @Get('countries')
  countries(@CurrentUser() user: AuthUser) {
    return this.db.tx(user, (tx) =>
      tx.many(
        `SELECT c.id, c.organization_id AS "organizationId", c.code, c.name, c.locale, c.timezone,
                c.is_active AS "isActive",
                (SELECT count(*)::int FROM branches b WHERE b.country_id = c.id) AS offices
         FROM countries c ORDER BY c.name`,
      ),
    );
  }

  @Post('countries')
  @RequirePermission('org.manage')
  createCountry(@CurrentUser() user: AuthUser, @Body() dto: CountryDto) {
    return this.db.tx(user, async (tx) => {
      const org = await tx.one<{ id: string }>('SELECT id FROM organizations ORDER BY code LIMIT 1');
      if (!org) throw new NotFoundException('Organization not found');
      const row = await tx.one<{ id: string }>(
        `INSERT INTO countries (organization_id, code, name, locale, timezone)
         VALUES ($1, upper($2), $3, $4, $5) RETURNING id`,
        [org.id, dto.code, dto.name.trim(), dto.locale ?? null, dto.timezone ?? null],
      );
      await this.audit.record(tx, user, {
        action: 'org.manage',
        entityType: 'country',
        entityId: row!.id,
        entityLabel: dto.name.trim(),
        after: { code: dto.code.toUpperCase(), name: dto.name.trim() },
      });
      return tx.one('SELECT id, code, name, locale, timezone FROM countries WHERE id = $1', [row!.id]);
    });
  }

  @Patch('countries/:id')
  @RequirePermission('org.manage')
  updateCountry(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCountryDto) {
    const { sql, params } = buildSet(dto as Record<string, unknown>, {
      name: 'name',
      locale: 'locale',
      timezone: 'timezone',
      isActive: 'is_active',
    }, 2);
    if (!sql) throw new NotFoundException('Nothing to update');
    return this.db.tx(user, async (tx) => {
      const before = await tx.one<Record<string, unknown>>(
        'SELECT name, locale, timezone, is_active FROM countries WHERE id = $1',
        [id],
      );
      if (!before) throw new NotFoundException('Country not found');
      await tx.exec(`UPDATE countries SET ${sql} WHERE id = $1`, [id, ...params]);
      const after = await tx.one<Record<string, unknown>>(
        'SELECT name, locale, timezone, is_active FROM countries WHERE id = $1',
        [id],
      );
      const changed = AuditService.diff(before, after);
      await this.audit.record(tx, user, {
        action: 'org.manage',
        entityType: 'country',
        entityId: id,
        entityLabel: String(after?.name ?? ''),
        before: changed?.before,
        after: changed?.after,
      });
      return { id, ...after };
    });
  }

  @Get('departments')
  departments(@CurrentUser() user: AuthUser, @Query('branchId') branchId?: string) {
    return this.db.tx(user, (tx) =>
      tx.many(
        `SELECT d.id, d.branch_id AS "branchId", b.code AS "branchCode", d.code, d.name, d.kind::text AS kind,
                d.head_user_id AS "headUserId", u.full_name AS "headName", d.is_active AS "isActive",
                (SELECT count(*)::int FROM users x WHERE x.department_id = d.id) AS users
         FROM departments d
         JOIN branches b ON b.id = d.branch_id
         LEFT JOIN users u ON u.id = d.head_user_id
         WHERE ($1::uuid IS NULL OR d.branch_id = $1::uuid)
         ORDER BY b.code, d.name`,
        [branchId || null],
      ),
    );
  }

  @Post('departments')
  @RequirePermission('org.manage')
  createDepartment(@CurrentUser() user: AuthUser, @Body() dto: DepartmentDto) {
    return this.db.tx(user, async (tx) => {
      const row = await tx.one<{ id: string }>(
        `INSERT INTO departments (branch_id, code, name, kind, head_user_id)
         VALUES ($1, $2, $3, $4::department_kind, $5) RETURNING id`,
        [dto.branchId, dto.code.trim(), dto.name.trim(), dto.kind, dto.headUserId ?? null],
      );
      await this.audit.record(tx, user, {
        action: 'org.manage',
        entityType: 'department',
        entityId: row!.id,
        entityLabel: dto.name.trim(),
        branchId: dto.branchId,
        after: { code: dto.code.trim(), name: dto.name.trim(), kind: dto.kind },
      });
      return tx.one(
        `SELECT id, branch_id AS "branchId", code, name, kind::text AS kind, is_active AS "isActive"
         FROM departments WHERE id = $1`,
        [row!.id],
      );
    });
  }

  @Patch('departments/:id')
  @RequirePermission('org.manage')
  updateDepartment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDepartmentDto,
  ) {
    const { sql, params } = buildSet(dto as Record<string, unknown>, {
      name: 'name',
      kind: 'kind',
      headUserId: 'head_user_id',
      isActive: 'is_active',
    }, 2);
    if (!sql) throw new NotFoundException('Nothing to update');
    return this.db.tx(user, async (tx) => {
      const before = await tx.one<Record<string, unknown>>(
        'SELECT name, kind::text AS kind, head_user_id, is_active, branch_id FROM departments WHERE id = $1',
        [id],
      );
      if (!before) throw new NotFoundException('Department not found');
      await tx.exec(`UPDATE departments SET ${sql} WHERE id = $1`, [id, ...params]);
      const after = await tx.one<Record<string, unknown>>(
        'SELECT name, kind::text AS kind, head_user_id, is_active FROM departments WHERE id = $1',
        [id],
      );
      const changed = AuditService.diff(before, after);
      await this.audit.record(tx, user, {
        action: 'org.manage',
        entityType: 'department',
        entityId: id,
        entityLabel: String(after?.name ?? ''),
        branchId: String(before.branch_id),
        before: changed?.before,
        after: changed?.after,
      });
      return { id, ...after };
    });
  }
}
