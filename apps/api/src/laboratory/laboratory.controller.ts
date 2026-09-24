import {
  Body,
  Controller,
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
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  AuthUser,
  INSTRUMENT_STATUSES,
  JOB_PRIORITIES,
  JobPriority,
  LAB_RESULT_TYPES,
  LabResultType,
  TEST_REQUEST_ACTIONS,
  TEST_REQUEST_STATUSES,
  TestRequestAction,
  TestRequestStatus,
} from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { config } from '../config';
import { LabCatalogueService } from './lab-catalogue.service';
import { LabRequestsService, RequestSort } from './lab-requests.service';
import { LabResultsService } from './lab-results.service';
import { LabMediaService } from './lab-media.service';

class TestDto {
  @IsString() @MinLength(2) @MaxLength(60) code: string;
  @IsObject() name: Record<string, string>;
  @IsOptional() @IsString() @MaxLength(40) category?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @IsString() @MaxLength(20) defaultUnit?: string | null;
  @IsOptional() @IsIn(LAB_RESULT_TYPES) resultType?: LabResultType;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
}

class UpdateTestDto {
  @IsOptional() @IsObject() name?: Record<string, string>;
  @IsOptional() @IsString() @MaxLength(40) category?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @IsString() @MaxLength(20) defaultUnit?: string | null;
  @IsOptional() @IsIn(LAB_RESULT_TYPES) resultType?: LabResultType;
  @IsOptional() @Type(() => Number) @IsInt() sortOrder?: number;
  @IsOptional() @Type(() => Boolean) @IsBoolean() isActive?: boolean;
}

class MethodDto {
  @IsUUID() labTestId: string;
  @IsString() @MinLength(2) @MaxLength(60) code: string;
  @IsString() @MinLength(2) @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(200) standardReference?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsOptional() @IsString() @MaxLength(20) defaultUnit?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() detectionLimit?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() quantificationLimit?: number | null;
  @IsOptional() @IsString() @MaxLength(200) accreditationScope?: string | null;
  @IsOptional() @IsDateString() effectiveFrom?: string | null;
}

class UpdateMethodDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(200) standardReference?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsOptional() @IsString() @MaxLength(20) defaultUnit?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() detectionLimit?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() quantificationLimit?: number | null;
  @IsOptional() @IsString() @MaxLength(200) accreditationScope?: string | null;
  @IsOptional() @IsDateString() effectiveFrom?: string | null;
  @IsOptional() @IsDateString() retiredAt?: string | null;
  @IsOptional() @Type(() => Boolean) @IsBoolean() isActive?: boolean;
}

class SpecificationDto {
  @IsUUID() labTestId: string;
  @IsOptional() @IsUUID() testMethodId?: string | null;
  @IsOptional() @IsUUID() commodityId?: string | null;
  @IsOptional() @IsUUID() clientId?: string | null;
  @IsOptional() @IsUUID() contractId?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber() minValue?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() maxValue?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() targetValue?: number | null;
  @IsOptional() @IsString() @MaxLength(20) unit?: string | null;
  @IsOptional() @IsString() @MaxLength(200) qualitativeRequirement?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsDateString() effectiveFrom?: string | null;
  @IsOptional() @IsDateString() effectiveTo?: string | null;
}

class UpdateSpecificationDto {
  @IsOptional() @Type(() => Number) @IsNumber() minValue?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() maxValue?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber() targetValue?: number | null;
  @IsOptional() @IsString() @MaxLength(20) unit?: string | null;
  @IsOptional() @IsString() @MaxLength(200) qualitativeRequirement?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsDateString() effectiveFrom?: string | null;
  @IsOptional() @IsDateString() effectiveTo?: string | null;
  @IsOptional() @Type(() => Boolean) @IsBoolean() isActive?: boolean;
}

