import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { AuthUser, Branch } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { DbService, Tx } from '../db/db.service';
import { StorageService } from '../storage/storage.service';
import { buildSet } from '../common/sql';
import { config } from '../config';

const BRANCH_COLUMNS = `
  b.id, b.code, b.country, b.city, b.currency, b.locale, b.ui_locales AS "uiLocales", b.timezone,
  b.legal_name AS "legalName", b.address, b.phone, b.email, b.accreditation, b.is_hq AS "isHq",
  b.letterhead_template_id AS "letterheadTemplateId", b.legal_form AS "legalForm",
  b.registration_no AS "registrationNo", b.tax_id AS "taxId", b.vat_number AS "vatNumber",
  b.bank_name AS "bankName", b.bank_account AS "bankAccount", b.bank_swift AS "bankSwift",
  b.website, b.established_year AS "establishedYear", b.description,
  b.head_user_id AS "headUserId", b.head_title AS "headTitle",
  b.head_photo_key AS "headPhotoKey", b.photo_key AS "photoKey",
  h.full_name AS "headName", h.email AS "headEmail", h.role AS "headRole"`;

const BRANCH_FROM = 'branches b LEFT JOIN users h ON h.id = b.head_user_id';

type BranchRow = Branch & { headPhotoKey: string | null; photoKey: string | null };

class UpdateBranchDto {
  @IsOptional() @IsString() @MaxLength(300) legalName?: string;
  @IsOptional() @IsString() @MaxLength(50) legalForm?: string | null;
  @IsOptional() @IsString() @MaxLength(500) address?: string | null;
  @IsOptional() @IsString() @MaxLength(50) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(200) email?: string | null;
  @IsOptional() @IsString() @MaxLength(200) website?: string | null;
  @IsOptional() @IsString() @MaxLength(100) registrationNo?: string | null;
  @IsOptional() @IsString() @MaxLength(100) taxId?: string | null;
  @IsOptional() @IsString() @MaxLength(100) vatNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(200) bankName?: string | null;
  @IsOptional() @IsString() @MaxLength(100) bankAccount?: string | null;
  @IsOptional() @IsString() @MaxLength(20) bankSwift?: string | null;
  @IsOptional() @IsString() @MaxLength(300) accreditation?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1900) @Max(2100) establishedYear?: number | null;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsOptional() @IsUUID() headUserId?: string | null;
  @IsOptional() @IsString() @MaxLength(100) headTitle?: string | null;
}

const UPDATABLE = {
  legalName: 'legal_name',
  legalForm: 'legal_form',
  address: 'address',
  phone: 'phone',
  email: 'email',
  website: 'website',
  registrationNo: 'registration_no',
  taxId: 'tax_id',
  vatNumber: 'vat_number',
  bankName: 'bank_name',
  bankAccount: 'bank_account',
  bankSwift: 'bank_swift',
  accreditation: 'accreditation',
  establishedYear: 'established_year',
  description: 'description',
  headUserId: 'head_user_id',
  headTitle: 'head_title',
};

const ALLOWED_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Branches: list, comparison, the branch card and its editable profile. */
@Controller('branches')
export class BranchesController {
  constructor(private readonly db: DbService, private readonly storage: StorageService) {}

  /** RLS: branch users see their own branch, HQ sees all. */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.db.tx(user, (tx) =>
      tx.many(`SELECT ${BRANCH_COLUMNS} FROM ${BRANCH_FROM} ORDER BY b.is_hq DESC, b.code`),
    );
  }

  /**
   * Branch-by-branch comparison for HQ: the same metrics per entity, side by side.
   * Declared before ':id' so the path is not swallowed by the parameter route.
   */
  @Get('comparison/summary')
  @RequirePermission('dashboard.read')
  comparison(@CurrentUser() user: AuthUser, @Query('from') from?: string, @Query('to') to?: string) {
    const period = { from: from ?? defaultFrom(), to: to ?? new Date().toISOString().slice(0, 10) };
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

  /** Branch card: requisites, the head of the entity, the team and the workload. */
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(user, async (tx) => {
      const branch = await this.load(tx, id);
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

  @Patch(':id')
  @RequirePermission('branch.manage')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBranchDto) {
    const patch: Record<string, unknown> = { ...dto };
    for (const k of Object.keys(patch)) if (patch[k] === '') patch[k] = null;
    const { sql, params } = buildSet(patch, UPDATABLE, 2);
    if (!sql) throw new BadRequestException('Nothing to update');
    return this.db.tx(user, async (tx) => {
      const n = await tx.exec(`UPDATE branches SET ${sql} WHERE id = $1`, [id, ...params]);
      if (!n) throw new NotFoundException('Branch not found');
      return this.load(tx, id);
    });
  }

  /** Photo of the branch office / team. */
  @Post(':id/photo')
  @RequirePermission('branch.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  photo(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File) {
    return this.uploadImage(user, id, file, 'photo_key', { width: 1400, height: 800 });
  }

  /** Portrait of the person heading the branch. */
  @Post(':id/head-photo')
  @RequirePermission('branch.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  headPhoto(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File) {
    return this.uploadImage(user, id, file, 'head_photo_key', { width: 600, height: 600 });
  }

  private async uploadImage(
    user: AuthUser,
    id: string,
    file: Express.Multer.File,
    column: 'photo_key' | 'head_photo_key',
    size: { width: number; height: number },
  ) {
    if (!file) throw new BadRequestException('File is required');
    if (!ALLOWED_IMAGE.has(file.mimetype)) throw new BadRequestException(`Unsupported file type ${file.mimetype}`);
    const jpeg = await sharp(file.buffer)
      .rotate()
      .resize(size.width, size.height, { fit: 'cover' })
      .jpeg({ quality: 82 })
      .toBuffer();

    return this.db.tx(user, async (tx) => {
      const branch = await tx.one<{ code: string; old: string | null }>(
        `SELECT code, ${column} AS old FROM branches WHERE id = $1`,
        [id],
      );
      if (!branch) throw new NotFoundException('Branch not found');
      const key = `branches/${branch.code}/${column === 'photo_key' ? 'office' : 'head'}-${randomUUID()}.jpg`;
      await this.storage.put(key, jpeg, 'image/jpeg', { 'uploaded-by': user.id });
      await tx.exec(`UPDATE branches SET ${column} = $2 WHERE id = $1`, [id, key]);
      // Replacing a photo removes the previous object; nothing else references it.
      if (branch.old) await this.storage.delete(branch.old).catch(() => undefined);
      return this.load(tx, id);
    });
  }

  private async load(tx: Tx, id: string): Promise<Branch> {
    const row = await tx.one<BranchRow>(`SELECT ${BRANCH_COLUMNS} FROM ${BRANCH_FROM} WHERE b.id = $1`, [id]);
    if (!row) throw new NotFoundException('Branch not found');
    const { headPhotoKey, photoKey, ...branch } = row;
    const [headPhotoUrl, photoUrl] = await Promise.all([
      headPhotoKey ? this.storage.presignGet(headPhotoKey) : Promise.resolve(null),
      photoKey ? this.storage.presignGet(photoKey) : Promise.resolve(null),
    ]);
    return { ...branch, headPhotoUrl, photoUrl };
  }
}

/** Default comparison window: the last 12 calendar months. */
function defaultFrom(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 11);
  return d.toISOString().slice(0, 10);
}
