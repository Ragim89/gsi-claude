import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ASSET_CATEGORIES,
  ASSET_STATUSES,
  AuthUser,
  EXPENSE_CATEGORIES,
  INVOICE_STATUSES,
  Permission,
} from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { LedgerService } from '../finance/ledger.service';
import { normalizeHeader, RawRow, toDate, toNumber, toText } from './parse';
import { toCsv } from '../export/csv';

export type RowAction = 'create' | 'update' | 'error';

/**
 * Problems are reported as a code plus parameters rather than a sentence, so the interface
 * can show them in the person's own language (the file is usually in theirs, not in English).
 */
export interface Issue {
  code: string;
  params?: Record<string, string | number>;
}

const issue = (code: string, params?: Record<string, string | number>): Issue => ({ code, params });

export interface RowResult {
  /** 1-based row number as seen in the spreadsheet (header is row 1). */
  row: number;
  action: RowAction;
  key: string;
  errors: Issue[];
  warnings: Issue[];
  preview: Record<string, unknown>;
}

export interface ImportPreview {
  section: string;
  total: number;
  toCreate: number;
  toUpdate: number;
  invalid: number;
  /** Headers that were not recognised — usually a typo or an extra column. */
  unknownColumns: string[];
  rows: RowResult[];
}

export interface ImportResult extends ImportPreview {
  created: number;
  updated: number;
  skipped: number;
}

interface Ctx {
  tx: Tx;
  user: AuthUser;
  ledger: LedgerService;
  branches: Map<string, { id: string; code: string; currency: string }>;
  /** branchId → (lowercased client name | tax id) → id */
  clients: Map<string, Map<string, string>>;
  users: Map<string, { id: string; branchId: string }>;
}

interface Section {
  /** Permission required on top of import.run, matching what the section writes. */
  permission: Permission;
  /** canonical field → accepted header spellings (normalised) */
  fields: Record<string, string[]>;
  required: string[];
  /** Template headers shown to the user, in order. */
  template: { header: string; example: string }[];
  prepare(ctx: Ctx, raw: Record<string, unknown>, result: RowResult): Promise<Record<string, unknown> | null>;
  apply(ctx: Ctx, data: Record<string, unknown>, action: 'create' | 'update'): Promise<void>;
  /** Looks up an existing record; returns its id, or null for a new one. */
  findExisting(ctx: Ctx, data: Record<string, unknown>): Promise<string | null>;
}

const norm = (list: string[]) => list.map(normalizeHeader);

/**
 * Bulk import from the spreadsheets companies already keep: existing assets, open invoices,
 * costs, the client list. Two steps on purpose — a preview that validates every row and
 * shows exactly what will be created or updated, then a commit in a single transaction.
 *
 * Column headers are matched loosely (English, Russian, Turkish, and the headers our own
 * export produces), so an exported file can be edited and loaded straight back.
 */
@Injectable()
export class ImportService {
  constructor(private readonly db: DbService, private readonly ledger: LedgerService) {}

