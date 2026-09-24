import type { ServiceType } from './enums';

/** A person at a client: operations, documentation, accounts. */
export interface ClientContact {
  id: string;
  branchId: string;
  clientId: string;
  fullName: string;
  position: string | null;
  email: string | null;
  phone: string | null;
  /** The default addressee; at most one per client. */
  isPrimary: boolean;
  notes: string | null;
  createdAt: string;
}

export const CONTRACT_STATUSES = ['draft', 'active', 'suspended', 'expired', 'terminated'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export interface Contract {
  id: string;
  branchId: string;
  branchCode?: string;
  clientId: string;
  clientName?: string;
  contractNo: string;
  title: string | null;
  status: ContractStatus;
  signedOn: string | null;
  validFrom: string | null;
  validTo: string | null;
  currency: string | null;
  valueAmount: number | null;
  /** Days from invoice date to due date — the default when invoicing against this contract. */
  paymentTermsDays: number | null;
  incoterms: string | null;
  services: ServiceType[];
  commodityId: string | null;
  notes: string | null;
  fileName: string | null;
  fileSize: number | null;
  /** Short-lived link to the signed document, when one is attached. */
  fileUrl?: string | null;
  jobCount?: number;
  /** Days until it expires; negative once it has. Null when open-ended. */
  daysToExpiry?: number | null;
  createdAt: string;
}

/** One page of a list, with the total so the interface can show "1 of 12". */
export interface Page<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
}
