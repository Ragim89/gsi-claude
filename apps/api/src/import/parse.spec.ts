import { describe, expect, it } from 'vitest';
import { normalizeHeader, parseCsv, toDate, toNumber, toText } from './parse';

describe('normalizeHeader', () => {
  it('ignores case, spaces and punctuation so one alias matches many spellings', () => {
    expect(normalizeHeader('Inventory no.')).toBe(normalizeHeader('inventory no'));
    expect(normalizeHeader('Useful life, months')).toBe(normalizeHeader('useful-life months'));
  });

  it('keeps non-latin headers intact apart from case', () => {
    expect(normalizeHeader(' Инв. Номер ')).toBe('инвномер');
    expect(normalizeHeader('Demirbaş No.')).toBe('demirbaşno');
  });

  it('strips a UTF-8 BOM left by Excel', () => {
    expect(normalizeHeader('﻿Name')).toBe('name');
  });
});

describe('parseCsv', () => {
  it('reads a semicolon file with a BOM and CRLF line endings', () => {
    const { headers, rows } = parseCsv('﻿Name;Amount\r\nOffice rent;1000\r\n');
    expect(headers).toEqual(['Name', 'Amount']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ name: 'Office rent', amount: '1000' });
  });

  it('picks the comma dialect when commas dominate the header line', () => {
    const { rows } = parseCsv('Name,Amount\nOffice rent,1000\n');
    expect(rows[0]).toEqual({ name: 'Office rent', amount: '1000' });
  });

  it('honours quoted fields containing the delimiter and escaped quotes', () => {
    const { rows } = parseCsv('Name,Note\n"Acme, Ltd.","He said ""yes"""\n');
    expect(rows[0].name).toBe('Acme, Ltd.');
    expect(rows[0].note).toBe('He said "yes"');
  });

  it('keeps line breaks inside quoted fields instead of splitting the row', () => {
    const { rows } = parseCsv('Name,Note\n"Acme","line one\nline two"\n');
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe('line one\nline two');
  });

  it('skips blank rows that Excel leaves at the end of a sheet', () => {
    const { rows } = parseCsv('Name;Amount\r\nRent;10\r\n;\r\n\r\n');
    expect(rows).toHaveLength(1);
  });
});

describe('toNumber', () => {
  it.each([
    ['1234.56', 1234.56],
    ['1 234,56', 1234.56],
    ['1.234,56', 1234.56],
    ['1,234.56', 1234.56],
    ['45 000,50', 45000.5],
    ['-500', -500],
    ['12 500,75 TRY', 12500.75],
  ])('reads %s as %s', (input, expected) => {
    expect(toNumber(input)).toBe(expected);
  });

  it('passes through real numbers and rejects empties', () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber('')).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber('n/a')).toBeNull();
  });
});

describe('toDate', () => {
  it.each([
    ['2024-03-15', '2024-03-15'],
    ['15.03.2024', '2024-03-15'],
    ['15/03/2024', '2024-03-15'],
    ['2024-03-15T10:00:00Z', '2024-03-15'],
  ])('reads %s as %s', (input, expected) => {
    expect(toDate(input)).toBe(expected);
  });

  it('keeps the calendar day of an Excel date cell regardless of time zone', () => {
    // Excel hands over a local Date; naive toISOString() would shift it by a day.
    expect(toDate(new Date(2026, 7, 31))).toBe('2026-08-31');
    expect(toDate(new Date(2026, 0, 1))).toBe('2026-01-01');
  });

  it('returns null for empty and unreadable values', () => {
    expect(toDate('')).toBeNull();
    expect(toDate('not a date')).toBeNull();
  });
});

describe('toText', () => {
  it('trims and treats blanks as missing', () => {
    expect(toText('  Acme  ')).toBe('Acme');
    expect(toText('   ')).toBeNull();
    expect(toText(undefined)).toBeNull();
  });
});