class InstrumentDto {
  @IsUUID() laboratoryId: string;
  @IsString() @MinLength(2) @MaxLength(40) code: string;
  @IsString() @MinLength(2) @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(120) manufacturer?: string | null;
  @IsOptional() @IsString() @MaxLength(120) model?: string | null;
  @IsOptional() @IsString() @MaxLength(120) serialNumber?: string | null;
  @IsOptional() @IsDateString() calibrationDueAt?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
}

class UpdateInstrumentDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(120) manufacturer?: string | null;
  @IsOptional() @IsString() @MaxLength(120) model?: string | null;
  @IsOptional() @IsString() @MaxLength(120) serialNumber?: string | null;
  @IsOptional() @IsDateString() calibrationDueAt?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsIn(INSTRUMENT_STATUSES) status?: string;
}

class WantedTestDto {
  @IsUUID() labTestId: string;
  @IsOptional() @IsUUID() testMethodId?: string | null;
}

class CreateRequestsDto {
  @IsUUID() sampleId: string;
  @IsOptional() @IsUUID() laboratoryId?: string;
  @IsOptional() @ValidateNested({ each: true }) @Type(() => WantedTestDto) tests?: WantedTestDto[];
  @IsOptional() @Type(() => Boolean) @IsBoolean() usePanel?: boolean;
  @IsOptional() @IsIn(JOB_PRIORITIES) priority?: JobPriority;
  @IsOptional() @IsDateString() dueAt?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) instructions?: string | null;
  @IsOptional() @Type(() => Boolean) @IsBoolean() skipDuplicates?: boolean;
}

class AssignDto {
  @IsUUID() analystId: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class TransitionDto {
  @IsIn(TEST_REQUEST_ACTIONS) action: TestRequestAction;
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
}

class ResultDto {
  /** A string on purpose: 12.40 must not pass through a JavaScript number on its way in. */
  @IsOptional() numericValue?: number | string | null;
  @IsOptional() @IsString() @MaxLength(2000) textValue?: string | null;
  @IsOptional() @IsBoolean() booleanValue?: boolean | null;
  @IsOptional() @IsString() @MaxLength(500) qualitativeValue?: string | null;
  @IsOptional() @IsString() @MaxLength(20) unit?: string | null;
  @IsOptional() @IsUUID() instrumentId?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) comments?: string | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) version?: number;
}

class CommentDto {
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
}

class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(2000) reason: string;
}

class AttachmentMetaDto {
  @IsOptional() @IsString() @MaxLength(500) caption?: string;
}

class RequestQueryDto {
  @IsOptional() @IsUUID() sampleId?: string;
  @IsOptional() @IsUUID() jobId?: string;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() laboratoryId?: string;
  @IsOptional() @IsUUID() labTestId?: string;
  @IsOptional() @IsUUID() testMethodId?: string;
  @IsOptional() @IsUUID() analystId?: string;
  @IsOptional() @IsUUID() commodityId?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsIn(TEST_REQUEST_STATUSES) status?: TestRequestStatus;
  @IsOptional() @IsIn(JOB_PRIORITIES) priority?: JobPriority;
  @IsOptional() @Type(() => Boolean) @IsBoolean() mine?: boolean;
  @IsOptional() @Type(() => Boolean) @IsBoolean() active?: boolean;
  @IsOptional() @Type(() => Boolean) @IsBoolean() unassigned?: boolean;
  @IsOptional() @Type(() => Boolean) @IsBoolean() overdue?: boolean;
  @IsOptional() @Type(() => Boolean) @IsBoolean() outOfSpec?: boolean;
  /**
   * Spelled out rather than declared a boolean: `Boolean('false')` is true, so a flag that has
   * to be able to say "no" cannot go through the same conversion as the flags that only ever
   * say "yes".
   */
  @IsOptional() @IsIn(['true', 'false']) reviewed?: 'true' | 'false';
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(['requestedAt', 'dueAt', 'priority', 'status', 'updatedAt']) sort?: RequestSort;
  @IsOptional() @IsIn(['asc', 'desc']) dir?: 'asc' | 'desc';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/**
 * The laboratory (docs/WORKFLOWS.md).
 *
 * Reference data — what can be measured, how and to what limits — sits under `/lab/tests`,
 * `/lab/methods`, `/lab/specifications` and `/lab/instruments`. The work itself is
 * `/lab/requests`, and the answers `/lab/requests/:id/result`. Released answers have their own
 * read-only door at `/lab/released`, which is the only one a report is allowed through.
 */
@Controller('lab')
export class LaboratoryController {
  constructor(
    private readonly catalogue: LabCatalogueService,
    private readonly requests: LabRequestsService,
    private readonly results: LabResultsService,
    private readonly media: LabMediaService,
  ) {}

