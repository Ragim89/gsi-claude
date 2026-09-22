import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { FinanceController } from './finance.controller';
import { InvoicesService } from './invoices.service';
import { ExpensesService } from './expenses.service';
import { DashboardService } from './dashboard.service';
import { LedgerService } from './ledger.service';
import { FinanceEventsService } from './finance-events.service';
import { InvoicePdfService } from './invoice-pdf.service';

/** Finance domain: billing, costs, multi-currency consolidation, live dashboard. */
@Module({
  imports: [DocumentsModule],
  controllers: [FinanceController],
  providers: [InvoicesService, ExpensesService, DashboardService, LedgerService, FinanceEventsService, InvoicePdfService],
  exports: [InvoicesService, LedgerService],
})
export class FinanceModule {}
