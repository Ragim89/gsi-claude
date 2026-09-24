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
} from 'class-validator';
import {
  AuthUser,
  CUSTODY_EVENT_TYPES,
  CustodyEventType,
  PHOTO_CATEGORIES,
  PhotoCategory,
  SAMPLE_ACTIONS,
  SAMPLE_CONDITIONS,
  SAMPLE_REJECTION_REASONS,
  SAMPLE_STATUSES,
  SAMPLE_TYPES,
  SAMPLING_METHODS,
  SEAL_CONDITIONS,
  SampleAction,
  SampleCondition,
  SampleRejectionReason,
  SampleStatus,
  SampleType,
  SamplingMethod,
  SealCondition,
} from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { config } from '../config';
import { SampleSort, SamplesService } from './samples.service';
import { SampleMediaService } from './sample-media.service';

class CreateSampleDto {
  @IsOptional() @IsUUID() jobId?: string;
  @IsOptional() @IsUUID() inspectionId?: string;
  @IsOptional() @IsIn(SAMPLE_TYPES) sampleType?: SampleType;
  @IsOptional() @IsIn(SAMPLING_METHODS) samplingMethod?: SamplingMethod;
  @IsOptional() @IsUUID() commodityId?: string | null;
  @IsOptional() @IsString() @MaxLength(200) commodity?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) commodityDetails?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) quantity?: number | null;
  @IsOptional() @IsString() @MaxLength(20) unit?: string | null;
  @IsOptional() @IsString() @MaxLength(120) containerType?: string | null;
  @IsOptional() @IsString() @MaxLength(120) batchLotNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(120) containerReference?: string | null;
  @IsOptional() @IsString() @MaxLength(300) location?: string | null;
  @IsOptional() @IsString() @MaxLength(120) sealNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(60) sealType?: string | null;
  @IsOptional() @IsUUID() sampledBy?: string | null;
  @IsOptional() @IsDateString() sampledAt?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) conditionNotes?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) instructions?: string | null;
  @IsOptional() @IsString() @MaxLength(120) sampleGroup?: string | null;
  @IsOptional() @IsUUID() parentSampleId?: string | null;
  @IsOptional() @IsUUID() destinationLaboratoryId?: string | null;
}

class UpdateSampleDto {
  @IsOptional() @IsIn(SAMPLE_TYPES) sampleType?: SampleType;
  @IsOptional() @IsIn(SAMPLING_METHODS) samplingMethod?: SamplingMethod;
  @IsOptional() @IsUUID() commodityId?: string | null;
  @IsOptional() @IsString() @MaxLength(200) commodity?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) commodityDetails?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) quantity?: number | null;
  @IsOptional() @IsString() @MaxLength(20) unit?: string | null;
  @IsOptional() @IsString() @MaxLength(120) containerType?: string | null;
  @IsOptional() @IsString() @MaxLength(120) batchLotNumber?: string | null;
  @IsOptional() @IsString() @MaxLength(120) containerReference?: string | null;
  @IsOptional() @IsString() @MaxLength(300) location?: string | null;
  @IsOptional() @IsUUID() sampledBy?: string | null;
  @IsOptional() @IsDateString() sampledAt?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) conditionNotes?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) instructions?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) internalNotes?: string | null;
  @IsOptional() @IsString() @MaxLength(120) sampleGroup?: string | null;
  @IsOptional() @IsUUID() destinationLaboratoryId?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) version?: number;
}

/** Everything a status move may carry; the workflow decides which fields it actually uses. */
class TransitionDto {
  @IsIn(SAMPLE_ACTIONS) action: SampleAction;
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsString() @MaxLength(300) location?: string;
  @IsOptional() @IsString() @MaxLength(300) toLocation?: string;
  @IsOptional() @IsString() @MaxLength(120) sealNumber?: string;
  @IsOptional() @IsString() @MaxLength(60) sealType?: string;
  @IsOptional() @IsUUID() sealedBy?: string;
  @IsOptional() @IsIn(SEAL_CONDITIONS) sealState?: SealCondition;
  @IsOptional() @IsIn(SAMPLE_CONDITIONS) condition?: SampleCondition;
  @IsOptional() @IsUUID() destinationLaboratoryId?: string;
  @IsOptional() @IsString() @MaxLength(200) courier?: string;
  @IsOptional() @IsString() @MaxLength(200) trackingReference?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) packageCount?: number;
  @IsOptional() @IsUUID() dispatchedBy?: string;
  @IsOptional() @IsUUID() receivedBy?: string;
  @IsOptional() @IsUUID() decidedBy?: string;
  @IsOptional() @IsIn(SAMPLE_REJECTION_REASONS) rejectionReason?: SampleRejectionReason;
}

