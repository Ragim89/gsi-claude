import { Module } from '@nestjs/common';
import { JobReportPreviewController, PublicVerifyController, ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { PdfService } from './pdf.service';

/** Documents domain: letterhead reports, PDF, verification (docs/01-architecture.md, modules 5 & 10). */
@Module({
  controllers: [ReportsController, JobReportPreviewController, PublicVerifyController],
  providers: [ReportsService, PdfService],
  exports: [ReportsService, PdfService],
})
export class DocumentsModule {}
