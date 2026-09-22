import type { ServiceType } from './enums';
import type { Timestamp } from './entities';

export const INVOICE_STATUSES = ['draft', 'issued', 'partially_paid', 'paid', 'cancelled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const EXPENSE_CATEGORIES = [
  'salary',
  'travel',
  'subcontractor',
  'lab_materials',
  'equipment',
  'office',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const ACCOUNT_GROUPS = ['revenue', 'expense', 'receivable', 'cash', 'tax'] as const;
export type AccountGroup = (typeof ACCOUNT_GROUPS)[number];

/** Roles allowed to see money (mirrors app_sees_finance() in the DB). */
export const FINANCE_ROLES = ['finance_controller', 'supervisor', 'cfo', 'admin'] as const;
/** Roles allowed to create invoices / expenses / rates. */
export const FINANCE_WRITE_ROLES = ['finance_controller', 'admin'] as const;

export interface InvoiceLine {
  id: string;
  invoiceId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  sortOrder: number;
}

export interface Invoice {
  id: string;
  branchId: string;
  branchCode?: string;
  clientId: string;
  clientName?: string;
  jobId: string | null;
  jobNumber?: string | null;
  serviceType?: ServiceType | null;
  invoiceNumber: string;
  status: InvoiceStatus;
  currency: string;
  amountNet: number;
  taxRate: number;
  taxAmount: number;
  amountTotal: number;
  amountPaid: number;
  /** amountTotal − amountPaid */
  amountDue?: number;
  issueDate: string;
  dueDate: string | null;
  paidAt: Timestamp | null;
  notes: string | null;
  /** Days past due for an unpaid invoice; negative when not due yet. */
  daysOverdue?: number;
  lines?: InvoiceLine[];
  createdAt: Timestamp;
}

export interface Expense {
  id: string;
  branchId: string;
  branchCode?: string;
  category: ExpenseCategory;
  description: string;
  supplier: string | null;
  currency: string;
  amount: number;
  expenseDate: string;
  jobId: string | null;
  jobNumber?: string | null;
  createdAt: Timestamp;
}

export interface FxRate {
  id: string;
  currency: string;
  baseCurrency: string;
  rate: number;
  rateDate: string;
}

// ---------------------------------------------------------------------------
// Dashboard payloads (docs/03-finance-dashboard.md). All *Base amounts are in the
// group consolidation currency; branch rows also carry their local currency.
// ---------------------------------------------------------------------------

export interface BranchFinanceRow {
  branchId: string;
  branchCode: string;
  country: string;
  city: string;
  currency: string;
  revenueBase: number;
  expenseBase: number;
  profitBase: number;
  cashBase: number;
  receivableBase: number;
  /** Cash + receivables. */
  netAssetsBase: number;
  revenueLocal: number;
  jobCount: number;
}

export interface MonthlyPoint {
  month: string; // YYYY-MM
  revenueBase: number;
  expenseBase: number;
  profitBase: number;
}

export interface CashFlowPoint {
  month: string;
  inflowBase: number;
  outflowBase: number;
  netBase: number;
}

export interface BreakdownSlice {
  key: string;
  label?: string;
  amountBase: number;
  share: number;
}

export interface ArAgingBucket {
  bucket: '0-30' | '31-60' | '61-90' | '90+';
  amountBase: number;
  invoiceCount: number;
}

export interface OperationalKpis {
  jobsInPeriod: number;
  jobsApproved: number;
  /** Average calendar days from job creation to issued report. */
  avgJobToReportDays: number | null;
  activeInspectors: number;
  jobsPerInspector: number;
  reportsInPeriod: number;
}

export interface FinanceDashboard {
  baseCurrency: string;
  period: { from: string; to: string };
  totals: {
    /** Cash + receivables across the group, consolidated. */
    capitalizationBase: number;
    revenueBase: number;
    expenseBase: number;
    profitBase: number;
    marginPct: number | null;
    cashBase: number;
    receivableBase: number;
    overdueBase: number;
  };
  branches: BranchFinanceRow[];
  monthly: MonthlyPoint[];
  cashFlow: CashFlowPoint[];
  revenueByService: BreakdownSlice[];
  revenueByClient: BreakdownSlice[];
  expensesByCategory: BreakdownSlice[];
  arAging: ArAgingBucket[];
  kpis: OperationalKpis;
  /** Server time of the aggregate — the dashboard shows when it last refreshed. */
  generatedAt: Timestamp;
}

/** Event pushed over SSE when a financial fact is posted. */
export interface FinanceEvent {
  branchId: string;
  group: AccountGroup;
  date: string;
  amountBase: number;
  source: string;
}
