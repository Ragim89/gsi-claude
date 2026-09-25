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
  StreamableFile,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  ValidateNested,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  AuthUser,
  REPORT_STATUSES,
  REPORT_TYPES,
  ReportContent,
  ReportStatus,
  ReportType,
} from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { ReportDocumentsService } from './report-documents.service';
import { ReportTemplatesService } from './report-templates.service';
import { ReportDataService } from './report-data.service';

/**
 * The authored part of a document.
 *
 * Declared as a nested DTO and validated as one: without `@ValidateNested` on the field that
 * carries it, class-validator walks past the object entirely, and a paragraph filed under a
 * name the renderer does not read would be stored, never printed, and never complained about.
 * A surveyor who writes a conclusion and does not see it on the page should be told why.
 */
class ContentDto {
  @IsOptional() @IsString() @MaxLength(20000) executiveSummary?: string | null;
  @IsOptional() @IsString() @MaxLength(20000) observations?: string | null;
  @IsOptional() @IsString() @MaxLength(20000) conclusions?: string | null;
  @IsOptional() @IsString() @MaxLength(20000) recommendations?: string | null;
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) photoIds?: string[];
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) inspectionIds?: string[];
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) sampleIds?: string[];
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) testRequestIds?: string[];
  @IsOptional() @IsObject() options?: Record<string, unknown>;
}

class CreateReportDto {
  @IsUUID() jobId: string;
  @IsIn(REPORT_TYPES) reportType: ReportType;
  @IsOptional() @IsIn(['en', 'tr', 'ru']) language?: string;
  @IsOptional() @IsString() @MaxLength(300) title?: string | null;
  @IsOptional() @IsUUID() templateId?: string | null;
  @IsOptional() @IsUUID() inspectionId?: string | null;
  @IsOptional() @IsUUID() sampleId?: string | null;
  @IsOptional() @ValidateNested() @Type(() => ContentDto) content?: ContentDto;
}

class UpdateReportDto {
  @IsOptional() @IsString() @MaxLength(300) title?: string | null;
  @IsOptional() @IsIn(['en', 'tr', 'ru']) language?: string;
  @IsOptional() @IsUUID() templateId?: string | null;
  @IsOptional() @ValidateNested() @Type(() => ContentDto) content?: ContentDto;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) lockVersion?: number;
}

class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(2000) reason: string;
}

class CommentDto {
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
}

class ReportQueryDto {
  @IsOptional() @IsUUID() jobId?: string;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsIn(REPORT_TYPES) reportType?: ReportType;
  @IsOptional() @IsIn(REPORT_STATUSES) status?: ReportStatus;
  @IsOptional() @IsIn(['en', 'tr', 'ru']) language?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsIn(['reportNumber', 'issuedAt', 'status', 'updatedAt', 'createdAt'])
  sort?: 'reportNumber' | 'issuedAt' | 'status' | 'updatedAt' | 'createdAt';
  @IsOptional() @IsIn(['asc', 'desc']) dir?: 'asc' | 'desc';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

class TemplateDto {
  @IsString() @MinLength(2) @MaxLength(60) code: string;
  @IsString() @MinLength(2) @MaxLength(200) name: string;
  @IsIn(REPORT_TYPES) reportType: ReportType;
  @IsOptional() @IsUUID() branchId?: string | null;
  @IsOptional() @IsIn(['en', 'tr', 'ru']) language?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsOptional() @IsObject() definition?: Record<string, unknown>;
}

class UpdateTemplateDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) name?: string;
  @IsOptional() @IsIn(['en', 'tr', 'ru']) language?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) description?: string | null;
  @IsOptional() @IsObject() definition?: Record<string, unknown>;
  @IsOptional() @Type(() => Boolean) @IsBoolean() isActive?: boolean;
}

/**
 * Documents (docs/API.md).
 *
 * The register is `/reports`; one document is `/reports/:id`, and every move it can make is its
 * own endpoint rather than a `PATCH status`. `/reports/:id/preview` renders a watermarked draft
 * on demand; `/reports/:id/pdf` streams the file that was stored when it was issued.
 */
