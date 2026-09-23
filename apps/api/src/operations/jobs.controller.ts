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
import { IsDateString, IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import {
  AuthUser,
  CHECKLIST_RESULTS,
  COMMODITY_GROUPS,
  ChecklistResult,
  JOB_STATUSES,
  JobStatus,
  SERVICE_TYPES,
  ServiceType,
} from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { config } from '../config';
import { JobsService } from './jobs.service';
import { ChecklistService } from './checklist.service';

class JobFieldsDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(300) location?: string;
  @IsOptional() @IsUUID() commodityId?: string | null;
  @IsOptional() @IsUUID() portId?: string | null;
  @IsOptional() @IsString() @MaxLength(100) contractNo?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) quantityValue?: number | null;
  @IsOptional() @IsString() @MaxLength(10) quantityUnit?: string | null;
  @IsOptional() @IsString() @MaxLength(200) vesselOrObject?: string | null;
  @IsOptional() @IsString() @MaxLength(200) commodity?: string | null;
  @IsOptional() @IsString() @MaxLength(100) quantity?: string | null;
  @IsOptional() @IsDateString() scheduledAt?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) instructions?: string | null;
}

class CreateJobDto {
  @IsUUID() clientId: string;
  @IsIn(SERVICE_TYPES) type: ServiceType;
  @IsString() @MinLength(2) @MaxLength(300) location: string;
  @IsOptional() @IsString() @MaxLength(200) vesselOrObject?: string | null;
  @IsOptional() @IsString() @MaxLength(200) commodity?: string | null;
  @IsOptional() @IsString() @MaxLength(100) quantity?: string | null;
  @IsOptional() @IsDateString() scheduledAt?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) instructions?: string | null;
  @IsOptional() @IsUUID() assignedInspectorId?: string | null;
  // Reference data and contract details (migration 004).
  @IsOptional() @IsUUID() commodityId?: string | null;
  @IsOptional() @IsUUID() portId?: string | null;
  @IsOptional() @IsString() @MaxLength(100) contractNo?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) quantityValue?: number | null;
  @IsOptional() @IsString() @MaxLength(10) quantityUnit?: string | null;
}

class AssignDto {
  @IsUUID() inspectorId: string;
}

class ReturnDto {
  @IsString() @MinLength(3) @MaxLength(2000) comment: string;
}

class JobQueryDto {
  @IsOptional() @IsIn(JOB_STATUSES) status?: JobStatus;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() inspectorId?: string;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() commodityId?: string;
  @IsOptional() @IsIn(COMMODITY_GROUPS) commodityGroup?: string;
  @IsOptional() @IsUUID() portId?: string;
  @IsOptional() @IsString() @MaxLength(100) contractNo?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minQuantity?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) maxQuantity?: number;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(SERVICE_TYPES) type?: ServiceType;
}

class UpdateItemDto {
  @IsOptional() @IsIn(CHECKLIST_RESULTS) result?: ChecklistResult | null;
  @IsOptional() @IsString() @MaxLength(1000) value?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
}

class UploadMetaDto {
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-90) @Max(90) gpsLat?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-180) @Max(180) gpsLng?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) gpsAccuracyM?: number;
  @IsOptional() @IsDateString() takenAt?: string;
}

/** Operations domain: inspection jobs and their lifecycle (docs/01-architecture.md, module 2). */
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService, private readonly checklist: ChecklistService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: JobQueryDto) {
    return this.jobs.list(user, q);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.get(user, id);
  }

  @Post()
  @RequirePermission('job.create')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateJobDto) {
    return this.jobs.create(user, dto);
  }

  @Patch(':id')
  @RequirePermission('job.update')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: JobFieldsDto) {
    return this.jobs.update(user, id, dto);
  }

  @Delete(':id')
  @RequirePermission('job.delete')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.jobs.remove(user, id);
  }

  @Post(':id/assign')
  @RequirePermission('job.assign')
  assign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDto) {
    return this.jobs.assign(user, id, dto.inspectorId);
  }

  @Post(':id/start')
  @RequirePermission('job.start')
  @HttpCode(200)
  start(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.start(user, id);
  }

  @Post(':id/submit')
  @RequirePermission('job.submit')
  @HttpCode(200)
  submit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.submit(user, id);
  }

  @Post(':id/return')
  @RequirePermission('job.cancel')
  @HttpCode(200)
  returnForRework(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReturnDto) {
    return this.jobs.returnForRework(user, id, dto.comment);
  }

  @Post(':id/approve')
  @RequirePermission('job.approve')
  @HttpCode(200)
  approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.approve(user, id);
  }

  @Post(':id/cancel')
  @RequirePermission('job.cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.cancel(user, id);
  }

  // ---- Field checklist -------------------------------------------------------------

  @Get(':id/checklist')
  checklistItems(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.checklist.list(user, id);
  }

  @Patch(':id/checklist/:itemId')
  @RequirePermission('checklist.update')
  updateItem(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateItemDto,
  ) {
    return this.checklist.updateItem(user, id, itemId, dto);
  }

  @Post(':id/checklist/:itemId/media')
  @RequirePermission('media.upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: config.maxUploadBytes, files: 1 } }))
  upload(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() meta: UploadMetaDto,
  ) {
    return this.checklist.upload(user, id, itemId, file, meta);
  }
}

@Controller('media')
export class MediaController {
  constructor(private readonly checklist: ChecklistService) {}

  @Delete(':id')
  @RequirePermission('media.delete')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.checklist.removeMedia(user, id);
  }
}
