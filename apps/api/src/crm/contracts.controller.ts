import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { AuthUser, CONTRACT_STATUSES, Contract, ContractStatus, Page, SERVICE_TYPES, ServiceType } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { DbService, Tx } from '../db/db.service';
import { StorageService } from '../storage/storage.service';
import { AuditService } from '../common/audit.service';
import { buildSet } from '../common/sql';
import { config } from '../config';

class ContractFields {
  @IsOptional() @IsString() @MaxLength(200) title?: string | null;
  @IsOptional() @IsIn(CONTRACT_STATUSES) status?: ContractStatus;
  @IsOptional() @IsDateString() signedOn?: string | null;
  @IsOptional() @IsDateString() validFrom?: string | null;
  @IsOptional() @IsDateString() validTo?: string | null;
  @IsOptional() @IsString() @Length(3, 3) currency?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) valueAmount?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) paymentTermsDays?: number | null;
  @IsOptional() @IsString() @MaxLength(30) incoterms?: string | null;
  @IsOptional() @IsArray() @ArrayUnique() @IsIn(SERVICE_TYPES, { each: true }) services?: ServiceType[];
  @IsOptional() @IsUUID() commodityId?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
}

class CreateContractDto extends ContractFields {
  @IsUUID() clientId: string;
  @IsString() @MinLength(1) @MaxLength(100) contractNo: string;
}

class UpdateContractDto extends ContractFields {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) contractNo?: string;
}

