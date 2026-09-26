import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { JurisdictionProfileConfig } from '@gsi/shared-types';
import { computeFiscalTotals, resolveTaxCode, round2 } from './fiscal-calc';

/**
 * Pure tax math behind the opt-in fiscal invoice path (migration 028). No DB, no NestJS module —
 * exactly the numbers a KZ invoice snapshot must reproduce, tested line by line.
 */

const kzConfig: JurisdictionProfileConfig = {
  taxCodes: [
    { code: 'STANDARD', label: 'НДС 16%', rate: 16, kind: 'standard' },
    { code: 'ZERO', label: 'НДС 0%', rate: 0, kind: 'zero' },
    { code: 'EXEMPT', label: 'Без НДС', rate: 0, kind: 'no_tax' },
  ],
  invoiceRequiredFields: ['sellerFiscalId', 'supplyDate'],
  sellerFiscalIdentifierLabel: 'BIN',
  buyerFiscalIdentifierLabel: 'BIN/IIN',
  supplyDateRequired: true,
  numberingRules: { resetPeriod: 'year', description: 'unused in this test' },
  roundingRule: { decimals: 2, mode: 'half_up' },
  bankPaymentRequirements: ['iban'],
  eInvoice: { required: true, system: 'ИС ЭСФ', description: 'unused in this test' },
  locale: { documentTerm: { ru: 'Счет-фактура' }, defaultLocale: 'ru' },
  sourceCitations: ['test fixture'],
};

describe('resolveTaxCode', () => {
  it('picks the requested code for a VAT-registered entity', () => {
    const code = resolveTaxCode(kzConfig, { vatRegistered: true, defaultTaxCode: null }, 'STANDARD');
    expect(code.code).toBe('STANDARD');
    expect(code.rate).toBe(16);
  });

  it('falls back to the legal entity default when no code is requested', () => {
    const code = resolveTaxCode(kzConfig, { vatRegistered: true, defaultTaxCode: 'ZERO' }, undefined);
    expect(code.code).toBe('ZERO');
  });

  it('forces the non-taxable code for a non-VAT-registered entity, even if STANDARD was requested', () => {
    const code = resolveTaxCode(kzConfig, { vatRegistered: false, defaultTaxCode: 'STANDARD' }, 'STANDARD');
    expect(code.code).toBe('EXEMPT');
    expect(code.rate).toBe(0);
  });

  it('rejects an unknown tax code', () => {
    expect(() => resolveTaxCode(kzConfig, { vatRegistered: true, defaultTaxCode: null }, 'NOPE')).toThrow(BadRequestException);
  });

  it('rejects when no code and no default is given for a VAT-registered entity', () => {
    expect(() => resolveTaxCode(kzConfig, { vatRegistered: true, defaultTaxCode: null }, undefined)).toThrow(BadRequestException);
  });
});

describe('computeFiscalTotals', () => {
  it('computes net/tax/gross per line and totals at the standard 16% rate', () => {
    const result = computeFiscalTotals(
      [
        { description: 'Weight supervision', quantity: 2, unitPrice: 100 },
        { description: 'Sampling', quantity: 1, unitPrice: 50.5 },
      ],
      16,
    );
    expect(result.lines[0]).toEqual({
      description: 'Weight supervision', quantity: 2, unitPrice: 100, netAmount: 200, taxAmount: 32, grossAmount: 232,
    });
    expect(result.lines[1]).toEqual({
      description: 'Sampling', quantity: 1, unitPrice: 50.5, netAmount: 50.5, taxAmount: 8.08, grossAmount: 58.58,
    });
    expect(result.subtotalNet).toBe(250.5);
    expect(result.taxAmount).toBe(40.08);
    expect(result.grandTotal).toBe(290.58);
  });

  it('produces zero tax at the zero rate', () => {
    const result = computeFiscalTotals([{ description: 'Export inspection', quantity: 1, unitPrice: 1000 }], 0);
    expect(result.taxAmount).toBe(0);
    expect(result.grandTotal).toBe(1000);
  });

  it('produces zero tax for a non-taxable (EXEMPT) invoice', () => {
    const nonVat = resolveTaxCode(kzConfig, { vatRegistered: false, defaultTaxCode: null }, undefined);
    const result = computeFiscalTotals([{ description: 'Lab testing', quantity: 3, unitPrice: 77.77 }], nonVat.rate);
    expect(nonVat.code).toBe('EXEMPT');
    expect(result.taxAmount).toBe(0);
    expect(result.grandTotal).toBe(result.subtotalNet);
  });

  it('rounds each line independently before summing, matching the legacy invoice math convention', () => {
    // 3 × 0.335 = 1.005 → rounds to 1.01 at the line, not 1.00 from a pre-summed total.
    const result = computeFiscalTotals([{ description: 'x', quantity: 3, unitPrice: 0.335 }], 16);
    expect(result.lines[0].netAmount).toBe(round2(3 * 0.335));
    expect(result.subtotalNet).toBe(result.lines[0].netAmount);
  });
});
