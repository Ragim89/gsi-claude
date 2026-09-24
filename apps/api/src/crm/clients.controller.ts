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
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsEmail, IsInt, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuthUser } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { DbService, Tx } from '../db/db.service';
import { buildSet } from '../common/sql';
import { AuditService } from '../common/audit.service';

export const CLIENT_COLUMNS = `
  c.id, c.branch_id AS "branchId", b.code AS "branchCode", c.name, c.gafta_fosfa_ref AS "gaftaFosfaRef",
  c.tax_id AS "taxId", c.country, c.address, c.contact_name AS "contactName",
  c.contact_email AS "contactEmail", c.contact_phone AS "contactPhone", c.notes,
  c.created_at AS "createdAt", c.updated_at AS "updatedAt"`;

class ClientFields {
  @IsOptional() @IsString() @MaxLength(100) gaftaFosfaRef?: string | null;
  @IsOptional() @IsString() @MaxLength(50) taxId?: string | null;
  @IsOptional() @IsString() @Length(2, 2) country?: string | null;
  @IsOptional() @IsString() @MaxLength(500) address?: string | null;
  @IsOptional() @IsString() @MaxLength(200) contactName?: string | null;
  @IsOptional() @IsEmail() contactEmail?: string | null;
  @IsOptional() @IsString() @MaxLength(50) contactPhone?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
}

class CreateClientDto extends ClientFields {
  @IsString() @MinLength(2) @MaxLength(300) name: string;
  /** Only HQ roles may create a client for another branch; others always get their own. */
  @IsOptional() @IsUUID() branchId?: string;
}

class UpdateClientDto extends ClientFields {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(300) name?: string;
}

