import type { FiscalLineSnapshot, JurisdictionProfileConfig, JurisdictionTaxCode, LegalEntity } from '@gsi/shared-types';
import { BadRequestException } from '@nestjs/common';

/**
 * Pure tax math for the fiscal invoice path (migration 028). Kept free of any DB access so it
 * is trivial to unit test line-by-line; apps/api/src/finance/invoices.service.ts is the only
 * caller, and only when the caller supplies a legalEntityId — the legacy invoice path
 * (invoices.service.ts's own net/tax/total math) is untouched and never calls this file.
 */

export interface FiscalLineInput {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface FiscalCalcResult {
  lines: FiscalLineSnapshot[];
  subtotalNet: number;
  taxAmount: number;
  grandTotal: number;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Picks the tax code that actually applies. A legal entity that is not VAT-registered cannot
 * charge VAT at any rate — the caller's requested code is overridden with the profile's
 * non-taxable code rather than trusted, so "forgot to pass EXEMPT" can never charge VAT on
 * behalf of an unregistered seller.
 */
export function resolveTaxCode(
  config: JurisdictionProfileConfig,
  legalEntity: Pick<LegalEntity, 'vatRegistered' | 'defaultTaxCode'>,
  requestedCode: string | undefined,
): JurisdictionTaxCode {
  if (!legalEntity.vatRegistered) {
    const nonTaxable = config.taxCodes.find((c) => c.kind === 'exempt' || c.kind === 'no_tax');
    if (!nonTaxable) {
      throw new BadRequestException('Jurisdiction profile has no non-taxable code for an unregistered seller');
    }
    return nonTaxable;
  }
  const code = requestedCode ?? legalEntity.defaultTaxCode ?? undefined;
  const found = code ? config.taxCodes.find((c) => c.code === code) : undefined;
  if (!found) {
    const known = config.taxCodes.map((c) => c.code).join(', ');
    throw new BadRequestException(`Unknown tax code "${code ?? ''}" for this jurisdiction (known: ${known})`);
  }
  return found;
}

/** Per-line net/tax/gross, then the invoice totals — same rounding rule the legacy path uses
 *  (round each line, then sum), so the two paths never disagree on how 2-decimal money rounds. */
export function computeFiscalTotals(lines: FiscalLineInput[], taxRatePct: number): FiscalCalcResult {
  const computed: FiscalLineSnapshot[] = lines.map((l) => {
    const netAmount = round2(l.quantity * l.unitPrice);
    const taxAmount = round2((netAmount * taxRatePct) / 100);
    return {
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      netAmount,
      taxAmount,
      grossAmount: round2(netAmount + taxAmount),
    };
  });
  const subtotalNet = round2(computed.reduce((s, l) => s + l.netAmount, 0));
  const taxAmount = round2(computed.reduce((s, l) => s + l.taxAmount, 0));
  return { lines: computed, subtotalNet, taxAmount, grandTotal: round2(subtotalNet + taxAmount) };
}