  // ---- Reference data --------------------------------------------------------------------

  @Get('units')
  @RequirePermission('lab.method.read')
  units(@CurrentUser() user: AuthUser) {
    return this.catalogue.units(user);
  }

  @Get('tests')
  @RequirePermission('lab.method.read')
  tests(@CurrentUser() user: AuthUser, @Query('includeInactive') includeInactive?: string) {
    return this.catalogue.tests(user, includeInactive === 'true');
  }

  @Post('tests')
  @RequirePermission('lab.method.manage')
  createTest(@CurrentUser() user: AuthUser, @Body() dto: TestDto) {
    return this.catalogue.createTest(user, dto);
  }

  @Patch('tests/:id')
  @RequirePermission('lab.method.manage')
  updateTest(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTestDto) {
    return this.catalogue.updateTest(user, id, dto);
  }

  @Get('methods')
  @RequirePermission('lab.method.read')
  methods(
    @CurrentUser() user: AuthUser,
    @Query('labTestId') labTestId?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.catalogue.methods(user, { labTestId, includeInactive: includeInactive === 'true' });
  }

  @Post('methods')
  @RequirePermission('lab.method.manage')
  createMethod(@CurrentUser() user: AuthUser, @Body() dto: MethodDto) {
    return this.catalogue.createMethod(user, dto);
  }

  @Patch('methods/:id')
  @RequirePermission('lab.method.manage')
  updateMethod(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMethodDto) {
    return this.catalogue.updateMethod(user, id, dto);
  }

  @Get('specifications')
  @RequirePermission('lab.specification.read')
  specifications(
    @CurrentUser() user: AuthUser,
    @Query('labTestId') labTestId?: string,
    @Query('commodityId') commodityId?: string,
    @Query('clientId') clientId?: string,
    @Query('contractId') contractId?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.catalogue.specifications(user, {
      labTestId, commodityId, clientId, contractId, includeInactive: includeInactive === 'true',
    });
  }

  @Post('specifications')
  @RequirePermission('lab.specification.manage')
  createSpecification(@CurrentUser() user: AuthUser, @Body() dto: SpecificationDto) {
    return this.catalogue.createSpecification(user, dto);
  }

  @Patch('specifications/:id')
  @RequirePermission('lab.specification.manage')
  updateSpecification(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSpecificationDto,
  ) {
    return this.catalogue.updateSpecification(user, id, dto);
  }

  @Get('instruments')
  @RequirePermission('lab.instrument.read')
  instruments(@CurrentUser() user: AuthUser, @Query('laboratoryId') laboratoryId?: string) {
    return this.catalogue.instruments(user, laboratoryId);
  }

  @Post('instruments')
  @RequirePermission('lab.instrument.manage')
  createInstrument(@CurrentUser() user: AuthUser, @Body() dto: InstrumentDto) {
    return this.catalogue.createInstrument(user, dto);
  }

  @Patch('instruments/:id')
  @RequirePermission('lab.instrument.manage')
  updateInstrument(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInstrumentDto,
  ) {
    return this.catalogue.updateInstrument(user, id, dto);
  }

  /** The commodity's standard panel, resolved to catalogue entries and methods. */
  @Get('panels/:commodityId')
  @RequirePermission('lab.test.read')
  panel(
    @CurrentUser() user: AuthUser,
    @Param('commodityId', ParseUUIDPipe) commodityId: string,
    @Query('sampleId') sampleId?: string,
  ) {
    return this.catalogue.panel(user, commodityId, sampleId);
  }