class ClientQueryDto {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

const UPDATABLE = {
  name: 'name',
  gaftaFosfaRef: 'gafta_fosfa_ref',
  taxId: 'tax_id',
  country: 'country',
  address: 'address',
  contactName: 'contact_name',
  contactEmail: 'contact_email',
  contactPhone: 'contact_phone',
  notes: 'notes',
};

function emptyToNull<T extends object>(dto: T): T {
  const out: Record<string, unknown> = { ...(dto as Record<string, unknown>) };
  for (const k of Object.keys(out)) if (out[k] === '') out[k] = null;
  return out as T;
}

async function getClient(tx: Tx, id: string) {
  const row = await tx.one(
    `SELECT ${CLIENT_COLUMNS},
            (SELECT count(*)::int FROM inspection_jobs j WHERE j.client_id = c.id) AS "jobCount"
     FROM clients c JOIN branches b ON b.id = c.branch_id WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [id],
  );
  if (!row) throw new NotFoundException('Client not found');
  return row;
}

/**
 * CRM / Контрагенты. Branch isolation is enforced by RLS: users only ever see their branch.
 * ASSUMPTION: inspectors can read clients (needed on job cards) but only supervisors/admins edit.
 */
@Controller('clients')
export class ClientsController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /**
   * `branchId` lets an HQ user narrow the group view down to one branch.
   *
   * Paginated: the group already has hundreds of clients and a list screen has no business
   * pulling all of them. The response carries the total so the interface can show "1 of 12".
   */
  @Get()
  @RequirePermission('client.read')
  list(@CurrentUser() user: AuthUser, @Query() q: ClientQueryDto) {
    const search = q.search?.trim() || null;
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const params = [search, q.branchId || null];
    const where = `
      WHERE ($1::text IS NULL
             OR c.name ILIKE '%' || $1 || '%'
             OR c.gafta_fosfa_ref ILIKE '%' || $1 || '%'
             OR c.tax_id ILIKE '%' || $1 || '%')
        AND ($2::uuid IS NULL OR c.branch_id = $2::uuid)
        AND c.deleted_at IS NULL`;

    return this.db.tx(user, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.many(
          `SELECT ${CLIENT_COLUMNS},
                  (SELECT count(*)::int FROM inspection_jobs j WHERE j.client_id = c.id) AS "jobCount",
                  (SELECT count(*)::int FROM contracts ct WHERE ct.client_id = c.id AND ct.deleted_at IS NULL
                     AND ct.status = 'active') AS "activeContracts",
                  (SELECT p.full_name FROM client_contacts p
                    WHERE p.client_id = c.id AND p.is_primary AND p.deleted_at IS NULL) AS "primaryContact"
           FROM clients c JOIN branches b ON b.id = c.branch_id
           ${where}
           ORDER BY c.name
           LIMIT ${limit} OFFSET ${offset}`,
          params,
        ),
        tx.one<{ n: number }>(
          `SELECT count(*)::int AS n FROM clients c JOIN branches b ON b.id = c.branch_id ${where}`,
          params,
        ),
      ]);
      return { rows, total: total?.n ?? 0, limit, offset };
    });
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(user, (tx) => getClient(tx, id));
  }

  @Post()
  @RequirePermission('client.create')
  create(@CurrentUser() user: AuthUser, @Body() body: CreateClientDto) {
    const dto = emptyToNull(body);
    // Only a group-wide role may place a client in another office; everyone else gets their own.
    const branchId = user.scope === 'global' && dto.branchId ? dto.branchId : user.branchId;
    return this.db.tx(user, async (tx) => {
      const row = await tx.one<{ id: string }>(
        `INSERT INTO clients (branch_id, name, gafta_fosfa_ref, tax_id, country, address, contact_name,
                              contact_email, contact_phone, notes, created_by)
         VALUES ($1,$2,$3,$4,upper($5),$6,$7,$8,$9,$10,$11) RETURNING id`,
        [branchId, dto.name.trim(), dto.gaftaFosfaRef ?? null, dto.taxId ?? null, dto.country ?? null,
         dto.address ?? null, dto.contactName ?? null, dto.contactEmail ?? null, dto.contactPhone ?? null,
         dto.notes ?? null, user.id],
      );
      await this.audit.record(tx, user, {
        action: 'client.create',
        entityType: 'client',
        entityId: row!.id,
        entityLabel: dto.name.trim(),
        branchId,
        after: { name: dto.name.trim(), country: dto.country ?? null, taxId: dto.taxId ?? null },
      });
      return getClient(tx, row!.id);
    });
  }

  @Patch(':id')
  @RequirePermission('client.update')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateClientDto) {
    const dto = emptyToNull(body);
    if (dto.country) dto.country = dto.country.toUpperCase();
    const { sql, params } = buildSet(dto as Record<string, unknown>, UPDATABLE, 2);
    if (!sql) throw new BadRequestException('Nothing to update');
    return this.db.tx(user, async (tx) => {
      const before = await tx.one<Record<string, unknown>>(
        `SELECT name, gafta_fosfa_ref, tax_id, country, address, contact_name, contact_email, contact_phone, notes
         FROM clients WHERE id = $1`,
        [id],
      );
      const n = await tx.exec(`UPDATE clients SET ${sql} WHERE id = $1`, [id, ...params]);
      if (!n) throw new NotFoundException('Client not found');
      const after = await tx.one<Record<string, unknown>>(
        `SELECT name, gafta_fosfa_ref, tax_id, country, address, contact_name, contact_email, contact_phone, notes,
                branch_id
         FROM clients WHERE id = $1`,
        [id],
      );
      const changed = AuditService.diff(before, after);
      if (changed) {
        await this.audit.record(tx, user, {
          action: 'client.update',
          entityType: 'client',
          entityId: id,
          entityLabel: String(after?.name ?? ''),
          branchId: String(after?.branch_id ?? ''),
          before: changed.before,
          after: changed.after,
        });
      }
      return getClient(tx, id);
    });
  }

  /**
   * Archives the client: it disappears from lists and searches, while its jobs, reports and
   * invoices stay exactly where they are. Nothing is deleted — those documents are evidence.
   */
  @Delete(':id')
  @RequirePermission('client.archive')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.tx(user, async (tx) => {
      const row = await tx.one<{ name: string; branch_id: string }>(
        'SELECT name, branch_id FROM clients WHERE id = $1 AND deleted_at IS NULL',
        [id],
      );
      if (!row) throw new NotFoundException('Client not found');
      await tx.exec('UPDATE clients SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [id, user.id]);
      await this.audit.record(tx, user, {
        action: 'client.archive',
        entityType: 'client',
        entityId: id,
        entityLabel: row.name,
        branchId: row.branch_id,
      });
    }, { includeArchived: true });
  }
}