class HandoverDto {
  @IsOptional() @IsIn(CUSTODY_EVENT_TYPES) eventType?: CustodyEventType;
  @IsOptional() @IsUUID() fromUserId?: string;
  @IsOptional() @IsUUID() fromOfficeId?: string;
  @IsOptional() @IsString() @MaxLength(300) fromLocation?: string;
  @IsOptional() @IsUUID() toUserId?: string;
  @IsOptional() @IsUUID() toOfficeId?: string;
  @IsOptional() @IsString() @MaxLength(300) toLocation?: string;
  @IsOptional() @IsDateString() occurredAt?: string;
  @IsOptional() @IsIn(SEAL_CONDITIONS) sealState?: SealCondition;
  @IsOptional() @IsIn(SAMPLE_CONDITIONS) condition?: SampleCondition;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

class CorrectionDto {
  @IsString() @MaxLength(2000) notes: string;
  @IsOptional() @IsUUID() toUserId?: string;
  @IsOptional() @IsString() @MaxLength(300) toLocation?: string;
  @IsOptional() @IsIn(SEAL_CONDITIONS) sealState?: SealCondition;
  @IsOptional() @IsIn(SAMPLE_CONDITIONS) condition?: SampleCondition;
}

class AttachmentMetaDto {
  @IsOptional() @IsIn(PHOTO_CATEGORIES) category?: PhotoCategory;
  @IsOptional() @IsString() @MaxLength(300) caption?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-90) @Max(90) gpsLat?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(-180) @Max(180) gpsLng?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) gpsAccuracyM?: number;
  @IsOptional() @IsDateString() takenAt?: string;
}

class LaboratoryDto {
  @IsString() @MaxLength(20) code: string;
  @IsString() @MaxLength(200) name: string;
  @IsOptional() @IsUUID() branchId?: string | null;
  @IsOptional() @IsString() @MaxLength(120) city?: string | null;
  @IsOptional() @IsString() @MaxLength(300) address?: string | null;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string | null;
  @IsOptional() @Type(() => Boolean) @IsBoolean() isExternal?: boolean;
  @IsOptional() @IsString() @MaxLength(200) contactEmail?: string | null;
  @IsOptional() @IsString() @MaxLength(60) contactPhone?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
}

class UpdateLaboratoryDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string | null;
  @IsOptional() @IsString() @MaxLength(300) address?: string | null;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string | null;
  @IsOptional() @IsString() @MaxLength(200) contactEmail?: string | null;
  @IsOptional() @IsString() @MaxLength(60) contactPhone?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  /** Closing a laboratory hides it from the dispatch list without touching its history. */
  @IsOptional() @Type(() => Boolean) @IsBoolean() isActive?: boolean;
}

class SampleQueryDto {
  @IsOptional() @IsUUID() jobId?: string;
  @IsOptional() @IsUUID() inspectionId?: string;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsIn(SAMPLE_STATUSES) status?: SampleStatus;
  @IsOptional() @IsIn(SAMPLE_TYPES) sampleType?: SampleType;
  @IsOptional() @IsUUID() samplerId?: string;
  @IsOptional() @IsUUID() commodityId?: string;
  @IsOptional() @IsUUID() laboratoryId?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() countryId?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() mine?: boolean;
  @IsOptional() @Type(() => Boolean) @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(['sampleNumber', 'sampledAt', 'status', 'updatedAt']) sort?: SampleSort;
  @IsOptional() @IsIn(['asc', 'desc']) dir?: 'asc' | 'desc';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/**
 * Samples and the chain of custody (docs/WORKFLOWS.md).
 *
 * Status moves have one entrance, custody has another, and they are deliberately not the same
 * endpoint: handing a bag to a courier is not a decision about the sample.
 */
@Controller('samples')
export class SamplesController {
  constructor(
    private readonly samples: SamplesService,
    private readonly media: SampleMediaService,
  ) {}