  // ---- Work ------------------------------------------------------------------------------

  @Get('dashboard')
  @RequirePermission('lab.test.read')
  dashboard(
    @CurrentUser() user: AuthUser,
    @Query('laboratoryId') laboratoryId?: string,
    @Query('branchId') branchId?: string,
    @Query('mine') mine?: string,
  ) {
    return this.requests.dashboard(user, {
      laboratoryId,
      branchId,
      analystId: mine === 'true' ? user.id : undefined,
    });
  }

  /** Released results — the only laboratory data a report may quote. */
  @Get('released')
  @RequirePermission('lab.test.read')
  releasedResults(
    @CurrentUser() user: AuthUser,
    @Query('jobId') jobId?: string,
    @Query('sampleId') sampleId?: string,
  ) {
    return this.results.released(user, { jobId, sampleId });
  }

  @Get('requests')
  @RequirePermission('lab.test.read')
  list(@CurrentUser() user: AuthUser, @Query() q: RequestQueryDto) {
    const { reviewed, ...rest } = q;
    return this.requests.list(user, {
      ...rest,
      reviewed: reviewed === undefined ? undefined : reviewed === 'true',
    });
  }

  @Post('requests')
  @RequirePermission('lab.test.request')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateRequestsDto) {
    return this.requests.createMany(user, dto);
  }

  @Get('requests/:id')
  @RequirePermission('lab.test.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.get(user, id);
  }

  @Get('requests/:id/history')
  @RequirePermission('lab.test.read')
  history(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.requests.history(user, id);
  }

  @Get('requests/:id/revisions')
  @RequirePermission('lab.test.read')
  revisions(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.results.revisions(user, id);
  }

  @Post('requests/:id/assignment')
  @RequirePermission('lab.test.assign')
  @HttpCode(200)
  assign(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDto) {
    return this.requests.assign(user, id, dto.analystId, dto.note);
  }

  /** Status moves that carry nothing but a reason: start, hold, resume, reject, cancel. */
  @Post('requests/:id/transitions')
  @HttpCode(200)
  transition(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TransitionDto) {
    return this.requests.transition(user, id, dto.action, dto.reason);
  }

  // ---- The result ------------------------------------------------------------------------

  @Patch('requests/:id/result')
  @RequirePermission('lab.result.enter')
  @HttpCode(200)
  saveResult(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResultDto) {
    return this.results.save(user, id, dto);
  }

  @Post('requests/:id/result/submit')
  @RequirePermission('lab.result.submit')
  @HttpCode(200)
  submit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.results.submit(user, id);
  }

  @Post('requests/:id/result/review')
  @RequirePermission('lab.result.review')
  @HttpCode(200)
  review(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CommentDto) {
    return this.results.review(user, id, dto.comment);
  }

  @Post('requests/:id/result/return')
  @RequirePermission('lab.result.review')
  @HttpCode(200)
  returnToAnalyst(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.results.returnToAnalyst(user, id, dto.reason);
  }

  @Post('requests/:id/result/approve')
  @RequirePermission('lab.result.approve')
  @HttpCode(200)
  approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.results.approve(user, id);
  }

  @Post('requests/:id/result/release')
  @RequirePermission('lab.result.release')
  @HttpCode(200)
  release(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.results.release(user, id);
  }

  @Post('requests/:id/result/amendments')
  @RequirePermission('lab.result.amend')
  amend(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.results.amend(user, id, dto.reason);
  }

  // ---- The paper behind the result -------------------------------------------------------

  /** Instrument printouts, weighing records, worksheets — attached to the revision they belong to. */
  @Get('requests/:id/attachments')
  @RequirePermission('lab.test.read')
  attachments(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.media.list(user, id);
  }

  @Post('requests/:id/attachments')
  @RequirePermission('lab.result.enter')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: config.maxUploadBytes, files: 1 } }))
  addAttachment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() meta: AttachmentMetaDto,
  ) {
    return this.media.add(user, id, file, meta.caption);
  }
}
