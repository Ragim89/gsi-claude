import type { Timestamp } from './entities';

/**
 * Multi-country finance compliance (migration 028_fiscal_compliance.sql).
 *
 * Two layers, kept deliberately separate:
 *  - `LegalEntity` — the fiscal identity an office trades under (legal name, fiscal
 *    identifier, VAT registration, bank details). Country-agnostic; exists for any country.
 *  - `JurisdictionProfile` — versioned, effective-dated tax/compliance *rules* for one
 *    country. Only Kazakhstan has a verified one today (see docs/FISCAL_COMPLIANCE.md);
 *    every other country simply has none, and the API refuses to build a "fiscal" invoice
 *    for it rather than guessing.
 *
 * An invoice created without a `legalEntityId` is untouched "legacy" behaviour: same flat
 * `taxRate`/`taxAmount` it always had, `isLegacyFiscal: true`, no `fiscalSnapshot`.
 */

export const ESF_STATUSES = [
  'not_required', 'draft', 'ready', 'submitted', 'registered', 'corrected', 'additional', 'cancelled',
] as const;
export type EsfStatus = (typeof ESF_STATUSES)[number];

export const JURISDICTION_PROFILE_STATUSES = ['verified', 'compliance_config_required'] as const;
export type JurisdictionProfileStatus = (typeof JURISDICTION_PROFILE_STATUSES)[number];

export const TAX_CODE_KINDS = ['standard', 'zero', 'exempt', 'no_tax'] as const;
export type TaxCodeKind = (typeof TAX_CODE_KINDS)[number];

export interface JurisdictionTaxCode {
  /** Stable short code referenced by invoices.tax_code, e.g. 'STANDARD' | 'ZERO' | 'EXEMPT'. */
  code: string;
  label: string;
  rate: number;
  kind: TaxCodeKind;
  notes?: string;
}

/** The shape stored in jurisdiction_profiles.config (jsonb). */
export interface JurisdictionProfileConfig {
  taxCodes: JurisdictionTaxCode[];
  invoiceRequiredFields: string[];
  sellerFiscalIdentifierLabel: string;
  buyerFiscalIdentifierLabel: string | null;
  supplyDateRequired: boolean;
  numberingRules: { resetPeriod: 'year' | 'never'; description: string };
  roundingRule: { decimals: number; mode: 'half_up' };
  bankPaymentRequirements: string[];
  eInvoice: { required: boolean; system: string | null; description: string };
  locale: { documentTerm: Record<string, string>; defaultLocale: string };
  sourceCitations: string[];
}

export interface JurisdictionProfile {
  id: string;
  countryCode: string;
  profileVersion: number;
  status: JurisdictionProfileStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  defaultDocumentCurrency: string;
  config: JurisdictionProfileConfig;
  sourceNotes: string | null;
  createdAt: Timestamp;
}

export interface LegalEntity {
  id: string;
  organizationId: string;
  countryId: string;
  countryCode?: string;
  countryName?: string;
  code: string;
  legalName: string;
  legalAddress: string | null;
  fiscalIdentifierType: string | null;
  fiscalIdentifier: string | null;
  vatRegistered: boolean;
  vatRegistrationNumber: string | null;
  defaultTaxCode: string | null;
  defaultCurrency: string;
  bankName: string | null;
  bankAccount: string | null;
  bankSwift: string | null;
  invoiceNumberPrefix: string | null;
  eInvoiceStatus: EsfStatus;
  isActive: boolean;
  /** Whether jurisdictionProfiles has a verified row for this entity's country right now. */
  hasVerifiedProfile?: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** One invoice line as computed by the fiscal calculation (see fiscal-calc.ts). */
export interface FiscalLineSnapshot {
  description: string;
  quantity: number;
  unitPrice: number;
  netAmount: number;
  taxAmount: number;
  grossAmount: number;
}

/**
 * Immutable snapshot written to invoices.fiscal_snapshot at issue time. Nothing here is ever
 * recomputed from live configuration after the fact — a later jurisdiction profile version or
 * legal-entity edit never changes what an already-issued invoice says it charged.
 */
export interface FiscalSnapshot {
  legalEntity: {
    id: string;
    legalName: string;
    legalAddress: string | null;
    fiscalIdentifierType: string | null;
    fiscalIdentifier: string | null;
    vatRegistered: boolean;
    vatRegistrationNumber: string | null;
    bankName: string | null;
    bankAccount: string | null;
    bankSwift: string | null;
  };
  buyer: {
    name: string;
    address: string | null;
    fiscalIdentifier: string | null;
  };
  jurisdiction: {
    countryCode: string;
    profileId: string;
    profileVersion: number;
    sourceNotes: string | null;
  };
  taxCode: string;
  taxCodeLabel: string;
  taxRate: number;
  supplyDate: string;
  documentCurrency: string;
  lines: FiscalLineSnapshot[];
  subtotalNet: number;
  taxAmount: number;
  grandTotal: number;
  numberingContext: { invoiceNumber: string };
  eInvoice: { required: boolean; system: string | null };
  snapshotTakenAt: Timestamp;
}
