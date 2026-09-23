import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ASSET_CATEGORIES,
  ASSET_STATUSES,
  AssetCategory,
  AssetStatus,
  AuthUser,
  DEPRECIATION_METHODS,
  DepreciationMethod,
} from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { AssetsService } from './assets.service';
import { AssetSummaryService } from './asset-summary.service';

class AssetDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(50) inventoryNo?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) name?: string;
  @IsOptional() @IsIn(ASSET_CATEGORIES) category?: AssetCategory;
  @IsOptional() @IsIn(ASSET_STATUSES) status?: AssetStatus;
  @IsOptional() @IsString() @MaxLength(100) serialNo?: string | null;
  @IsOptional() @IsString() @MaxLength(200) location?: string | null;
  @IsOptional() @IsUUID() responsibleUserId?: string | null;
  @IsOptional() @IsDateString() acquisitionDate?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) acquisitionCost?: number;
  @IsOptional() @IsString() @Length(3, 3) currency?: string;
  @IsOptional() @IsIn(DEPRECIATION_METHODS) method?: DepreciationMethod;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) usefulLifeMonths?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) salvageValue?: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsUUID() branchId?: string;
}

class AssetQueryDto {
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsIn(ASSET_CATEGORIES) category?: AssetCategory;
  @IsOptional() @IsIn(ASSET_STATUSES) status?: AssetStatus;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() responsibleUserId?: string;
}

class PeriodDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() branchId?: string;
}

class DisposeDto {
  @IsOptional() @IsDateString() disposedOn?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) amount?: number | null;
  @IsOptional() @IsString() @MaxLength(1000) note?: string | null;
  @IsOptional() @IsBoolean() writeOff?: boolean;
}

class RunDto {
  /** Month to charge, YYYY-MM-DD or YYYY-MM; defaults to the current month. */
  @IsOptional() @IsString() @MaxLength(10) period?: string;
}

/**
 * Company assets: offices, vehicles, laboratory and inspection equipment, IT.
 * Same audience as the rest of finance; only finance controllers and admins change anything.
 */
@Controller('assets')
@RequirePermission('asset.read')
export class AssetsController {
  constructor(private readonly assets: AssetsService, private readonly summary: AssetSummaryService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: AssetQueryDto) {
    return this.assets.list(user, q);
  }

  @Get('summary')
  getSummary(@CurrentUser() user: AuthUser, @Query() q: PeriodDto) {
    return this.summary.build(user, q);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.assets.get(user, id);
  }

  @Post()
  @RequirePermission('asset.create')
  create(@CurrentUser() user: AuthUser, @Body() dto: AssetDto) {
    return this.assets.create(user, dto);
  }

  @Patch(':id')
  @RequirePermission('asset.update')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssetDto) {
    return this.assets.update(user, id, dto);
  }

  @Post(':id/dispose')
  @RequirePermission('asset.update')
  @HttpCode(200)
  dispose(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DisposeDto) {
    return this.assets.dispose(user, id, dto);
  }

  @Post(':id/photo')
  @RequirePermission('asset.update')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  photo(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: Express.Multer.File) {
    return this.assets.uploadPhoto(user, id, file);
  }

  @Delete(':id')
  @RequirePermission('asset.delete')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.assets.remove(user, id);
  }

  /** Charges one month of depreciation across the visible assets and posts it to the ledger. */
  @Post('depreciation/run')
  @RequirePermission('asset.depreciate')
  @HttpCode(200)
  runDepreciation(@CurrentUser() user: AuthUser, @Body() dto: RunDto) {
    return this.assets.runDepreciation(user, dto.period);
  }
}
