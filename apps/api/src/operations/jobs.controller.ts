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
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ASSIGNMENT_ROLES,
  AssignmentRole,
  AuthUser,
  CHECKLIST_RESULTS,
  COMMODITY_GROUPS,
  ChecklistResult,
  JOB_ACTIONS,
  JOB_OBJECT_KINDS,
  JOB_PRIORITIES,
  JOB_STATUSES,
  JobAction,
  JobObjectKind,
  JobPriority,
  JobStatus,
  SERVICE_TYPES,
  ServiceType,
} from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { config } from '../config';
import { JobSort, JobsService } from './jobs.service';
import { ChecklistService } from './checklist.service';

class JobFieldsDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(300) location?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string | null;
  @IsOptional() @IsUUID() commodityId?: string | null;
  @IsOptional() @IsUUID() portId?: string | null;
  @IsOptional() @IsString() @MaxLength(100) contractNo?: string | null;
  /** The contract this job is performed under, when there is one on file. */
  @IsOptional() @IsUUID() contractId?: string | null;
  @IsOptional() @IsUUID() clientContactId?: string | null;
  @IsOptional() @IsUUID() requestingBranchId?: string | null;
  @IsOptional() @IsString() @MaxLength(100) clientReference?: string | null;
  @IsOptional() @IsIn(JOB_PRIORITIES) priority?: JobPriority;
  @IsOptional() @IsIn(JOB_OBJECT_KINDS) objectKind?: JobObjectKind | null;
  @IsOptional() @IsString() @MaxLength(60) containerNo?: string | null;
  @IsOptional() @IsString() @MaxLength(100) transportRef?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) quantityValue?: number | null;
  @IsOptional() @IsString() @MaxLength(10) quantityUnit?: string | null;
  @IsOptional() @IsString() @MaxLength(200) vesselOrObject?: string | null;
  @IsOptional() @IsString() @MaxLength(200) commodity?: string | null;
  @IsOptional() @IsString() @MaxLength(100) quantity?: string | null;
  @IsOptional() @IsDateString() requestedDate?: string | null;
  @IsOptional() @IsDateString() scheduledAt?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) instructions?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) internalNotes?: string | null;
}

class CreateJobDto extends JobFieldsDto {
  @IsUUID() clientId: string;
  @IsIn(SERVICE_TYPES) type: ServiceType;
  /** A job may be opened as a draft with very little known, or straight as confirmed. */
  @IsOptional() @IsIn(['draft', 'confirmed']) status?: 'draft' | 'confirmed';
  @IsOptional() @IsUUID() assignedInspectorId?: string | null;
}

class UpdateJobDto extends JobFieldsDto {
  /** The version the form was loaded with; a stale one is refused, not merged blindly. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) version?: number;
}

class TransitionDto {
  @IsIn(JOB_ACTIONS) action: JobAction;
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
}

class AssignDto {
  @IsUUID() userId: string;
  @IsOptional() @IsIn(ASSIGNMENT_ROLES) role?: AssignmentRole;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class JobQueryDto {
  @IsOptional() @IsIn(JOB_STATUSES) status?: JobStatus;
  @IsOptional() @Type(() => Boolean) @IsBoolean() active?: boolean;
  @IsOptional() @IsIn(JOB_PRIORITIES) priority?: JobPriority;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() contractId?: string;
  @IsOptional() @IsUUID() inspectorId?: string;
  /** Everything assigned to the caller — the "my jobs" view, not a separate endpoint. */
  @IsOptional() @Type(() => Boolean) @IsBoolean() mine?: boolean;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() countryId?: string;
  @IsOptional() @IsUUID() commodityId?: string;
  @IsOptional() @IsIn(COMMODITY_GROUPS) commodityGroup?: string;
  @IsOptional() @IsUUID() portId?: string;
  @IsOptional() @IsString() @MaxLength(100) contractNo?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minQuantity?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) maxQuantity?: number;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(SERVICE_TYPES) type?: ServiceType;
  @IsOptional()
  @IsIn(['jobNumber', 'requestedDate', 'scheduledAt', 'priority', 'status', 'updatedAt'])
  sort?: JobSort;
  @IsOptional() @IsIn(['asc', 'desc']) dir?: 'asc' | 'desc';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

class ArchiveQueryDto {
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
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

class ReturnDto {
  @IsString() @MinLength(3) @MaxLength(2000) comment: string;
}

/**
 * Operations: inspection jobs and their lifecycle (docs/WORKFLOWS.md).
 *
 * Status changes have one entrance — POST :id/transitions. The older verb endpoints are kept
 * because existing clients and the mobile flow use them, and they now call the same engine.
 */
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService, private readonly checklist: ChecklistService) {}

  @Get()
  @RequirePermission('job.read')
  list(@CurrentUser() user: AuthUser, @Query() q: JobQueryDto) {
    return this.jobs.list(user, q);
  }

  /** The archive, for an administrator looking for something that was put away. */
  @Get('archived')
  @RequirePermission('job.restore')
  archived(@CurrentUser() user: AuthUser, @Query() q: ArchiveQueryDto) {
    return this.jobs.listArchived(user, q);
  }

  @Get(':id')
  @RequirePermission('job.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.get(user, id);
  }

  @Get(':id/history')
  @RequirePermission('job.read_history', 'job.read')
  history(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.history(user, id);
  }

  @Post()
  @RequirePermission('job.create')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateJobDto) {
    return this.jobs.create(user, dto);
  }

  @Patch(':id')
  @RequirePermission('job.update')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateJobDto) {
    return this.jobs.update(user, id, dto);
  }

  // ---- Lifecycle ---------------------------------------------------------------------

  /** The one way a job changes status. Everything below delegates here. */
  @Post(':id/transitions')
  @HttpCode(200)
  transition(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TransitionDto) {
    return this.jobs.transition(user, id, dto.action, dto.reason);
  }

  @Post(':id/start')
  @HttpCode(200)
  start(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.transition(user, id, 'start').then((r) => r.job);
  }

  @Post(':id/submit')
  @HttpCode(200)
  submit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.transition(user, id, 'submit').then((r) => r.job);
  }

  @Post(':id/return')
  @HttpCode(200)
  returnForRework(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReturnDto,
  ) {
    return this.jobs.transition(user, id, 'return', dto.comment).then((r) => r.job);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.transition(user, id, 'approve');
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TransitionDto) {
    return this.jobs.transition(user, id, 'cancel', dto.reason).then((r) => r.job);
  }

  // ---- Assignments -------------------------------------------------------------------

  @Get(':id/assignments')
  @RequirePermission('job.read')
  assignments(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.listAssignments(user, id);
  }

  @Post(':id/assignments')
  @RequirePermission('job.assign')
  assign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDto) {
    return this.jobs.assign(user, id, dto.userId, dto.role ?? 'inspector', dto.note);
  }

  @Delete(':id/assignments/:assignmentId')
  @RequirePermission('job.assign')
  unassign(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
  ) {
    return this.jobs.removeAssignment(user, id, assignmentId);
  }

  // ---- Archive -----------------------------------------------------------------------

  @Delete(':id')
  @RequirePermission('job.archive')
  @HttpCode(204)
  async archive(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.jobs.archive(user, id);
  }

  @Post(':id/restore')
  @RequirePermission('job.restore')
  @HttpCode(200)
  restore(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.restore(user, id);
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
