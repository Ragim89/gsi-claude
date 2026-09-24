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
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FindingSeverity,
  FindingStatus,
  INSPECTION_ACTIONS,
  INSPECTION_STATUSES,
  InspectionAction,
  InspectionStatus,
  PHOTO_CATEGORIES,
  PhotoCategory,
  SERVICE_TYPES,
  ServiceType,
} from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { config } from '../config';
import { InspectionSort, InspectionsService } from './inspections.service';
import { InspectionFieldService } from './inspection-field.service';

class CreateInspectionDto {
  @IsUUID() jobId: string;
  @IsOptional() @IsIn(SERVICE_TYPES) type?: ServiceType;
  @IsOptional() @IsString() @MaxLength(300) location?: string | null;
  @IsOptional() @IsString() @MaxLength(120) city?: string | null;
  @IsOptional() @IsDateString() scheduledStart?: string | null;
  @IsOptional() @IsDateString() scheduledEnd?: string | null;
  @IsOptional() @IsUUID() leadInspectorId?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) instructions?: string | null;
  @IsOptional() @IsBoolean() withChecklist?: boolean;
}

class UpdateInspectionDto {
  @IsOptional() @IsString() @MaxLength(300) location?: string | null;
  @IsOptional() @IsString() @MaxLength(120) city?: string | null;
  @IsOptional() @IsDateString() scheduledStart?: string | null;
  @IsOptional() @IsDateString() scheduledEnd?: string | null;
  @IsOptional() @IsString() @MaxLength(500) weatherConditions?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) siteConditions?: string | null;
  @IsOptional() @IsString() @MaxLength(8000) generalObservations?: string | null;
  @IsOptional() @IsString() @MaxLength(8000) conclusion?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) internalNotes?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) instructions?: string | null;
  @IsOptional() @IsUUID() leadInspectorId?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) version?: number;
}

class TransitionDto {
  @IsIn(INSPECTION_ACTIONS) action: InspectionAction;
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
}

class AssignDto {
  @IsUUID() userId: string;
  @IsOptional() @IsIn(ASSIGNMENT_ROLES) role?: AssignmentRole;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class FindingDto {
  @IsString() @MinLength(3) @MaxLength(200) title: string;
  @IsOptional() @IsIn(FINDING_SEVERITIES) severity?: FindingSeverity;
  @IsOptional() @IsString() @MaxLength(60) category?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) description?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) recommendation?: string | null;
  @IsOptional() @IsBoolean() isInternal?: boolean;
}

class UpdateFindingDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) title?: string;
  @IsOptional() @IsIn(FINDING_SEVERITIES) severity?: FindingSeverity;
  @IsOptional() @IsIn(FINDING_STATUSES) status?: FindingStatus;
  @IsOptional() @IsString() @MaxLength(60) category?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) description?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) recommendation?: string | null;
  @IsOptional() @IsBoolean() isInternal?: boolean;
}

class MeasurementDto {
  @IsString() @MinLength(2) @MaxLength(40) measurementType: string;
  @IsOptional() @IsString() @MaxLength(120) label?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() valueNumeric?: number | null;
  @IsOptional() @IsString() @MaxLength(200) valueText?: string | null;
  @IsOptional() @IsString() @MaxLength(20) unit?: string | null;
  @IsOptional() @IsString() @MaxLength(120) position?: string | null;
  @IsOptional() @IsDateString() measuredAt?: string | null;
}

/** One checklist answer; the field screen sends a batch of these as the inspector works. */
class ChecklistAnswerDto {
  @IsUUID() itemId: string;
  @IsOptional() @IsIn(['ok', 'deviation', 'na']) result?: 'ok' | 'deviation' | 'na' | null;
  @IsOptional() @IsString() @MaxLength(1000) value?: string | null;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string | null;
}

class ChecklistBatchDto {
  @IsOptional() @Type(() => ChecklistAnswerDto) answers: ChecklistAnswerDto[];
}

class PhotoMetaDto {
  @IsOptional() @IsIn(PHOTO_CATEGORIES) category?: PhotoCategory;
  @IsOptional() @IsString() @MaxLength(300) caption?: string;
  @IsOptional() @IsUUID() checklistItemId?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-90) @Max(90) gpsLat?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-180) @Max(180) gpsLng?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) gpsAccuracyM?: number;
  @IsOptional() @IsDateString() takenAt?: string;
}

