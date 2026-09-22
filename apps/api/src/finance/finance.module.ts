import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { InvoicesService } from './invoices.service';
import { ExpensesService } from './expenses.service';
import { DashboardService } from './dashboard.service';
import { LedgerService } from './ledger.service';
import { FinanceEventsService } from './finance-events.service';

/** Finance domain: billing, costs, multi-currency consolidation, live dashboard. */
@Module({
  controllers: [FinanceController],
  providers: [InvoicesService, ExpensesService, DashboardService, LedgerService, FinanceEventsService],
  exports: [InvoicesService, LedgerService],
})
export class FinanceModule {}