  private readonly sections: Record<string, Section> = {
    clients: {
      permission: 'client.create',
      fields: {
        name: norm(['name', 'client', 'название', 'наименование', 'клиент', 'контрагент', 'unvan', 'müşteri']),
        branch: norm(['branch', 'филиал', 'şube']),
        gaftaFosfaRef: norm(['gafta / fosfa', 'gaftafosfa', 'gafta', 'номер gafta / fosfa', 'gafta / fosfa ref.']),
        taxId: norm(['tax id', 'инн / tax id', 'инн', 'налоговый номер', 'vergi no.', 'vergi no']),
        country: norm(['country', 'страна', 'страна (iso-2)', 'ülke', 'country (iso-2)', 'ülke (iso-2)']),
        address: norm(['address', 'адрес', 'adres']),
        contactName: norm(['contact', 'contact person', 'контактное лицо', 'ilgili kişi']),
        contactEmail: norm(['email', 'contact email', 'email контакта', 'ilgili e-posta']),
        contactPhone: norm(['phone', 'contact phone', 'телефон контакта', 'ilgili telefon']),
        notes: norm(['notes', 'примечания', 'notlar']),
      },
      required: ['name'],
      template: [
        { header: 'Name', example: 'Anatolia Grain Trading A.Ş.' },
        { header: 'Branch', example: 'TR' },
        { header: 'GAFTA / FOSFA', example: 'GAFTA-M-1234' },
        { header: 'Tax ID', example: '1234567890' },
        { header: 'Country', example: 'TR' },
        { header: 'Address', example: 'Ataşehir, İstanbul' },
        { header: 'Contact', example: 'Ahmet Yılmaz' },
        { header: 'Email', example: 'ops@client.example' },
        { header: 'Phone', example: '+90 216 000 00 00' },
      ],
      async prepare(ctx, raw, result) {
        const branch = resolveBranch(ctx, raw.branch, result);
        if (!branch) return null;
        return {
          branchId: branch.id,
          name: toText(raw.name),
          gaftaFosfaRef: toText(raw.gaftaFosfaRef),
          taxId: toText(raw.taxId),
          country: toText(raw.country)?.slice(0, 2).toUpperCase() ?? null,
          address: toText(raw.address),
          contactName: toText(raw.contactName),
          contactEmail: toText(raw.contactEmail),
          contactPhone: toText(raw.contactPhone),
          notes: toText(raw.notes),
        };
      },
      findExisting: (ctx, d) =>
        ctx.tx
          .one<{ id: string }>(
            `SELECT id FROM clients WHERE branch_id = $1 AND (lower(name) = lower($2) OR ($3 <> '' AND tax_id = $3)) LIMIT 1`,
            [d.branchId, d.name, d.taxId ?? ''],
          )
          .then((r) => r?.id ?? null),
      async apply(ctx, d, action) {
        if (action === 'create') {
          await ctx.tx.exec(
            `INSERT INTO clients (branch_id, name, gafta_fosfa_ref, tax_id, country, address, contact_name,
                                  contact_email, contact_phone, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [d.branchId, d.name, d.gaftaFosfaRef, d.taxId, d.country, d.address, d.contactName, d.contactEmail,
             d.contactPhone, d.notes, ctx.user.id],
          );
        } else {
          await ctx.tx.exec(
            `UPDATE clients SET gafta_fosfa_ref = COALESCE($2, gafta_fosfa_ref), tax_id = COALESCE($3, tax_id),
                                country = COALESCE($4, country), address = COALESCE($5, address),
                                contact_name = COALESCE($6, contact_name), contact_email = COALESCE($7, contact_email),
                                contact_phone = COALESCE($8, contact_phone), notes = COALESCE($9, notes)
             WHERE id = $1`,
            [d.existingId, d.gaftaFosfaRef, d.taxId, d.country, d.address, d.contactName, d.contactEmail,
             d.contactPhone, d.notes],
          );
        }
      },
    },

    assets: {
      permission: 'asset.create',
      fields: {
        inventoryNo: norm(['inventory no.', 'inventoryno', 'инв. номер', 'инвентарный номер', 'demirbaş no.']),
        branch: norm(['branch', 'филиал', 'şube']),
        name: norm(['name', 'asset', 'наименование', 'название', 'adı']),
        category: norm(['category', 'категория', 'kategori']),
        status: norm(['status', 'статус', 'durum']),
        serialNo: norm(['serial no.', 'serialno', 'серийный номер', 'seri no.']),
        location: norm(['location', 'местонахождение', 'bulunduğu yer']),
        responsible: norm(['responsible', 'ответственный', 'sorumlu']),
        acquisitionDate: norm(['acquired', 'acquisition date', 'дата приобретения', 'alım tarihi']),
        acquisitionCost: norm(['cost', 'первоначальная стоимость', 'стоимость', 'alış bedeli']),
        currency: norm(['currency', 'валюта', 'para birimi']),
        usefulLifeMonths: norm(['useful life, months', 'usefullife', 'срок полезного использования', 'faydalı ömür']),
        salvageValue: norm(['residual value', 'ликвидационная стоимость', 'hurda değeri']),
        accumulated: norm(['accumulated depreciation', 'накопленная амортизация', 'birikmiş amortisman']),
        depreciatedThrough: norm(['depreciated through', 'начислено по', 'işlendiği dönem']),
        notes: norm(['notes', 'примечания', 'notlar']),
      },
      required: ['inventoryNo', 'name', 'acquisitionDate', 'acquisitionCost'],
      template: [
        { header: 'Inventory no.', example: 'TR-012' },
        { header: 'Branch', example: 'TR' },
        { header: 'Name', example: 'Toyota Hilux 4x4' },
        { header: 'Category', example: 'vehicles' },
        { header: 'Status', example: 'in_use' },
        { header: 'Serial no.', example: 'SN-12345' },
        { header: 'Location', example: 'Istanbul, fleet' },
        { header: 'Responsible', example: 'supervisor.tr@gsi.local' },
        { header: 'Acquired', example: '2023-04-15' },
        { header: 'Cost', example: '1450000' },
        { header: 'Currency', example: 'TRY' },
        { header: 'Useful life, months', example: '84' },
        { header: 'Residual value', example: '145000' },
        { header: 'Accumulated depreciation', example: '310000' },
        { header: 'Depreciated through', example: '2026-08' },
      ],
      async prepare(ctx, raw, result) {
        const branch = resolveBranch(ctx, raw.branch, result);
        if (!branch) return null;

        const category = enumValue(raw.category, ASSET_CATEGORIES, 'other', result, 'category');
        const status = enumValue(raw.status, ASSET_STATUSES, 'in_use', result, 'status');
        const cost = toNumber(raw.acquisitionCost);
        const accumulated = toNumber(raw.accumulated) ?? 0;
        const salvage = toNumber(raw.salvageValue) ?? 0;
        const life = toNumber(raw.usefulLifeMonths);

        if (cost !== null && accumulated > cost) result.errors.push(issue('accumulatedOverCost'));
        if (cost !== null && salvage > cost) result.errors.push(issue('residualOverCost'));

        const responsible = toText(raw.responsible);
        let responsibleId: string | null = null;
        if (responsible) {
          const found = ctx.users.get(responsible.toLowerCase());
          if (!found) result.warnings.push(issue('userNotFound', { user: responsible }));
          else if (found.branchId !== branch.id) result.warnings.push(issue('userOtherBranch', { user: responsible }));
          else responsibleId = found.id;
        }

        const through = toDate(raw.depreciatedThrough ? String(raw.depreciatedThrough).length === 7 ? `${raw.depreciatedThrough}-01` : raw.depreciatedThrough : null);

        return {
          branchId: branch.id,
          inventoryNo: toText(raw.inventoryNo),
          name: toText(raw.name),
          category,
          status,
          serialNo: toText(raw.serialNo),
          location: toText(raw.location),
          responsibleUserId: responsibleId,
          acquisitionDate: toDate(raw.acquisitionDate),
          acquisitionCost: cost,
          currency: (toText(raw.currency) ?? branch.currency).toUpperCase().slice(0, 3),
          usefulLifeMonths: life,
          salvageValue: salvage,
          accumulated,
          depreciatedThrough: through,
          method: life ? 'straight_line' : 'none',
          notes: toText(raw.notes),
        };
      },
      findExisting: (ctx, d) =>
        ctx.tx
          .one<{ id: string }>('SELECT id FROM assets WHERE branch_id = $1 AND inventory_no = $2', [
            d.branchId, d.inventoryNo,
          ])
          .then((r) => r?.id ?? null),
      async apply(ctx, d, action) {
        if (action === 'create') {
          await ctx.tx.exec(
            `INSERT INTO assets (branch_id, inventory_no, name, category, status, serial_no, location,
                                 responsible_user_id, acquisition_date, acquisition_cost, currency, method,
                                 useful_life_months, salvage_value, accumulated, depreciated_through, notes, created_by)
             VALUES ($1,$2,$3,$4::asset_category,$5::asset_status,$6,$7,$8,$9::date,$10,$11,
                     $12::depreciation_method,$13,$14,$15,$16::date,$17,$18)`,
            [d.branchId, d.inventoryNo, d.name, d.category, d.status, d.serialNo, d.location, d.responsibleUserId,
             d.acquisitionDate, d.acquisitionCost, d.currency, d.method, d.usefulLifeMonths, d.salvageValue,
             d.accumulated, d.depreciatedThrough, d.notes, ctx.user.id],
          );
        } else {
          await ctx.tx.exec(
            `UPDATE assets SET name = $2, category = $3::asset_category, status = $4::asset_status,
                    serial_no = COALESCE($5, serial_no), location = COALESCE($6, location),
                    responsible_user_id = COALESCE($7, responsible_user_id), acquisition_date = $8::date,
                    acquisition_cost = $9, currency = $10, method = $11::depreciation_method,
                    useful_life_months = $12, salvage_value = $13, accumulated = $14,
                    depreciated_through = COALESCE($15::date, depreciated_through), notes = COALESCE($16, notes)
             WHERE id = $1`,
            [d.existingId, d.name, d.category, d.status, d.serialNo, d.location, d.responsibleUserId,
             d.acquisitionDate, d.acquisitionCost, d.currency, d.method, d.usefulLifeMonths, d.salvageValue,
             d.accumulated, d.depreciatedThrough, d.notes],
          );
        }
      },
    },

    invoices: {
      permission: 'invoice.create',
      fields: {
        invoiceNumber: norm(['invoice no.', 'invoiceno', '№ счёта', 'номер счёта', 'fatura no.']),
        branch: norm(['branch', 'филиал', 'şube']),
        client: norm(['client', 'клиент', 'контрагент', 'müşteri']),
        status: norm(['status', 'статус', 'durum']),
        currency: norm(['currency', 'валюта', 'para birimi']),
        amountNet: norm(['net', 'сумма без ндс', 'ara toplam', 'net total']),
        taxRate: norm(['vat %', 'ставка ндс, %', 'ставка ндс', 'kdv oranı, %', 'vat rate, %']),
        taxAmount: norm(['vat', 'ндс', 'kdv']),
        amountTotal: norm(['total', 'сумма', 'genel toplam', 'amount']),
        amountPaid: norm(['paid', 'оплачено', 'ödenen']),
        issueDate: norm(['issued', 'issue date', 'выставлен', 'дата выставления', 'düzenlendi']),
        dueDate: norm(['due', 'due date', 'срок оплаты', 'vade']),
        notes: norm(['notes', 'примечания', 'notlar', 'description', 'наименование']),
      },
      required: ['invoiceNumber', 'client', 'issueDate'],
      template: [
        { header: 'Invoice no.', example: 'TR-I-2026-01001' },
        { header: 'Branch', example: 'TR' },
        { header: 'Client', example: 'Anatolia Grain Trading A.Ş.' },
        { header: 'Status', example: 'issued' },
        { header: 'Currency', example: 'TRY' },
        { header: 'Net', example: '42000' },
        { header: 'VAT %', example: '20' },
        { header: 'VAT', example: '8400' },
        { header: 'Total', example: '50400' },
        { header: 'Paid', example: '0' },
        { header: 'Issued', example: '2026-07-15' },
        { header: 'Due', example: '2026-08-14' },
        { header: 'Notes', example: 'Draft survey, MV Demo Carrier' },
      ],
      async prepare(ctx, raw, result) {
        const branch = resolveBranch(ctx, raw.branch, result);
        if (!branch) return null;

        const clientName = toText(raw.client);
        const clientId = clientName ? ctx.clients.get(branch.id)?.get(clientName.toLowerCase()) ?? null : null;
        if (clientName && !clientId) {
          result.errors.push(issue('clientNotFound', { client: clientName, branch: branch.code }));
        }

        const net = toNumber(raw.amountNet);
        const rate = toNumber(raw.taxRate) ?? 0;
        let tax = toNumber(raw.taxAmount);
        let total = toNumber(raw.amountTotal);
        if (net !== null && tax === null) tax = Math.round(((net * rate) / 100) * 100) / 100;
        if (total === null && net !== null) total = Math.round((net + (tax ?? 0)) * 100) / 100;
        if (net === null && total !== null) {
          // Only the gross amount was given: split it back out with the VAT rate.
          const netFromTotal = rate > 0 ? total / (1 + rate / 100) : total;
          return finish(Math.round(netFromTotal * 100) / 100, Math.round((total - netFromTotal) * 100) / 100, total);
        }
        if (net === null && total === null) {
          result.errors.push(issue('amountRequired'));
          return null;
        }
        return finish(net!, tax ?? 0, total!);

        function finish(amountNet: number, taxAmount: number, amountTotal: number) {
          const paid = toNumber(raw.amountPaid) ?? 0;
          if (paid > amountTotal + 0.01) result.errors.push(issue('paidOverTotal'));
          let status = enumValue(raw.status, INVOICE_STATUSES, '', result, 'status', true);
          if (!status) {
            status = paid <= 0.001 ? 'issued' : paid >= amountTotal - 0.01 ? 'paid' : 'partially_paid';
          }
          return {
            branchId: branch!.id,
            clientId,
            invoiceNumber: toText(raw.invoiceNumber),
            status,
            currency: (toText(raw.currency) ?? branch!.currency).toUpperCase().slice(0, 3),
            amountNet,
            taxRate: rate,
            taxAmount,
            amountTotal,
            amountPaid: paid,
            issueDate: toDate(raw.issueDate),
            dueDate: toDate(raw.dueDate),
            notes: toText(raw.notes),
          };
        }
      },
      findExisting: (ctx, d) =>
        ctx.tx
          .one<{ id: string }>('SELECT id FROM invoices WHERE invoice_number = $1', [d.invoiceNumber])
          .then((r) => r?.id ?? null),
      async apply(ctx, d, action) {
        if (action === 'update') {
          // An imported invoice that already exists is left alone: its ledger postings and
          // payments are already in the books and silently rewriting them would corrupt them.
          return;
        }
        const row = await ctx.tx.one<{ id: string }>(
          `INSERT INTO invoices (branch_id, client_id, invoice_number, status, currency, amount_net, tax_rate,
                                 tax_amount, amount_total, amount_paid, issue_date, due_date, paid_at, notes, created_by)
           VALUES ($1,$2,$3,$4::invoice_status,$5,$6,$7,$8,$9,$10,$11::date,$12::date,
                   CASE WHEN $4 = 'paid' THEN $11::timestamptz END,$13,$14)
           RETURNING id`,
          [d.branchId, d.clientId, d.invoiceNumber, d.status, d.currency, d.amountNet, d.taxRate, d.taxAmount,
           d.amountTotal, d.amountPaid, d.issueDate, d.dueDate, d.notes, ctx.user.id],
        );
        await ctx.tx.exec(
          `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price, sort_order)
           VALUES ($1, $2, 1, $3, 10)`,
          [row!.id, d.notes ?? 'Imported balance', d.amountNet],
        );

        const status = d.status as string;
        if (status === 'draft' || status === 'cancelled') return;

        // Post it like an issued invoice so the dashboard, ageing and P&L include it.
        await ctx.ledger.post(ctx.tx, ctx.user, {
          branchId: d.branchId as string,
          currency: d.currency as string,
          date: d.issueDate as string,
          sourceType: 'invoice',
          sourceId: row!.id,
          description: `Imported invoice ${d.invoiceNumber}`,
          legs: [
            { account: 'ar.trade', group: 'receivable', debit: d.amountTotal as number },
            { account: 'revenue.services', group: 'revenue', credit: d.amountNet as number },
            ...((d.taxAmount as number) > 0
              ? [{ account: 'tax.output_vat', group: 'tax' as const, credit: d.taxAmount as number }]
              : []),
          ],
        });
        if ((d.amountPaid as number) > 0) {
          await ctx.ledger.post(ctx.tx, ctx.user, {
            branchId: d.branchId as string,
            currency: d.currency as string,
            date: (d.dueDate as string) ?? (d.issueDate as string),
            sourceType: 'payment',
            sourceId: row!.id,
            description: `Imported payment for ${d.invoiceNumber}`,
            legs: [
              { account: 'cash.bank', group: 'cash', debit: d.amountPaid as number },
              { account: 'ar.trade', group: 'receivable', credit: d.amountPaid as number },
            ],
          });
        }
      },
    },

    expenses: {
      permission: 'expense.create',
      fields: {
        expenseDate: norm(['date', 'дата', 'tarih']),
        branch: norm(['branch', 'филиал', 'şube']),
        category: norm(['category', 'категория', 'kategori']),
        description: norm(['description', 'описание', 'açıklama']),
        supplier: norm(['supplier', 'поставщик', 'tedarikçi']),
        currency: norm(['currency', 'валюта', 'para birimi']),
        amount: norm(['amount', 'сумма', 'tutar']),
      },
      required: ['expenseDate', 'description', 'amount'],
      template: [
        { header: 'Date', example: '2026-08-31' },
        { header: 'Branch', example: 'TR' },
        { header: 'Category', example: 'travel' },
        { header: 'Description', example: 'Port visit, Mersin' },
        { header: 'Supplier', example: 'Travel agency' },
        { header: 'Currency', example: 'TRY' },
        { header: 'Amount', example: '12500' },
      ],
      async prepare(ctx, raw, result) {
        const branch = resolveBranch(ctx, raw.branch, result);
        if (!branch) return null;
        const amount = toNumber(raw.amount);
        if (amount !== null && amount <= 0) result.errors.push(issue('amountPositive'));
        return {
          branchId: branch.id,
          expenseDate: toDate(raw.expenseDate),
          category: enumValue(raw.category, EXPENSE_CATEGORIES, 'other', result, 'category'),
          description: toText(raw.description),
          supplier: toText(raw.supplier),
          currency: (toText(raw.currency) ?? branch.currency).toUpperCase().slice(0, 3),
          amount,
        };
      },
      // Expenses have no natural key — every row is a new record.
      findExisting: async () => null,
      async apply(ctx, d) {
        const row = await ctx.tx.one<{ id: string }>(
          `INSERT INTO expenses (branch_id, category, description, supplier, currency, amount, expense_date, created_by)
           VALUES ($1,$2::expense_category,$3,$4,$5,$6,$7::date,$8) RETURNING id`,
          [d.branchId, d.category, d.description, d.supplier, d.currency, d.amount, d.expenseDate, ctx.user.id],
        );
        await ctx.ledger.post(ctx.tx, ctx.user, {
          branchId: d.branchId as string,
          currency: d.currency as string,
          date: d.expenseDate as string,
          sourceType: 'expense',
          sourceId: row!.id,
          description: d.description as string,
          legs: [
            { account: `expense.${d.category}`, group: 'expense', debit: d.amount as number },
            { account: 'cash.bank', group: 'cash', credit: d.amount as number },
          ],
        });
      },
    },
  };

  sectionNames(user: AuthUser): string[] {
    return Object.entries(this.sections)
      .filter(([, s]) => user.permissions?.includes(s.permission))
      .map(([name]) => name);
  }

  /** A ready-to-fill CSV with the expected headers and one example row. */
  template(user: AuthUser, section: string, dialect: 'semicolon' | 'comma'): string {
    const def = this.get(user, section);
    return toCsv(
      [Object.fromEntries(def.template.map((c) => [c.header, c.example]))],
      def.template.map((c) => ({ header: c.header, value: (r: Record<string, string>) => r[c.header] })),
      dialect,
    );
  }

  preview(user: AuthUser, section: string, rows: RawRow[], headers: string[]): Promise<ImportPreview> {
    return this.run(user, section, rows, headers, false);
  }

  commit(user: AuthUser, section: string, rows: RawRow[], headers: string[]): Promise<ImportResult> {
    return this.run(user, section, rows, headers, true) as Promise<ImportResult>;
  }

  private get(user: AuthUser, section: string): Section {
    const def = this.sections[section];
    if (!def) throw new NotFoundException(`Unknown import section "${section}"`);
    if (!user.permissions?.includes(def.permission)) {
      throw new ForbiddenException('Not allowed to import this section');
    }
    return def;
  }

  private async run(
    user: AuthUser,
    section: string,
    rows: RawRow[],
    headers: string[],
    commit: boolean,
  ): Promise<ImportResult> {
    const def = this.get(user, section);
    if (!rows.length) throw new BadRequestException('The file has no data rows');
    if (rows.length > 5000) throw new BadRequestException('Up to 5000 rows per file');

    const known = new Set(Object.values(def.fields).flat());
    const unknownColumns = headers.filter((h) => h && !known.has(normalizeHeader(h)));

    return this.db.tx(user, async (tx) => {
      const ctx = await this.context(tx, user);
      const results: RowResult[] = [];
      let created = 0;
      let updated = 0;

      for (const [i, raw] of rows.entries()) {
        const result: RowResult = { row: i + 2, action: 'error', key: '', errors: [], warnings: [], preview: {} };
        // Map the sheet's columns onto our field names.
        const mapped: Record<string, unknown> = {};
        for (const [field, aliases] of Object.entries(def.fields)) {
          for (const alias of aliases) {
            if (raw[alias] !== undefined && raw[alias] !== '') {
              mapped[field] = raw[alias];
              break;
            }
          }
        }
        for (const field of def.required) {
          if (mapped[field] === undefined || mapped[field] === '') result.errors.push(issue('required', { field }));
        }

        let data: Record<string, unknown> | null = null;
        if (!result.errors.length) {
          try {
            data = await def.prepare(ctx, mapped, result);
          } catch (err) {
            result.errors.push(issue('failed', { message: (err as Error).message }));
          }
        }

        if (data && !result.errors.length) {
          const existingId = await def.findExisting(ctx, data);
          result.action = existingId ? 'update' : 'create';
          result.key = String(data.inventoryNo ?? data.invoiceNumber ?? data.name ?? data.description ?? '');
          result.preview = data;
          if (existingId) data.existingId = existingId;

          if (commit) {
            try {
              await def.apply(ctx, data, result.action);
              if (result.action === 'create') created++;
              else updated++;
            } catch (err) {
              result.action = 'error';
              result.errors.push(dbMessage(err));
            }
          }
        }
        results.push(result);
      }

      const flagged = results.filter((r) => r.errors.length || r.warnings.length).slice(0, 200);
      const invalid = results.filter((r) => r.action === 'error').length;
      const toCreate = results.filter((r) => r.action === 'create').length;
      const toUpdate = results.filter((r) => r.action === 'update').length;

      return {
        section,
        total: rows.length,
        toCreate,
        toUpdate,
        invalid,
        unknownColumns,
        created,
        updated,
        skipped: invalid,
        // Long files would drown the response: show everything that needs attention first,
        // then fill up with clean rows so the user still sees what the file looks like.
        rows: [
          ...flagged,
          ...results.filter((r) => !r.errors.length && !r.warnings.length).slice(0, Math.max(0, 50 - flagged.length)),
        ].sort((a, b) => a.row - b.row),
      };
    });
  }

  private async context(tx: Tx, user: AuthUser): Promise<Ctx> {
    const branchRows = await tx.many<{ id: string; code: string; currency: string }>(
      'SELECT id, code, currency FROM branches',
    );
    const branches = new Map<string, { id: string; code: string; currency: string }>();
    for (const b of branchRows) {
      branches.set(b.code.toLowerCase(), b);
      branches.set(b.id, b);
    }

    const clientRows = await tx.many<{ id: string; branch_id: string; name: string; tax_id: string | null }>(
      'SELECT id, branch_id, name, tax_id FROM clients',
    );
    const clients = new Map<string, Map<string, string>>();
    for (const c of clientRows) {
      if (!clients.has(c.branch_id)) clients.set(c.branch_id, new Map());
      const m = clients.get(c.branch_id)!;
      m.set(c.name.toLowerCase(), c.id);
      if (c.tax_id) m.set(c.tax_id.toLowerCase(), c.id);
    }

    const userRows = await tx.many<{ id: string; branch_id: string; email: string; full_name: string }>(
      'SELECT id, branch_id, email, full_name FROM users',
    );
    const users = new Map<string, { id: string; branchId: string }>();
    for (const u of userRows) {
      users.set(u.email.toLowerCase(), { id: u.id, branchId: u.branch_id });
      users.set(u.full_name.toLowerCase(), { id: u.id, branchId: u.branch_id });
    }

    return { tx, user, ledger: this.ledger, branches, clients, users };
  }
}

function resolveBranch(ctx: Ctx, value: unknown, result: RowResult) {
  const code = toText(value);
  if (!code) {
    const own = ctx.branches.get(ctx.user.branchId);
    if (!own) result.errors.push(issue('required', { field: 'branch' }));
    return own ?? null;
  }
  const branch = ctx.branches.get(code.toLowerCase());
  // Beyond their own office only for group-wide roles; a country manager's rows are still
  // filtered by the database, this only decides how the message reads.
  const mine = ctx.user.scope === 'global' || ctx.user.scope === 'country';
  if (!branch) {
    // A branch user only ever sees their own branch, so "not found" means one of two things.
    result.errors.push(issue(mine ? 'unknownBranch' : 'foreignBranch', { branch: code }));
    return null;
  }
  if (!mine && branch.id !== ctx.user.branchId) {
    result.errors.push(issue('foreignBranch', { branch: code }));
    return null;
  }
  return branch;
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: string,
  result: RowResult,
  field: string,
  silent = false,
): string {
  const raw = toText(value);
  if (!raw) return fallback;
  const key = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if ((allowed as readonly string[]).includes(key)) return key;
  if (!silent) result.warnings.push(issue('unknownValue', { field, value: raw, fallback }));
  return fallback;
}

function dbMessage(err: unknown): Issue {
  const e = err as { code?: string; message?: string };
  if (e.code === '23505') return issue('duplicate');
  if (e.code === '23503') return issue('missingRef');
  if (e.code === '42501') return issue('forbidden');
  return issue('failed', { message: e.message ?? '' });
}
