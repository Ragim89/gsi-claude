/**
 * CSV writer tuned for the spreadsheets people actually open.
 *
 * Excel picks its separator and decimal mark from the operating system locale, so the two
 * travel together: semicolon + decimal comma (the default in Turkish, Russian and most of
 * Europe) or comma + decimal point (the CSV standard, Google Sheets, LibreOffice).
 * A UTF-8 BOM is prepended so Excel does not mangle Cyrillic and Turkish characters.
 */
export type CsvDialect = 'semicolon' | 'comma';

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined | boolean;
}

const BOM = '﻿';

function formatValue(v: unknown, dialect: CsvDialect): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    const s = String(Math.round(v * 100) / 100);
    return dialect === 'semicolon' ? s.replace('.', ',') : s;
  }
  return String(v);
}

function escape(s: string, delimiter: string): string {
  // A field needs quoting when it contains the delimiter, a quote or a line break.
  if (s.includes('"') || s.includes(delimiter) || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[], dialect: CsvDialect = 'semicolon'): string {
  const delimiter = dialect === 'semicolon' ? ';' : ',';
  const lines = [columns.map((c) => escape(c.header, delimiter)).join(delimiter)];
  for (const row of rows) {
    lines.push(columns.map((c) => escape(formatValue(c.value(row), dialect), delimiter)).join(delimiter));
  }
  // CRLF keeps Excel happy on Windows.
  return BOM + lines.join('\r\n') + '\r\n';
}
