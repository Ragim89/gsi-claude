import ExcelJS from 'exceljs';

/**
 * Reads the spreadsheets people actually send: .xlsx straight from Excel, or CSV in any of
 * the usual dialects (comma or semicolon, with or without a BOM, quoted fields, CRLF).
 * Everything comes back as plain rows keyed by a normalised header.
 */

export type RawRow = Record<string, unknown>;

/** Header key: lowercase, no punctuation or spaces — so "Inventory no." == "inventory no" == "ИНВ. НОМЕР". */
export function normalizeHeader(h: string): string {
  return String(h)
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s._/\\-]+/g, '')
    .replace(/[()[\]{}"'`:;,!?*]+/g, '');
}

function detectDelimiter(firstLine: string): string {
  const counts = [';', ',', '\t'].map((d) => ({ d, n: firstLine.split(d).length }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 1 ? counts[0].d : ';';
}

/** Minimal RFC-4180 reader: quoted fields, doubled quotes inside them, CRLF or LF. */
export function parseCsv(text: string): { headers: string[]; rows: RawRow[] } {
  const clean = text.replace(/^﻿/, '');
  const firstBreak = clean.search(/\r?\n/);
  const delimiter = detectDelimiter(firstBreak > 0 ? clean.slice(0, firstBreak) : clean);

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      record.push(field);
      field = '';
    } else if (ch === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length || record.length) {
    record.push(field);
    records.push(record);
  }

  const headerRow = records.shift() ?? [];
  const headers = headerRow.map((h) => h.trim());
  const rows = records
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => {
      const obj: RawRow = {};
      headers.forEach((h, i) => {
        obj[normalizeHeader(h)] = (r[i] ?? '').trim();
      });
      return obj;
    });
  return { headers, rows };
}

export async function parseXlsx(buffer: Buffer): Promise<{ headers: string[]; rows: RawRow[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    headers[col - 1] = String(cell.value ?? '').trim();
  });

  const rows: RawRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj: RawRow = {};
    let empty = true;
    headers.forEach((h, i) => {
      if (!h) return;
      const cell = row.getCell(i + 1);
      let v: unknown = cell.value;
      // Formulas and rich text arrive as objects; keep the displayed value.
      if (v && typeof v === 'object') {
        const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[] };
        if (o.result !== undefined) v = o.result;
        else if (Array.isArray(o.richText)) v = o.richText.map((p) => p.text).join('');
        else if (o.text !== undefined) v = o.text;
      }
      if (v !== null && v !== undefined && String(v).trim() !== '') empty = false;
      obj[normalizeHeader(h)] = v instanceof Date ? v : typeof v === 'string' ? v.trim() : v;
    });
    if (!empty) rows.push(obj);
  });
  return { headers: headers.filter(Boolean), rows };
}

export function parseFile(file: { originalname: string; mimetype: string; buffer: Buffer }) {
  const isExcel =
    /\.xlsx?$/i.test(file.originalname) ||
    file.mimetype.includes('spreadsheetml') ||
    file.mimetype === 'application/vnd.ms-excel';
  return isExcel ? parseXlsx(file.buffer) : Promise.resolve(parseCsv(file.buffer.toString('utf8')));
}

// ---------------------------------------------------------------------------
// Value coercion — spreadsheets are typed loosely, so be forgiving but explicit.
// ---------------------------------------------------------------------------

/** "1 234,56", "1,234.56", "1234.56", 1234.56 → 1234.56 */
export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/\s| /g, '').replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Whichever comes last is the decimal mark; the other is a thousands separator.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = s.replace(/,/g, s.length - lastComma === 3 || s.length - lastComma === 2 ? '.' : '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** ISO, dd.mm.yyyy, dd/mm/yyyy, Excel dates → YYYY-MM-DD */
export function toDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function toText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
