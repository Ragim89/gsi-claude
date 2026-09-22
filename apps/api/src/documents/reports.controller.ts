import { Controller, Get, Param, ParseUUIDPipe, Query, StreamableFile } from '@nestjs/common';
import { IsOptional, IsUUID } from 'class-validator';
import { AuthUser } from '@gsi/shared-types';
import { CurrentUser, Public, Roles } from '../common/decorators';
import { ReportsService } from './reports.service';

class ReportQueryDto {
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() jobId?: string;
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** GET /reports?clientId=… — the client card's report list. RLS scopes it to the caller's branch. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ReportQueryDto) {
    return this.reports.list(user, q);
  }

  @Get(':id/pdf')
  async download(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const { stream, filename } = await this.reports.open(user, id);
    return new StreamableFile(stream, {
      type: 'application/pdf',
      disposition: `attachment; filename="${filename}"`,
    });
  }
}

@Controller('jobs')
export class JobReportPreviewController {
  constructor(private readonly reports: ReportsService) {}

  /** Draft PDF (watermarked, not stored) so the supervisor can review before approving. */
  @Get(':id/report-preview')
  @Roles('supervisor', 'admin')
  async preview(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return new StreamableFile(await this.reports.preview(user, id), {
      type: 'application/pdf',
      disposition: 'inline; filename="draft-preview.pdf"',
    });
  }
}

@Controller('public')
export class PublicVerifyController {
  constructor(private readonly reports: ReportsService) {}

  /** Third-party authenticity check behind the QR code printed on every issued report. */
  @Public()
  @Get('verify/:token')
  verify(@Param('token') token: string) {
    return this.reports.verify(token.slice(0, 64));
  }
}