class ContractQueryDto {
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsIn(CONTRACT_STATUSES) status?: ContractStatus;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  /** Contracts running out within N days — the list operations chases before renewal. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(365) expiringInDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

const COLUMNS = `
  ct.id, ct.branch_id AS "branchId", b.code AS "branchCode", ct.client_id AS "clientId", c.name AS "clientName",
  ct.contract_no AS "contractNo", ct.title, ct.status, to_char(ct.signed_on, 'YYYY-MM-DD') AS "signedOn",
  to_char(ct.valid_from, 'YYYY-MM-DD') AS "validFrom", to_char(ct.valid_to, 'YYYY-MM-DD') AS "validTo",
  ct.currency, ct.value_amount::float8 AS "valueAmount", ct.payment_terms_days AS "paymentTermsDays",
  ct.incoterms, COALESCE(ct.services, ARRAY[]::text[]) AS services, ct.commodity_id AS "commodityId",
  ct.notes, ct.file_name AS "fileName", ct.file_size AS "fileSize", ct.file_storage_key AS "fileStorageKey",
  (SELECT count(*)::int FROM inspection_jobs j WHERE j.contract_id = ct.id) AS "jobCount",
  CASE WHEN ct.valid_to IS NOT NULL THEN (ct.valid_to - current_date) END AS "daysToExpiry",
  ct.created_at AS "createdAt"`;

const FROM = `
  contracts ct
  JOIN clients c ON c.id = ct.client_id
  JOIN branches b ON b.id = ct.branch_id`;

/** Contract documents people actually attach: the signed PDF, or a scan of it. */
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

/**
 * Contracts a client's work is performed under: what services they cover, the payment terms
 * invoicing should use, and the signed document itself.
 *
 * A job keeps its free-text contract number — not every job has a contract on file — and may
 * additionally point at the contract record.
 */
@Controller('contracts')
export class ContractsController {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission('contract.read')
  async list(@CurrentUser() user: AuthUser, @Query() q: ContractQueryDto): Promise<Page<Contract>> {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const params = [
      q.clientId ?? null,
      q.branchId ?? null,
      q.status ?? null,
      q.search?.trim() || null,
      q.expiringInDays ?? null,
    ];
    const where = `
      WHERE ($1::uuid IS NULL OR ct.client_id = $1::uuid)
        AND ($2::uuid IS NULL OR ct.branch_id = $2::uuid)
        AND ($3::contract_status IS NULL OR ct.status = $3::contract_status)
        AND ($4::text IS NULL OR ct.contract_no ILIKE '%' || $4 || '%' OR ct.title ILIKE '%' || $4 || '%'
             OR c.name ILIKE '%' || $4 || '%')
        AND ($5::int IS NULL OR (ct.valid_to IS NOT NULL AND ct.valid_to <= current_date + $5::int))`;

    return this.db.tx(user, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.many<Contract>(
          `SELECT ${COLUMNS} FROM ${FROM} ${where}
           ORDER BY ct.valid_to NULLS LAST, ct.contract_no
           LIMIT ${limit} OFFSET ${offset}`,
          params,
        ),
        tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${FROM} ${where}`, params),
      ]);
      return { rows: await Promise.all(rows.map((r) => this.sign(r))), total: total?.n ?? 0, limit, offset };
    });
  }

  @Get(':id')
  @RequirePermission('contract.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(user, (tx) => this.load(tx, id));
  }

  @Post()
  @RequirePermission('contract.manage')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateContractDto) {
    return this.db.tx(user, async (tx) => {
      const client = await tx.one<{ name: string; branch_id: string }>(
        'SELECT name, branch_id FROM clients WHERE id = $1',
        [dto.clientId],
      );
      if (!client) throw new NotFoundException('Client not found');

      const row = await tx.one<{ id: string }>(
        `INSERT INTO contracts (client_id, contract_no, title, status, signed_on, valid_from, valid_to,
                                currency, value_amount, payment_terms_days, incoterms, services,
                                commodity_id, notes, created_by)
         VALUES ($1,$2,$3,COALESCE($4::contract_status,'draft'),$5::date,$6::date,$7::date,
                 upper($8),$9,$10,$11,$12::text[],$13,$14,$15)
         RETURNING id`,
        [dto.clientId, dto.contractNo.trim(), dto.title ?? null, dto.status ?? null, dto.signedOn ?? null,
         dto.validFrom ?? null, dto.validTo ?? null, dto.currency ?? null, dto.valueAmount ?? null,
         dto.paymentTermsDays ?? null, dto.incoterms ?? null, dto.services ?? null, dto.commodityId ?? null,
         dto.notes ?? null, user.id],
      );
      await this.audit.record(tx, user, {
        action: 'contract.manage',
        entityType: 'contract',
        entityId: row!.id,
        entityLabel: `${client.name} — ${dto.contractNo.trim()}`,
        branchId: client.branch_id,
        after: { contractNo: dto.contractNo.trim(), status: dto.status ?? 'draft', validTo: dto.validTo ?? null },
      });
      return this.load(tx, row!.id);
    });
  }

  @Patch(':id')
  @RequirePermission('contract.manage')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateContractDto) {
    const { sql, params } = buildSet(dto as Record<string, unknown>, {
      contractNo: 'contract_no',
      title: 'title',
      status: 'status',
      signedOn: 'signed_on',
      validFrom: 'valid_from',
      validTo: 'valid_to',
      currency: 'currency',
      valueAmount: 'value_amount',
      paymentTermsDays: 'payment_terms_days',
      incoterms: 'incoterms',
      services: 'services',
      commodityId: 'commodity_id',
      notes: 'notes',
    }, 2);
    if (!sql) throw new BadRequestException('Nothing to update');
    return this.db.tx(user, async (tx) => {
      const before = await this.load(tx, id);
      await tx.exec(`UPDATE contracts SET ${sql} WHERE id = $1`, [id, ...params]);
      const after = await this.load(tx, id);
      const changed = AuditService.diff(
        before as unknown as Record<string, unknown>,
        after as unknown as Record<string, unknown>,
      );
      await this.audit.record(tx, user, {
        action: 'contract.manage',
        entityType: 'contract',
        entityId: id,
        entityLabel: `${after.clientName} — ${after.contractNo}`,
        branchId: after.branchId,
        before: changed?.before,
        after: changed?.after,
      });
      return after;
    });
  }

  /** The signed document. Replacing it removes the previous file from storage. */
  @Post(':id/file')
  @RequirePermission('contract.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: config.maxUploadBytes, files: 1 } }))
  async upload(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('File is required');
    if (!ALLOWED_MIME.has(file.mimetype)) throw new BadRequestException(`Unsupported file type ${file.mimetype}`);

    const contract = await this.db.tx(user, (tx) => this.load(tx, id));
    const key = `contracts/${contract.branchCode}/${id}/${Date.now()}-${safeName(file.originalname)}`;
    await this.storage.put(key, file.buffer, file.mimetype, { 'uploaded-by': user.id });

    return this.db.tx(user, async (tx) => {
      const previous = await tx.one<{ file_storage_key: string | null }>(
        'SELECT file_storage_key FROM contracts WHERE id = $1',
        [id],
      );
      await tx.exec(
        'UPDATE contracts SET file_storage_key = $2, file_name = $3, file_size = $4 WHERE id = $1',
        [id, key, file.originalname.slice(0, 200), file.size],
      );
      await this.audit.record(tx, user, {
        action: 'contract.manage',
        entityType: 'contract',
        entityId: id,
        entityLabel: `${contract.clientName} — ${contract.contractNo}`,
        branchId: contract.branchId,
        after: { fileName: file.originalname, fileSize: file.size },
      });
      // Only after the row points at the new file: an orphaned object is recoverable,
      // a row pointing at a deleted one is not.
      if (previous?.file_storage_key) await this.storage.delete(previous.file_storage_key).catch(() => undefined);
      return this.load(tx, id);
    });
  }

  @Get(':id/file')
  @RequirePermission('contract.read')
  async download(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const contract = await this.db.tx(user, (tx) =>
      tx.one<{ key: string | null; name: string | null }>(
        'SELECT file_storage_key AS key, file_name AS name FROM contracts WHERE id = $1',
        [id],
      ),
    );
    if (!contract?.key) throw new NotFoundException('No document attached to this contract');
    const body = await this.storage.getBuffer(contract.key);
    return new StreamableFile(body, {
      type: 'application/octet-stream',
      disposition: `attachment; filename="${contract.name ?? 'contract'}"`,
    });
  }

  /** Archives the contract; jobs performed under it keep their reference. */
  @Delete(':id')
  @RequirePermission('contract.manage')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.tx(
      user,
      async (tx) => {
        const contract = await this.load(tx, id);
        await tx.exec('UPDATE contracts SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [id, user.id]);
        await this.audit.record(tx, user, {
          action: 'contract.manage',
          entityType: 'contract',
          entityId: id,
          entityLabel: `${contract.clientName} — ${contract.contractNo}`,
          branchId: contract.branchId,
          before: { status: contract.status },
          metadata: { archived: true },
        });
      },
      { includeArchived: true },
    );
  }

  private async load(tx: Tx, id: string): Promise<Contract & { fileStorageKey?: string | null }> {
    const row = await tx.one<Contract & { fileStorageKey?: string | null }>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE ct.id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('Contract not found');
    return this.sign(row);
  }

  /** Attachments are private; the interface gets a short-lived link. */
  private async sign<T extends Contract & { fileStorageKey?: string | null }>(row: T): Promise<T> {
    const { fileStorageKey, ...rest } = row;
    const fileUrl = fileStorageKey ? await this.storage.presignGet(fileStorageKey, row.fileName ?? undefined) : null;
    return { ...(rest as T), fileUrl };
  }
}

function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 80);
}