  @Get()
  @RequirePermission('sample.read')
  list(@CurrentUser() user: AuthUser, @Query() q: SampleQueryDto) {
    return this.samples.list(user, q);
  }

  /** The destinations a sample can be dispatched to; needed before one can be. */
  @Get('laboratories')
  @RequirePermission('sample.read')
  laboratories(@CurrentUser() user: AuthUser, @Query('includeInactive') includeInactive?: string) {
    return this.samples.laboratories(user, includeInactive === 'true' && (user.permissions?.includes('org.manage') ?? false));
  }

  /**
   * Adds a laboratory. Nothing invents these: a fresh installation has none until somebody
   * who administers the organisation says which laboratories the group actually uses.
   */
  @Post('laboratories')
  @RequirePermission('org.manage')
  createLaboratory(@CurrentUser() user: AuthUser, @Body() dto: LaboratoryDto) {
    return this.samples.createLaboratory(user, dto);
  }

  /**
   * Declared before `PATCH :id`, or "laboratories" would be read as a sample id — route order
   * is how Nest tells the two apart.
   */
  @Patch('laboratories/:labId')
  @RequirePermission('org.manage')
  updateLaboratory(
    @CurrentUser() user: AuthUser,
    @Param('labId', ParseUUIDPipe) labId: string,
    @Body() dto: UpdateLaboratoryDto,
  ) {
    return this.samples.updateLaboratory(user, labId, dto);
  }

  @Get(':id')
  @RequirePermission('sample.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.samples.get(user, id);
  }

  @Post()
  @RequirePermission('sample.create')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSampleDto) {
    return this.samples.create(user, dto);
  }

  @Patch(':id')
  @RequirePermission('sample.update')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSampleDto) {
    return this.samples.update(user, id, dto);
  }

  /** The one way a sample changes status. */
  @Post(':id/transitions')
  @HttpCode(200)
  transition(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TransitionDto) {
    const { action, ...payload } = dto;
    return this.samples.transition(user, id, action, payload);
  }

  @Get(':id/history')
  @RequirePermission('sample.read')
  history(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.samples.history(user, id);
  }

  // ---- Chain of custody ------------------------------------------------------------------

  @Get(':id/custody')
  @RequirePermission('sample.read_custody')
  custody(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.samples.custody(user, id);
  }

  /** A physical handover, which changes who holds the sample and nothing else. */
  @Post(':id/custody')
  @RequirePermission('sample.update')
  handover(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: HandoverDto) {
    return this.samples.handover(user, id, dto);
  }

  /**
   * Corrects an earlier entry by adding one that supersedes it. There is deliberately no PATCH
   * and no DELETE here, and `gsi_app` has no grant for either.
   */
  @Post(':id/custody/:eventId/corrections')
  @RequirePermission('sample.update')
  correct(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('eventId', ParseUUIDPipe) eventId: string,
    @Body() dto: CorrectionDto,
  ) {
    return this.samples.correctCustody(user, id, eventId, dto);
  }

  // ---- Evidence and label ----------------------------------------------------------------

  @Get(':id/attachments')
  @RequirePermission('sample.read')
  attachments(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.media.list(user, id);
  }

  @Post(':id/attachments')
  @RequirePermission('sample.add_attachment')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: config.maxUploadBytes, files: 1 } }))
  addAttachment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() meta: AttachmentMetaDto,
  ) {
    return this.media.add(user, id, file, meta);
  }

  @Get(':id/label')
  @RequirePermission('sample.print_label')
  label(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('locale') locale?: string,
  ) {
    return this.media.label(user, id, locale ?? user.locale ?? 'en');
  }

  // ---- Archive ---------------------------------------------------------------------------

  @Delete(':id')
  @RequirePermission('sample.archive')
  @HttpCode(204)
  async archive(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.samples.archive(user, id);
  }

  @Post(':id/restore')
  @RequirePermission('sample.restore')
  @HttpCode(200)
  restore(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.samples.restore(user, id);
  }
}
