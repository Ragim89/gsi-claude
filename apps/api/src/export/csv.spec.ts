import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

interface Row {
  name: string;
  amount: number;
  note: string | null;
}

const columns = [
  { header: 'Name', value: (r: Row) => r.name },
  { header: 'Amount', value: (r: Row) => r.amount },
  { header: 'Note', value: (r: Row) => r.note },
];

const BOM = '﻿';

describe('toCsv', () => {
  it('writes a BOM and CRLF so Excel opens Cyrillic and Turkish text correctly', () => {
    const csv = toCsv([{ name: 'Отчёт', amount: 1, note: null }], columns);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv).toContain('Отчёт');
  });

  it('pairs the semicolon delimiter with a decimal comma', () => {
    const csv = toCsv([{ name: 'Rent', amount: 1234.5, note: null }], columns, 'semicolon');
    expect(csv).toContain('Rent;1234,5;');
  });

  it('pairs the comma delimiter with a decimal point', () => {
    const csv = toCsv([{ name: 'Rent', amount: 1234.5, note: null }], columns, 'comma');
    expect(csv).toContain('Rent,1234.5,');
  });

  it('quotes fields containing the delimiter, quotes or line breaks', () => {
    const csv = toCsv([{ name: 'Acme, Ltd.', amount: 0, note: 'say "hi"' }], columns, 'comma');
    expect(csv).toContain('"Acme, Ltd."');
    expect(csv).toContain('"say ""hi"""');
  });

  it('leaves empty cells for null and undefined rather than printing them', () => {
    const csv = toCsv([{ name: 'X', amount: 0, note: null }], columns, 'comma');
    expect(csv).not.toContain('null');
    expect(csv.trimEnd().endsWith('X,0,')).toBe(true);
  });

  it('rounds to two decimals, the precision the ledger stores', () => {
    const csv = toCsv([{ name: 'X', amount: 1.005999, note: null }], columns, 'comma');
    expect(csv).toContain('1.01');
  });
});
