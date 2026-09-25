import { Module } from '@nestjs/common';
import { JobReportPreviewController, PublicVerifyController, ReportsController } from './reports.controller';
import { ReportDocumentsController, ReportTemplatesController } from './report-documents.controller';
import { ReportsService } from './reports.service';
import { ReportDocumentsService } from './report-documents.service';
import { ReportDataService } from './report-data.service';
import { ReportTemplatesService } from './report-templates.service';
import { ReportWorkflowService } from './report-workflow.service';
import { PdfService } from './pdf.service';

/**
 * Documents domain: reports and certificates, their templates, the PDF renderer and the public
 * verification behind the QR code (docs/WORKFLOWS.md).
 *
 * `ReportsService` keeps the pre-approval preview and the original QR verification;
 * `ReportDocumentsService` is the document workflow built around it. They share one table, one
 * numbering sequence and one renderer — there is no second reports module.
 */
@Module({
  controllers: [
    ReportsController,
    ReportDocumentsController,
    ReportTemplatesController,
    JobReportPreviewController,
    PublicVerifyController,
  ],
  providers: [
    ReportsService,
    ReportDocumentsService,
    ReportDataService,
    ReportTemplatesService,
    ReportWorkflowService,
    PdfService,
  ],
  exports: [ReportsService, ReportDocumentsService, PdfService],
})
export class DocumentsModule {}
