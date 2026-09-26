import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
  StreamableFile,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { map, Observable } from 'rxjs';
import {
  AuthUser,
  ESF_STATUSES,
  EsfStatus,
  EXPENSE_CATEGORIES,
  ExpenseCategory,
  INVOICE_STATUSES,
  InvoiceStatus,
} from '@gsi/shared-types';
import { CurrentUser, RequirePermission } from '../common/decorators';
import { DbService } from '../db/db.service';
import { config } from '../config';
import { InvoicesService } from './invoices.service';
import { ExpensesService } from './expenses.service';
import { DashboardService } from './dashboard.service';
import { FinanceEventsService } from './finance-events.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { JobFinanceService } from './job-finance.service';
import { ClientStatementService } from './client-statement.service';
import { RemindersService } from './reminders.service';
import { EsfService } from './esf.service';

class InvoiceLineDto {
  @IsString() @MinLength(2) @MaxLength(300) description: string;
  @Type(() => Number) @IsNumber() @IsPositive() quantity: number;
  @Type(() => Number) @IsNumber() @Min(0) unitPrice: number;
}

class CreateInvoiceDto {
  @IsUUID() clientId: string;
  @IsOptional() @IsUUID() jobId?: string | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => InvoiceLineDto)
  lines: InvoiceLineDto[];
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) taxRate?: number;
  @IsOptional() @IsDateString() issueDate?: string;
  @IsOptional() @IsDateString() dueDate?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string | null;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(3) currency?: string;
  /** Opt-in multi-country fiscal path (migration 028) — see InvoicesService.CreateInvoiceInput. */
  @IsOptional() @IsUUID() legalEntityId?: string | null;
  @IsOptional() @IsString() @MaxLength(20) taxCode?: string;
}

class EsfStatusDto {
  @IsIn(ESF_STATUSES) status: EsfStatus;
  @IsOptional() @IsString() @MaxLength(100) registrationNumber?: string | null;
}

class PayDto {
  @Type(() => Number) @IsNumber() @IsPositive() amount: number;
  @IsOptional() @IsDateString() paidOn?: string;
}

class InvoiceQueryDto {
  @IsOptional() @IsIn(INVOICE_STATUSES) status?: InvoiceStatus;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @Type(() => Boolean) @IsBoolean() overdue?: boolean;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() jobId?: string;
}

class CreateExpenseDto {
  @IsIn(EXPENSE_CATEGORIES) category: ExpenseCategory;
  @IsString() @MinLength(2) @MaxLength(300) description: string;
  @Type(() => Number) @IsNumber() @IsPositive() amount: number;
  @IsOptional() @IsString() @MaxLength(200) supplier?: string | null;
  @IsOptional() @IsDateString() expenseDate?: string;
  @IsOptional() @IsUUID() jobId?: string | null;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(3) currency?: string;
  @IsOptional() @IsBoolean() onAccount?: boolean;
}

class ExpenseQueryDto {
  @IsOptional() @IsIn(EXPENSE_CATEGORIES) category?: ExpenseCategory;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() branchId?: string;
}

class PeriodDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() branchId?: string;
}

class FxRateDto {
  @IsString() @MinLength(3) @MaxLength(3) currency: string;
  @Type(() => Number) @IsNumber() @IsPositive() rate: number;
  @IsOptional() @IsDateString() rateDate?: string;
}

class ReminderDto {
  @IsOptional() @IsString() @MaxLength(2000) note?: string | null;
}

