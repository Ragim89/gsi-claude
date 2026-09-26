import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { EmailModule } from '../email/email.module';
import { FinanceController } from './finance.controller';
import { QuotesController } from './quotes.controller';
import { PricingController } from './pricing.controller';
import { PaymentsController } from './payments.controller';
import { InvoicesService } from './invoices.service';
import { ExpensesService } from './expenses.service';
import { DashboardService } from './dashboard.service';
import { LedgerService } from './ledger.service';
import { FinanceEventsService } from './finance-events.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { PaymentsService } from './payments.service';
import { QuotesService } from './quotes.service';
import { QuoteWorkflowService } from './quote-workflow.service';
import { ServicesPricingService } from './services-pricing.service';
import { JobFinanceService } from './job-finance.service';
import { ClientStatementService } from './client-statement.service';
import { RemindersService } from './reminders.service';
import { LegalEntityService } from './legal-entity.service';
import { JurisdictionProfileService } from './jurisdiction-profile.service';
import { EsfService } from './esf.service';

/** Finance domain: billing, costs, multi-currency consolidation, live dashboard. */
@Module({
  imports: [DocumentsModule, EmailModule],
  controllers: [FinanceController, QuotesController, PricingController, PaymentsController],
  providers: [
    InvoicesService, ExpensesService, DashboardService, LedgerService, FinanceEventsService, InvoicePdfService,
    PaymentsService, QuotesService, QuoteWorkflowService, ServicesPricingService, JobFinanceService,
    ClientStatementService, RemindersService, LegalEntityService, JurisdictionProfileService, EsfService,
  ],
  exports: [InvoicesService, LedgerService, PaymentsService, LegalEntityService, JurisdictionProfileService],
})
export class FinanceModule {}
