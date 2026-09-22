import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { AuthUser, HQ_ROLES, Role, ROLES } from '@gsi/shared-types';
import { CurrentUser, Roles } from '../common/decorators';
import { DbService } from '../db/db.service';
import { buildSet } from '../common/sql';
import { config } from '../config';

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

  /**
   * Branch-by-branch comparison for HQ: the same metrics per entity, side by side
   * ("каждую точку отдельно" — but also all of them against each other).
   */
  @Get('comparison/summary')
  @Roles('cfo', 'admin', 'finance_controller', 'supervisor')
  comparison(@CurrentUser() user: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    const period = {
      from: from ?? defaultFrom(),
      to: to ?? new Date().toISOString().slice(0, 10),
    };
    return this.db.tx(user, async (tx) => {
      const rows = await tx.many(
        `SELECT b.id AS "branchId", b.code, b.country, b.city, b.currency, b.is_hq AS "isHq",
                COALESCE(-SUM(a.amount_base) FILTER (WHERE a.account_group = 'revenue'
                         AND a.entry_date BETWEEN $1::date AND $2::date), 0)::float8 AS "revenueBase",
                COALESCE(SUM(a.amount_base) FILTER (WHERE a.account_group = 'expense'
                         AND a.entry_date BETWEEN $1::date AND $2::date), 0)::float8 AS "expenseBase",
                COALESCE(SUM(a.amount_base) FILTER (WHERE a.account_group = 'receivable'), 0)::float8 AS "receivableBase",
                (SELECT count(*) FROM inspection_jobs j WHERE j.branch_id = b.id
                   AND j.created_at::date BETWEEN $1::date AND $2::date)::int AS "jobCount",
                (SELECT count(*) FROM reports r WHERE r.branch_id = b.id
                   AND r.created_at::date BETWEEN $1::date AND $2::date)::int AS "reportCount",
                (SELECT count(*) FROM users u WHERE u.branch_id = b.id AND u.role = 'inspector' AND u.is_active)::int
                  AS "inspectorCount",
                (SELECT avg(EXTRACT(EPOCH FROM (r.created_at - j.created_at)) / 86400)
                   FROM reports r JOIN inspection_jobs j ON j.id = r.job_id
                  WHERE r.branch_id = b.id AND r.created_at::date BETWEEN $1::date AND $2::date)::float8
                  AS "avgCycleDays",
                (SELECT COALESCE(SUM((i.amount_total - i.amount_paid)
                          * fx_rate_on(i.currency, $3, i.issue_date)), 0)
                   FROM invoices i WHERE i.branch_id = b.id
                     AND i.status IN ('issued', 'partially_paid') AND i.due_date < current_date)::float8
                  AS "overdueBase"
         FROM branches b
         LEFT JOIN finance_daily_agg a ON a.branch_id = b.id
         GROUP BY b.id, b.code, b.country, b.city, b.currency, b.is_hq
         ORDER BY "revenueBase" DESC, b.code`,
        [period.from, period.to, config.consolidationCurrency],
      );
      return { baseCurrency: config.consolidationCurrency, period, branches: rows };
    });
  }

  /** Branch card: requisites plus its people, clients and workload at a glance. */
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(user, async (tx) => {
      const branch = await tx.one(`SELECT ${BRANCH_COLUMNS} FROM branches WHERE id = $1`, [id]);
      if (!branch) throw new NotFoundException('Branch not found');
      const [team, stats] = await Promise.all([
        tx.many(
          `SELECT id, full_name AS "fullName", role, email, is_active AS "isActive"
           FROM users WHERE branch_id = $1 ORDER BY role, full_name`,
          [id],
        ),
        tx.one(
          `SELECT
             (SELECT count(*) FROM clients WHERE branch_id = $1)::int AS "clientCount",
             (SELECT count(*) FROM inspection_jobs WHERE branch_id = $1)::int AS "jobCount",
             (SELECT count(*) FROM inspection_jobs WHERE branch_id = $1
                AND status NOT IN ('approved', 'cancelled'))::int AS "openJobCount",
             (SELECT count(*) FROM reports WHERE branch_id = $1)::int AS "reportCount",
             (SELECT count(*) FROM users WHERE branch_id = $1 AND is_active)::int AS "activeUserCount"`,
          [id],
        ),
      ]);
      return { ...branch, team, stats };
    });
  }

}

/** Default comparison window: the last 12 calendar months. */
function defaultFrom(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 11);
  return d.toISOString().slice(0, 10);
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
