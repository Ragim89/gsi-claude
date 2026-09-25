import { Controller, Get, Param, ParseUUIDPipe, StreamableFile } from '@nestjs/common';
import { AuthUser } from '@gsi/shared-types';
import { CurrentUser, Public, RequirePermission } from '../common/decorators';
import { ReportsService } from './reports.service';
import { ReportDocumentsService } from './report-documents.service';

/**
 * The endpoints that existed before documents had a workflow, kept because things depend on
 * them: the QR code printed on 520 reports, and the download link in every client card.
 * The register itself now lives in `ReportDocumentsController`.
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get(':id/pdf')
  @RequirePermission('report.download')
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
  @RequirePermission('report.preview')
  async preview(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return new StreamableFile(await this.reports.preview(user, id), {
      type: 'application/pdf',
      disposition: 'inline; filename="draft-preview.pdf"',
    });
  }
}

@Controller('public')
export class PublicVerifyController {
  constructor(private readonly documents: ReportDocumentsService) {}

  /**
   * The third-party check behind the QR code printed on every issued document.
   *
   * It answers for the revision that was actually printed, so a copy that a later revision has
   * replaced says so rather than claiming to be the current one, and a cancelled document says
   * it was cancelled rather than answering 404 — an authenticity check that hides the awkward
   * cases teaches people not to trust it.
   *
   * What it does not say is whose cargo it was. The 520 documents issued before this used to
   * return the client's name to anyone holding the token; they no longer do.
   */
  @Public()
  @Get('verify/:token')
  verify(@Param('token') token: string) {
    return this.documents.verify(token.slice(0, 64));
  }
}