class InspectionQueryDto {
  @IsOptional() @IsUUID() jobId?: string;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsIn(INSPECTION_STATUSES) status?: InspectionStatus;
  @IsOptional() @IsIn(SERVICE_TYPES) type?: ServiceType;
  @IsOptional() @IsUUID() inspectorId?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() mine?: boolean;
  @IsOptional() @Type(() => Boolean) @IsBoolean() active?: boolean;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() countryId?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(['inspectionNumber', 'scheduledStart', 'status', 'updatedAt']) sort?: InspectionSort;
  @IsOptional() @IsIn(['asc', 'desc']) dir?: 'asc' | 'desc';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/**
 * Inspections — the field work of a job (docs/WORKFLOWS.md).
 *
 * The field endpoints are shaped for a phone on a quay: one call saves a batch of checklist
 * answers, one call adds a photo with its metadata, and status moves have a single entrance.
 */
@Controller('inspections')
export class InspectionsController {
  constructor(
    private readonly inspections: InspectionsService,
    private readonly field: InspectionFieldService,
  ) {}

  @Get()
  @RequirePermission('inspection.read')
  list(@CurrentUser() user: AuthUser, @Query() q: InspectionQueryDto) {
    return this.inspections.list(user, q);
  }

  @Get(':id')
  @RequirePermission('inspection.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.inspections.get(user, id);
  }

  @Post()
  @RequirePermission('inspection.create')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateInspectionDto) {
    return this.inspections.create(user, dto);
  }

  @Patch(':id')
  @RequirePermission('inspection.update')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateInspectionDto) {
    return this.inspections.update(user, id, dto);
  }

  /** The one way an inspection changes status. */
  @Post(':id/transitions')
  @HttpCode(200)
  transition(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TransitionDto) {
    return this.inspections.transition(user, id, dto.action, dto.reason);
  }

  @Get(':id/history')
  @RequirePermission('inspection.read')
  history(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.inspections.history(user, id);
  }

  // ---- Team --------------------------------------------------------------------------

  @Get(':id/assignments')
  @RequirePermission('inspection.read')
  assignments(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.inspections.listAssignments(user, id);
  }

  @Post(':id/assignments')
  @RequirePermission('inspection.assign')
  assign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDto) {
    return this.inspections.assign(user, id, dto.userId, dto.role ?? 'inspector', dto.note);
  }

  @Delete(':id/assignments/:assignmentId')
  @RequirePermission('inspection.assign')
  unassign(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
  ) {
    return this.inspections.removeAssignment(user, id, assignmentId);
  }

  // ---- Field work --------------------------------------------------------------------

  @Get(':id/checklist')
  @RequirePermission('inspection.read')
  checklist(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.field.checklist(user, id);
  }

  /**
   * Saves a batch of answers in one request. The field screen debounces and sends what
   * changed — not a request per keystroke, and not a request per item.
   */
  @Patch(':id/checklist')
  @RequirePermission('checklist.update')
  @HttpCode(200)
  saveChecklist(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChecklistBatchDto,
  ) {
    return this.field.saveChecklist(user, id, dto.answers ?? []);
  }

  @Get(':id/findings')
  @RequirePermission('inspection.read')
  findings(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.inspections.listFindings(user, id);
  }

  @Post(':id/findings')
  @RequirePermission('inspection.add_finding')
  addFinding(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FindingDto) {
    return this.inspections.addFinding(user, id, dto);
  }

  @Patch(':id/findings/:findingId')
  @RequirePermission('inspection.add_finding')
  updateFinding(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('findingId', ParseUUIDPipe) findingId: string,
    @Body() dto: UpdateFindingDto,
  ) {
    return this.inspections.updateFinding(user, id, findingId, dto);
  }

  @Get(':id/measurements')
  @RequirePermission('inspection.read')
  measurements(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.inspections.listMeasurements(user, id);
  }

  @Post(':id/measurements')
  @RequirePermission('inspection.add_measurement')
  addMeasurement(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MeasurementDto) {
    return this.inspections.addMeasurement(user, id, dto);
  }

  @Delete(':id/measurements/:measurementId')
  @RequirePermission('inspection.add_measurement')
  @HttpCode(204)
  async removeMeasurement(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('measurementId', ParseUUIDPipe) measurementId: string,
  ) {
    await this.inspections.removeMeasurement(user, id, measurementId);
  }

  @Get(':id/photos')
  @RequirePermission('inspection.read')
  photos(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.field.photos(user, id);
  }

  @Post(':id/photos')
  @RequirePermission('media.upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: config.maxUploadBytes, files: 1 } }))
  addPhoto(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() meta: PhotoMetaDto,
  ) {
    return this.field.addPhoto(user, id, file, meta);
  }

  // ---- Archive -----------------------------------------------------------------------

  @Delete(':id')
  @RequirePermission('inspection.archive')
  @HttpCode(204)
  async archive(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.inspections.archive(user, id);
  }

  @Post(':id/restore')
  @RequirePermission('inspection.restore')
  @HttpCode(200)
  restore(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.inspections.restore(user, id);
  }
}
