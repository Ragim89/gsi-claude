import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { AuthUser, HQ_ROLES, Role, ROLES } from '@gsi/shared-types';
import { CurrentUser, Roles } from '../common/decorators';
import { DbService } from '../db/db.service';
import { buildSet } from '../common/sql';

const BRANCH_COLUMNS = `
  id, code, country, city, currency, locale, ui_locales AS "uiLocales", timezone,
  legal_name AS "legalName", address, phone, email, accreditation, is_hq AS "isHq",
  letterhead_template_id AS "letterheadTemplateId"`;

const USER_COLUMNS = `
  u.id, u.branch_id AS "branchId", b.code AS "branchCode", u.email, u.full_name AS "fullName",
  u.role, u.locale, u.is_active AS "isActive"`;

@Controller('branches')
export class BranchesController {
  constructor(private readonly db: DbService) {}

  /** RLS: branch users see their own branch, HQ sees all. */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.db.tx(user, (tx) => tx.many(`SELECT ${BRANCH_COLUMNS} FROM branches ORDER BY is_hq DESC, code`));
  }
}

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
  constructor(private readonly db: DbService) {}

  /** Supervisors need this to pick inspectors for assignment. */
  @Get()
  @Roles('supervisor', 'admin')
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
  @Roles('admin')
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
      return tx.one(`SELECT ${USER_COLUMNS} FROM users u JOIN branches b ON b.id = u.branch_id WHERE u.id = $1`, [row!.id]);
    });
  }

  @Patch(':id')
  @Roles('admin')
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
      const n = await tx.exec(`UPDATE users SET ${sql} WHERE id = $1`, [id, ...params]);
      if (!n) throw new NotFoundException('User not found');
      return tx.one(`SELECT ${USER_COLUMNS} FROM users u JOIN branches b ON b.id = u.branch_id WHERE u.id = $1`, [id]);
    });
  }
}
