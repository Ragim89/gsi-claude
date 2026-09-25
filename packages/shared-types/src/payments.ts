import type { Timestamp } from './entities';

/**
 * A payment as its own record, not a side-effect of paying one invoice.
 *
 * `InvoicesService.pay()` (finance.ts's `InvoicePayment`, kept for backward compatibility)
 * still works exactly as before — internally it now creates one of these, fully allocated to
 * the one invoice. What is new: a payment can be split across several invoices, or left
 * partly (or entirely) unallocated — money on account, or an overpayment — and the same idea
 * applies in reverse to an on-account expense (accounts payable).
 */

export const PAYMENT_DIRECTIONS = ['inbound', 'outbound'] as const;
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

export const PAYMENT_METHODS = ['bank_transfer', 'cash', 'card', 'cheque', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const EXPENSE_PAYMENT_STATUSES = ['unpaid', 'partially_paid', 'paid'] as const;
export type ExpensePaymentStatus = (typeof EXPENSE_PAYMENT_STATUSES)[number];

export interface PaymentAllocation {
  id: string;
  paymentId: string;
  invoiceId: string | null;
  invoiceNumber?: string | null;
  expenseId: string | null;
  expenseDescription?: string | null;
  amount: number;
  createdAt: Timestamp;
}

export interface Payment {
  id: string;
  branchId: string;
  branchCode?: string;
  direction: PaymentDirection;
  clientId: string | null;
  clientName?: string | null;
  supplier: string | null;
  method: PaymentMethod;
  reference: string | null;
  currency: string;
  amount: number;
  /** SUM(allocations.amount) — how much of this payment has been applied. */
  allocatedAmount?: number;
  /** amount − allocatedAmount: on-account balance (inbound) or still owed (outbound). */
  unallocatedAmount?: number;
  paymentDate: string;
  notes: string | null;
  allocations?: PaymentAllocation[];
  createdBy: string | null;
  createdByName?: string | null;
  createdAt: Timestamp;
}

export interface InvoiceReminder {
  id: string;
  invoiceId: string;
  note: string | null;
  sentBy: string | null;
  sentByName?: string | null;
  createdAt: Timestamp;
}
