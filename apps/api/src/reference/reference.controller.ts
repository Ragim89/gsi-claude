import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { AuthUser, COMMODITY_GROUPS, CommodityGroup, LocalizedText } from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { DbService } from '../db/db.service';
import { buildSet } from '../common/sql';

const COMMODITY_COLUMNS = `
  id, code, "group", name, hs_code AS "hsCode", lab_methods AS "labMethods",
  is_active AS "isActive", sort_order AS "sortOrder"`;

const PORT_COLUMNS = `id, code, name, country, is_inland AS "isInland", is_active AS "isActive"`;

class CommodityDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60) code?: string;
  @IsOptional() @IsIn(COMMODITY_GROUPS) group?: CommodityGroup;
  @IsOptional() @IsObject() name?: LocalizedText;
  @IsOptional() @IsString() @MaxLength(20) hsCode?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
}

class PortDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(10) code?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @Length(2, 2) country?: string;
  @IsOptional() @IsBoolean() isInland?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

/**
 * Group-wide reference data: the commodities (cultures) inspected and analysed, and the
 * ports / terminals where inspections happen. Everyone reads them — every filter and every
 * report groups by them — and only admins edit them.
 */
@Controller('reference')
export class ReferenceController {
  constructor(private readonly db: DbService) {}

  @Get('commodities')
  commodities(@CurrentUser() user: AuthUser, @Query('all') all?: string, @Query('group') group?: string) {
    return this.db.tx(user, (tx) =>
      tx.many(
        `SELECT ${COMMODITY_COLUMNS},
                (SELECT count(*) FROM inspection_jobs j WHERE j.commodity_id = c.id)::int AS "jobCount"
         FROM commodities c
         WHERE ($1::boolean IS TRUE OR c.is_active)
           AND ($2::commodity_group IS NULL OR c."group" = $2::commodity_group)
         ORDER BY c.sort_order, c.name->>'en'`,
        [all === 'true', group || null],
      ),
    );
  }

  @Post('commodities')
  @RequirePermission('reference.manage')
  createCommodity(@CurrentUser() user: AuthUser, @Body() dto: CommodityDto) {
    const { code, name } = dto;
    if (!code || !name?.en) throw new BadRequestException('code and name.en are required');
    return this.db.tx(user, (tx) =>
      tx.one(
        `INSERT INTO commodities (code, "group", name, hs_code, sort_order)
         VALUES ($1, COALESCE($2::commodity_group, 'other'), $3::jsonb, $4, COALESCE($5, 900))
         RETURNING ${COMMODITY_COLUMNS}`,
        [code.trim(), dto.group ?? null, JSON.stringify(name), dto.hsCode ?? null, dto.sortOrder ?? null],
      ),
    );
  }

  @Patch('commodities/:id')
  @RequirePermission('reference.manage')
  updateCommodity(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CommodityDto) {
    const patch: Record<string, unknown> = { ...dto };
    if (dto.name) patch.name = JSON.stringify(dto.name);
    const { sql, params } = buildSet(patch, {
      code: 'code',
      group: '"group"',
      name: 'name',
      hsCode: 'hs_code',
      isActive: 'is_active',
      sortOrder: 'sort_order',
    }, 2);
    if (!sql) throw new BadRequestException('Nothing to update');
    return this.db.tx(user, async (tx) => {
      const row = await tx.one(`UPDATE commodities SET ${sql} WHERE id = $1 RETURNING ${COMMODITY_COLUMNS}`, [id, ...params]);
      if (!row) throw new NotFoundException('Commodity not found');
      return row;
    });
  }

  @Get('ports')
  ports(@CurrentUser() user: AuthUser, @Query('all') all?: string, @Query('country') country?: string) {
    return this.db.tx(user, (tx) =>
      tx.many(
        `SELECT ${PORT_COLUMNS},
                (SELECT count(*) FROM inspection_jobs j WHERE j.port_id = p.id)::int AS "jobCount"
         FROM ports p
         WHERE ($1::boolean IS TRUE OR p.is_active)
           AND ($2::text IS NULL OR p.country = upper($2))
         ORDER BY p.country, p.name`,
        [all === 'true', country || null],
      ),
    );
  }

  @Post('ports')
  @RequirePermission('reference.manage')
  createPort(@CurrentUser() user: AuthUser, @Body() dto: PortDto) {
    const { code, name, country } = dto;
    if (!code || !name || !country) throw new BadRequestException('code, name and country are required');
    return this.db.tx(user, (tx) =>
      tx.one(
        `INSERT INTO ports (code, name, country, is_inland) VALUES (upper($1), $2, upper($3), COALESCE($4, false))
         RETURNING ${PORT_COLUMNS}`,
        [code.trim(), name.trim(), country, dto.isInland ?? null],
      ),
    );
  }

  @Patch('ports/:id')
  @RequirePermission('reference.manage')
  updatePort(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PortDto) {
    const { sql, params } = buildSet({ ...dto }, {
      code: 'code',
      name: 'name',
      country: 'country',
      isInland: 'is_inland',
      isActive: 'is_active',
    }, 2);
    if (!sql) throw new BadRequestException('Nothing to update');
    return this.db.tx(user, async (tx) => {
      const row = await tx.one(`UPDATE ports SET ${sql} WHERE id = $1 RETURNING ${PORT_COLUMNS}`, [id, ...params]);
      if (!row) throw new NotFoundException('Port not found');
      return row;
    });
  }
}