@Controller('reports')
export class ReportDocumentsController {
  constructor(
    private readonly reports: ReportDocumentsService,
    private readonly data: ReportDataService,
  ) {}

  @Get()
  @RequirePermission('report.read')
  list(@CurrentUser() user: AuthUser, @Query() q: ReportQueryDto) {
    return this.reports.list(user, q);
  }

  /** What a document could be built from, before there is a document. */
  @Get('sources/:jobId')
  @RequirePermission('report.create')
  sources(@CurrentUser() user: AuthUser, @Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.data.sources(user, jobId);
  }

  @Post()
  @RequirePermission('report.create')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateReportDto) {
    return this.reports.create(user, dto as never);
  }

  @Get(':id')
  @RequirePermission('report.read')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.get(user, id);
  }

  @Patch(':id')
  @RequirePermission('report.update')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReportDto) {
    return this.reports.update(user, id, dto as { content?: ReportContent });
  }

  @Get(':id/versions')
  @RequirePermission('report.read')
  versions(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.versions(user, id);
  }

  @Get(':id/history')
  @RequirePermission('report.read')
  history(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.history(user, id);
  }

  @Get(':id/sources')
  @RequirePermission('report.read')
  documentSources(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.sources(user, id);
  }

  // ---- The moves ---------------------------------------------------------------------------

  @Post(':id/submit')
  @RequirePermission('report.submit_review')
  @HttpCode(200)
  submit(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.submit(user, id);
  }

  @Post(':id/review')
  @RequirePermission('report.review')
  @HttpCode(200)
  review(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CommentDto) {
    return this.reports.review(user, id, dto.comment);
  }

  @Post(':id/changes')
  @RequirePermission('report.review')
  @HttpCode(200)
  requestChanges(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.reports.requestChanges(user, id, dto.reason);
  }

  @Post(':id/approve')
  @RequirePermission('report.approve')
  @HttpCode(200)
  approve(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.approve(user, id);
  }

  @Post(':id/issue')
  @RequirePermission('report.issue')
  @HttpCode(200)
  issue(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.issue(user, id);
  }

  @Post(':id/revisions')
  @RequirePermission('report.revise')
  revise(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.reports.revise(user, id, dto.reason);
  }

  @Post(':id/cancel')
  @RequirePermission('report.cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.reports.cancel(user, id, dto.reason);
  }

  @Delete(':id')
  @RequirePermission('report.archive')
  @HttpCode(204)
  archive(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.archive(user, id);
  }

  @Post(':id/restore')
  @RequirePermission('report.restore')
  @HttpCode(204)
  restore(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reports.restore(user, id);
  }

  // ---- Paper -------------------------------------------------------------------------------

  /** Watermarked, rendered on demand, never stored: a preview is not a document. */
  @Get(':id/preview')
  @RequirePermission('report.preview')
  async preview(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return new StreamableFile(await this.reports.preview(user, id), {
      type: 'application/pdf',
      disposition: 'inline; filename="draft-preview.pdf"',
    });
  }

  /** The issued file, byte for byte as it was stored. */
  @Get(':id/file')
  @RequirePermission('report.download')
  async file(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('version') version?: string,
  ) {
    const { stream, filename } = await this.reports.download(
      user,
      id,
      version ? Number(version) : undefined,
    );
    return new StreamableFile(stream, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }
}

@Controller('report-templates')
export class ReportTemplatesController {
  constructor(private readonly templates: ReportTemplatesService) {}

  @Get()
  @RequirePermission('report.read')
  list(
    @CurrentUser() user: AuthUser,
    @Query('reportType') reportType?: ReportType,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.templates.list(user, { reportType, includeInactive: includeInactive === 'true' });
  }

  @Post()
  @RequirePermission('report.manage_templates')
  create(@CurrentUser() user: AuthUser, @Body() dto: TemplateDto) {
    return this.templates.create(user, dto as never);
  }

  @Patch(':id')
  @RequirePermission('report.manage_templates')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTemplateDto) {
    return this.templates.update(user, id, dto as never);
  }
}
