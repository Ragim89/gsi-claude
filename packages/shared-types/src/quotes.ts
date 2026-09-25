import type { Permission } from './rbac';

/**
 * The quote lifecycle.
 *
 * Unlike a report, a quote is disposable: sending it again after the client asks for changes
 * is normal business, not a correction that has to leave the old copy on record. So there is
 * no revision/snapshot machinery here — just the same one-place-writes-the-status shape as
 * every other lifecycle in the system (see job-workflow.ts, reports.ts).
 */

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const QUOTE_ACTIONS = ['send', 'accept', 'reject', 'expire', 'revise', 'cancel'] as const;
export type QuoteAction = (typeof QUOTE_ACTIONS)[number];

export type QuoteGuard = 'hasLines';

export interface QuoteTransition {
  action: QuoteAction;
  from: readonly QuoteStatus[];
  to: QuoteStatus;
  permission: Permission;
  requiresReason?: boolean;
  guards?: readonly QuoteGuard[];
}

export const QUOTE_WORKFLOW: readonly QuoteTransition[] = [
  { action: 'send', from: ['draft'], to: 'sent', permission: 'quote.send', guards: ['hasLines'] },
  { action: 'accept', from: ['sent'], to: 'accepted', permission: 'quote.decide' },
  { action: 'reject', from: ['sent'], to: 'rejected', permission: 'quote.decide', requiresReason: true },
  { action: 'expire', from: ['sent'], to: 'expired', permission: 'quote.decide' },
  /** The only way to change a sent quote: back to draft, with the reason on the record. */
  { action: 'revise', from: ['sent', 'rejected', 'expired'], to: 'draft', permission: 'quote.update', requiresReason: true },
  { action: 'cancel', from: ['draft', 'sent'], to: 'cancelled', permission: 'quote.cancel', requiresReason: true },
];

export const QUOTE_FINAL_STATUSES: readonly QuoteStatus[] = ['accepted', 'rejected', 'expired', 'cancelled'];

export function quoteTransitionFor(action: QuoteAction): QuoteTransition | undefined {
  return QUOTE_WORKFLOW.find((t) => t.action === action);
}

export function quoteActionsFrom(status: QuoteStatus): QuoteTransition[] {
  return QUOTE_WORKFLOW.filter((t) => t.from.includes(status));
}

export const QUOTE_TRANSITIONS: Record<QuoteStatus, QuoteTransition[]> = Object.fromEntries(
  QUOTE_STATUSES.map((s) => [s, quoteActionsFrom(s)]),
) as Record<QuoteStatus, QuoteTransition[]>;

export interface QuoteLine {
  id: string;
  quoteId: string;
  serviceId: string | null;
  serviceCode?: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  sortOrder: number;
}

export interface Quote {
  id: string;
  branchId: string;
  branchCode?: string;
  clientId: string;
  clientName?: string;
  jobId: string | null;
  jobNumber?: string | null;
  quoteNumber: string;
  status: QuoteStatus;
  currency: string;
  amountNet: number;
  taxRate: number;
  taxAmount: number;
  amountTotal: number;
  issueDate: string;
  validUntil: string | null;
  sentAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  notes: string | null;
  version: number;
  lines?: QuoteLine[];
  /** What this user may do right now; only the single-quote endpoint fills it. */
  actions?: QuoteAction[];
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface QuoteStatusHistoryEntry {
  id: string;
  quoteId: string;
  fromStatus: QuoteStatus | null;
  toStatus: QuoteStatus;
  changedBy: string | null;
  changedByName?: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}