/** Finance & billing domain (docs/01 modules 6–7, docs/03). */
@Controller('finance')
@RequirePermission('finance.read')
export class FinanceController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly expenses: ExpensesService,
    private readonly dashboard: DashboardService,
    private readonly events: FinanceEventsService,
    private readonly invoicePdf_: InvoicePdfService,
    private readonly db: DbService,
    private readonly jobFinance: JobFinanceService,
    private readonly clientStatement: ClientStatementService,
    private readonly reminders: RemindersService,
    private readonly esf: EsfService,
  ) {}

  // ---- dashboard ---------------------------------------------------------------
  @Get('dashboard')
  getDashboard(@CurrentUser() user: AuthUser, @Query() q: PeriodDto) {
    return this.dashboard.build(user, q.from, q.to, q.branchId);
  }

  /**
   * Server-sent events: one message per posted financial fact, so the dashboard updates
   * without polling. HQ roles receive the whole group, branch users only their branch.
   */
  @Sse('stream')
  stream(@CurrentUser() user: AuthUser): Observable<MessageEvent> {
    const scope = user.scope === 'global' ? null : user.branchId;
    return this.events.stream(scope).pipe(map((data) => ({ data }) as MessageEvent));
  }

  // ---- invoices ----------------------------------------------------------------
  @Get('invoices')
  listInvoices(@CurrentUser() user: AuthUser, @Query() q: InvoiceQueryDto) {
    return this.invoices.list(user, q);
  }

  /** Aggregates behind the invoices page (invoiced, collected, outstanding, who to chase). */
  @Get('invoices-summary')
  invoiceSummary(@CurrentUser() user: AuthUser, @Query() q: PeriodDto) {
    return this.invoices.summary(user, q);
  }

  @Get('invoices/:id')
  getInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.get(user, id);
  }

  @Get('invoices/:id/payments')
  invoicePayments(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.payments(user, id);
  }

  /** Printable invoice on the branch letterhead. */
  @Get('invoices/:id/pdf')
  async invoicePdf(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const { pdf, filename } = await this.invoicePdf_.render(user, id);
    return new StreamableFile(pdf, { type: 'application/pdf', disposition: `attachment; filename="${filename}"` });
  }

  @Post('invoices')
  @RequirePermission('invoice.create')
  createInvoice(@CurrentUser() user: AuthUser, @Body() dto: CreateInvoiceDto) {
    return this.invoices.create(user, dto);
  }

  @Post('invoices/:id/issue')
  @RequirePermission('invoice.issue')
  @HttpCode(200)
  issueInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.issue(user, id);
  }

  @Post('invoices/:id/pay')
  @RequirePermission('invoice.pay')
  @HttpCode(200)
  payInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PayDto) {
    return this.invoices.pay(user, id, dto.amount, dto.paidOn);
  }

  @Post('invoices/:id/cancel')
  @RequirePermission('invoice.cancel')
  @HttpCode(200)
  cancelInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.cancel(user, id);
  }

  @Delete('invoices/:id')
  @RequirePermission('invoice.delete')
  @HttpCode(204)
  async deleteInvoice(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.invoices.remove(user, id);
  }

  /**
   * Mapping/export boundary for the future Kazakhstan ИС ЭСФ integration (docs/FISCAL_COMPLIANCE.md
   * §ESF readiness). Returns the structured data an operator submits by hand today; this never
   * calls a government system and never marks an invoice "submitted"/"registered" on its own.
   */
  @Get('invoices/:id/esf-export')
  esfExport(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.esf.exportPayload(user, id);
  }

  /** Records what actually happened in the real government system — never simulated here. */
  @Post('invoices/:id/esf-status')
  @RequirePermission('invoice.issue')
  @HttpCode(200)
  setEsfStatus(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EsfStatusDto) {
    return this.esf.setStatus(user, id, dto.status, dto.registrationNumber ?? null);
  }

  // ---- expenses ----------------------------------------------------------------
  @Get('expenses')
  listExpenses(@CurrentUser() user: AuthUser, @Query() q: ExpenseQueryDto) {
    return this.expenses.list(user, q);
  }

  /** Aggregates behind the expenses page (totals, trend, mix by category / branch / supplier). */
  @Get('expenses-summary')
  expenseSummary(@CurrentUser() user: AuthUser, @Query() q: PeriodDto) {
    return this.expenses.summary(user, q);
  }

  @Post('expenses')
  @RequirePermission('expense.create')
  createExpense(@CurrentUser() user: AuthUser, @Body() dto: CreateExpenseDto) {
    return this.expenses.create(user, dto);
  }

  @Delete('expenses/:id')
  @RequirePermission('expense.delete')
  @HttpCode(204)
  async deleteExpense(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.expenses.remove(user, id);
  }

  // ---- fx rates ----------------------------------------------------------------
  @Get('fx-rates')
  listRates(@CurrentUser() user: AuthUser) {
    return this.db.tx(user, (tx) =>
      tx.many(
        `SELECT DISTINCT ON (currency) id, currency, base_currency AS "baseCurrency", rate::float8 AS rate,
                to_char(rate_date, 'YYYY-MM-DD') AS "rateDate"
         FROM fx_rates WHERE base_currency = $1
         ORDER BY currency, rate_date DESC`,
        [config.consolidationCurrency],
      ),
    );
  }

  /** ASSUMPTION: rates are entered manually in MVP-3; a central-bank feed is a later integration. */
  @Post('fx-rates')
  @RequirePermission('fx.manage')
  upsertRate(@CurrentUser() user: AuthUser, @Body() dto: FxRateDto) {
    return this.db.tx(user, (tx) =>
      tx.one(
        `INSERT INTO fx_rates (currency, base_currency, rate, rate_date)
         VALUES (upper($1), $2, $3, COALESCE($4::date, current_date))
         ON CONFLICT (currency, base_currency, rate_date) DO UPDATE SET rate = EXCLUDED.rate
         RETURNING id, currency, base_currency AS "baseCurrency", rate::float8 AS rate,
                   to_char(rate_date, 'YYYY-MM-DD') AS "rateDate"`,
        [dto.currency, config.consolidationCurrency, dto.rate, dto.rateDate ?? null],
      ),
    );
  }

  // ---- job costing / margin ------------------------------------------------------
  /** Reuses the permission reserved for this since PHASE 3 (job.read_finance). */
  @Get('jobs/:id/summary')
  @RequirePermission('job.read_finance')
  jobFinanceSummary(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobFinance.summary(user, id);
  }

  // ---- client statement -----------------------------------------------------------
  @Get('clients/:id/statement')
  clientStatementFor(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: PeriodDto) {
    return this.clientStatement.build(user, id, q.from, q.to);
  }

  // ---- overdue reminders (a log, not a send — see reminders.service.ts) -----------
  @Get('invoices/:id/reminders')
  listReminders(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.reminders.list(user, id);
  }

  @Post('invoices/:id/reminders')
  @RequirePermission('invoice.remind')
  @HttpCode(201)
  logReminder(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReminderDto) {
    return this.reminders.log(user, id, dto.note);
  }
}
