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
} from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthUser, ClientContact } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { DbService, Tx } from '../db/db.service';
import { AuditService } from '../common/audit.service';
import { buildSet } from '../common/sql';

class ContactFields {
  @IsOptional() @IsString() @MaxLength(100) position?: string | null;
  @IsOptional() @IsEmail() email?: string | null;
  @IsOptional() @IsString() @MaxLength(50) phone?: string | null;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string | null;
}

class CreateContactDto extends ContactFields {
  @IsString() @MinLength(2) @MaxLength(200) fullName: string;
}

class UpdateContactDto extends ContactFields {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) fullName?: string;
}

const COLUMNS = `
  id, branch_id AS "branchId", client_id AS "clientId", full_name AS "fullName", position,
  email, phone, is_primary AS "isPrimary", notes, created_at AS "createdAt"`;

/**
 * The people at a client. An inspection company writes to operations about a nomination, to
 * documentation about a certificate and to accounts about an invoice — one contact field on
 * the client was never enough.
 */
@Controller('clients/:clientId/contacts')
export class ClientContactsController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('client.read')
  list(@CurrentUser() user: AuthUser, @Param('clientId', ParseUUIDPipe) clientId: string) {
    return this.db.tx(user, (tx) =>
      tx.many<ClientContact>(
        `SELECT ${COLUMNS} FROM client_contacts
         WHERE client_id = $1 AND deleted_at IS NULL
         ORDER BY is_primary DESC, full_name`,
        [clientId],
      ),
    );
  }

  @Post()
  @RequirePermission('client.update')
  create(
    @CurrentUser() user: AuthUser,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Body() dto: CreateContactDto,
  ) {
    return this.db.tx(user, async (tx) => {
      const client = await this.loadClient(tx, clientId);
      if (dto.isPrimary) await this.clearPrimary(tx, clientId);
      const row = await tx.one<{ id: string }>(
        `INSERT INTO client_contacts (client_id, full_name, position, email, phone, is_primary, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6, false),$7,$8) RETURNING id`,
        [clientId, dto.fullName.trim(), dto.position ?? null, dto.email ?? null, dto.phone ?? null,
         dto.isPrimary ?? null, dto.notes ?? null, user.id],
      );
      await this.audit.record(tx, user, {
        action: 'client.update',
        entityType: 'client_contact',
        entityId: row!.id,
        entityLabel: `${client.name} — ${dto.fullName.trim()}`,
        branchId: client.branch_id,
        after: { fullName: dto.fullName.trim(), email: dto.email ?? null, isPrimary: dto.isPrimary ?? false },
      });
      return this.load(tx, row!.id);
    });
  }

  @Patch(':id')
  @RequirePermission('client.update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateContactDto,
  ) {
    const { sql, params } = buildSet(dto as Record<string, unknown>, {
      fullName: 'full_name',
      position: 'position',
      email: 'email',
      phone: 'phone',
      isPrimary: 'is_primary',
      notes: 'notes',
    }, 2);
    if (!sql) throw new BadRequestException('Nothing to update');
    return this.db.tx(user, async (tx) => {
      const before = await this.load(tx, id);
      if (!before || before.clientId !== clientId) throw new NotFoundException('Contact not found');
      if (dto.isPrimary) await this.clearPrimary(tx, clientId, id);
      await tx.exec(`UPDATE client_contacts SET ${sql} WHERE id = $1`, [id, ...params]);
      const after = await this.load(tx, id);
      const changed = AuditService.diff(
        before as unknown as Record<string, unknown>,
        after as unknown as Record<string, unknown>,
      );
      await this.audit.record(tx, user, {
        action: 'client.update',
        entityType: 'client_contact',
        entityId: id,
        entityLabel: after!.fullName,
        branchId: after!.branchId,
        before: changed?.before,
        after: changed?.after,
      });
      return after;
    });
  }

  @Delete(':id')
  @RequirePermission('client.update')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.db.tx(
      user,
      async (tx) => {
        const contact = await this.load(tx, id);
        if (!contact || contact.clientId !== clientId) throw new NotFoundException('Contact not found');
        await tx.exec('UPDATE client_contacts SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [id, user.id]);
        await this.audit.record(tx, user, {
          action: 'client.update',
          entityType: 'client_contact',
          entityId: id,
          entityLabel: contact.fullName,
          branchId: contact.branchId,
          before: { fullName: contact.fullName, email: contact.email },
          metadata: { archived: true },
        });
      },
      { includeArchived: true },
    );
  }

  private load(tx: Tx, id: string) {
    return tx.one<ClientContact>(`SELECT ${COLUMNS} FROM client_contacts WHERE id = $1`, [id]);
  }

  private async loadClient(tx: Tx, clientId: string) {
    // RLS makes a client outside the caller's scope invisible, so this is the access check too.
    const client = await tx.one<{ name: string; branch_id: string }>(
      'SELECT name, branch_id FROM clients WHERE id = $1',
      [clientId],
    );
    if (!client) throw new NotFoundException('Client not found');
    return client;
  }

  /** Only one primary contact per client; the unique index enforces it, this makes room. */
  private clearPrimary(tx: Tx, clientId: string, exceptId?: string) {
    return tx.exec(
      `UPDATE client_contacts SET is_primary = false
       WHERE client_id = $1 AND is_primary AND deleted_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
      [clientId, exceptId ?? null],
    );
  }
}
