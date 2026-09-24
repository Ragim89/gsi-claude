import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser, localize, Permission } from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { config } from '../config';
import { CsvColumn, CsvDialect, toCsv } from './csv';

export interface ExportFilters {
  branchId?: string;
  from?: string;
  to?: string;
  status?: string;
  category?: string;
  clientId?: string;
  commodityId?: string;
  portId?: string;
  search?: string;
  locale?: string;
}

interface Section {
  /**
   * Permission needed to export it; undefined = any authenticated user. Row-Level Security
   * still decides which rows come out, so this only governs whether the section is offered.
   */
  permission?: Permission;
  load(tx: Tx, f: ExportFilters, base: string): Promise<Record<string, unknown>[]>;
  columns(locale: string): CsvColumn<Record<string, unknown>>[];
}
const col = (header: string, key: string): CsvColumn<Record<string, unknown>> => ({
  header,
  value: (r) => r[key] as string | number | null,
});

/**
 * Data export. Every section reuses the same Row-Level Security as its screen — an export
 * can never contain a row the user could not see in the app — and honours the branch and
 * period filters that were active when the button was pressed.
 */
@Injectable()
export class ExportService {
  private readonly base = config.consolidationCurrency;

  constructor(private readonly db: DbService) {}

  private readonly sections: Record<string, Section> = {
    jobs: {
      permission: 'job.read',
      load: (tx, f) =>
        tx.many(
          `SELECT j.job_number, b.code AS branch, c.name AS client, j.type::text AS service, j.status::text,
                  cm.name AS commodity_name, j.commodity AS commodity_text,
                  j.quantity_value::float8 AS volume, j.quantity_unit, p.name AS port, p.country AS port_country,
                  j.contract_no, j.vessel_or_object, j.location,
                  to_char(j.scheduled_at, 'YYYY-MM-DD') AS scheduled,
                  u.full_name AS inspector,
                  to_char(j.created_at, 'YYYY-MM-DD') AS created,
                  to_char(j.approved_at, 'YYYY-MM-DD') AS approved
           FROM inspection_jobs j
           JOIN branches b ON b.id = j.branch_id
           JOIN clients c ON c.id = j.client_id
           LEFT JOIN users u ON u.id = j.assigned_inspector_id
           LEFT JOIN commodities cm ON cm.id = j.commodity_id
           LEFT JOIN ports p ON p.id = j.port_id
           WHERE ($1::uuid IS NULL OR j.branch_id = $1::uuid)
             AND ($2::date IS NULL OR COALESCE(j.scheduled_at, j.created_at)::date >= $2::date)
             AND ($3::date IS NULL OR COALESCE(j.scheduled_at, j.created_at)::date <= $3::date)
             AND ($4::job_status IS NULL OR j.status = $4::job_status)
             AND ($5::uuid IS NULL OR j.client_id = $5::uuid)
             AND ($6::uuid IS NULL OR j.commodity_id = $6::uuid)
             AND ($7::uuid IS NULL OR j.port_id = $7::uuid)
           ORDER BY COALESCE(j.scheduled_at, j.created_at) DESC
           LIMIT 20000`,
          [f.branchId ?? null, f.from ?? null, f.to ?? null, f.status ?? null, f.clientId ?? null,
           f.commodityId ?? null, f.portId ?? null],
        ),
      columns: (locale) => [
        col('Job no.', 'job_number'),
        col('Branch', 'branch'),
        col('Client', 'client'),
        col('Service', 'service'),
        col('Status', 'status'),
        {
          header: 'Commodity',
          value: (r) =>
            r.commodity_name ? localize(r.commodity_name as never, locale) : ((r.commodity_text as string) ?? ''),
        },
        col('Volume', 'volume'),
        col('Unit', 'quantity_unit'),
        col('Port', 'port'),
        col('Port country', 'port_country'),
        col('Contract no.', 'contract_no'),
        col('Vessel / object', 'vessel_or_object'),
        col('Location', 'location'),
        col('Scheduled', 'scheduled'),
        col('Inspector', 'inspector'),
        col('Created', 'created'),
        col('Approved', 'approved'),
      ],
    },

    samples: {
      permission: 'sample.read',
      load: (tx, f) =>
        tx.many(
          `SELECT s.sample_number, j.job_number, i.inspection_number, b.code AS branch, c.name AS client,
                  cm.name AS commodity_name, s.commodity AS commodity_text,
                  s.quantity::float8 AS quantity, s.unit,
                  s.sample_type::text AS sample_type, s.sampling_method::text AS sampling_method,
                  s.seal_number, s.batch_lot_number, s.container_reference, s.location,
                  s.status::text, l.name AS destination,
                  u.full_name AS sampler,
                  to_char(s.sampled_at, 'YYYY-MM-DD') AS sampled,
                  to_char(s.dispatched_at, 'YYYY-MM-DD') AS dispatched,
                  to_char(s.received_at, 'YYYY-MM-DD') AS received
           FROM samples s
           JOIN branches b ON b.id = s.branch_id
           JOIN inspection_jobs j ON j.id = s.job_id
           JOIN clients c ON c.id = s.client_id
           LEFT JOIN inspections i ON i.id = s.inspection_id
           LEFT JOIN commodities cm ON cm.id = s.commodity_id
           LEFT JOIN laboratories l ON l.id = s.destination_laboratory_id
           LEFT JOIN users u ON u.id = s.sampled_by
           WHERE s.deleted_at IS NULL
             AND ($1::uuid IS NULL OR s.branch_id = $1::uuid)
             AND ($2::date IS NULL OR COALESCE(s.sampled_at, s.created_at)::date >= $2::date)
             AND ($3::date IS NULL OR COALESCE(s.sampled_at, s.created_at)::date <= $3::date)
             AND ($4::uuid IS NULL OR s.client_id = $4::uuid)
             AND ($5::uuid IS NULL OR s.commodity_id = $5::uuid)
           ORDER BY COALESCE(s.sampled_at, s.created_at) DESC
           LIMIT 20000`,
          [f.branchId ?? null, f.from ?? null, f.to ?? null, f.clientId ?? null, f.commodityId ?? null],
        ),
      columns: (locale) => [
        col('Sample no.', 'sample_number'),
        col('Job no.', 'job_number'),
        col('Inspection no.', 'inspection_number'),
        col('Branch', 'branch'),
        col('Client', 'client'),
        {
          header: 'Commodity',
          value: (r) =>
            r.commodity_name ? localize(r.commodity_name as never, locale) : ((r.commodity_text as string) ?? ''),
        },
        col('Quantity', 'quantity'),
        col('Unit', 'unit'),
        col('Sample type', 'sample_type'),
        col('Sampling method', 'sampling_method'),
        col('Seal no.', 'seal_number'),
        col('Batch / lot', 'batch_lot_number'),
        col('Container ref.', 'container_reference'),
        col('Location', 'location'),
        col('Status', 'status'),
        col('Destination', 'destination'),
        col('Sampler', 'sampler'),
        col('Sampled', 'sampled'),
        col('Dispatched', 'dispatched'),
        col('Received', 'received'),
      ],
    },

    lab_requests: {
      permission: 'lab.test.read',
      load: (tx, f) =>
        tx.many(
          `SELECT s.sample_number, j.job_number, b.code AS branch, c.name AS client,
                  t.code AS test_code, t.name AS test_name, m.code AS method_code,
                  m.standard_reference, r.status::text, r.priority::text,
                  u.full_name AS analyst, l.name AS laboratory,
                  to_char(r.requested_at, 'YYYY-MM-DD') AS requested,
                  to_char(r.due_at, 'YYYY-MM-DD') AS due
           FROM test_requests r
           JOIN samples s ON s.id = r.sample_id
           JOIN inspection_jobs j ON j.id = s.job_id
           JOIN clients c ON c.id = s.client_id
           JOIN branches b ON b.id = r.branch_id
           JOIN lab_tests t ON t.id = r.lab_test_id
           JOIN test_methods m ON m.id = r.test_method_id
           JOIN laboratories l ON l.id = r.laboratory_id
           LEFT JOIN users u ON u.id = r.assigned_analyst_id
           WHERE ($1::uuid IS NULL OR r.branch_id = $1::uuid)
             AND ($2::date IS NULL OR r.requested_at::date >= $2::date)
             AND ($3::date IS NULL OR r.requested_at::date <= $3::date)
             AND ($4::uuid IS NULL OR s.client_id = $4::uuid)
           ORDER BY r.requested_at DESC LIMIT 20000`,
          [f.branchId ?? null, f.from ?? null, f.to ?? null, f.clientId ?? null],
        ),
      columns: (locale) => [
        col('Sample no.', 'sample_number'),
        col('Job no.', 'job_number'),
        col('Branch', 'branch'),
        col('Client', 'client'),
        col('Test code', 'test_code'),
        { header: 'Test', value: (r) => (r.test_name ? localize(r.test_name as never, locale) : '') },
        col('Method', 'method_code'),
        col('Standard', 'standard_reference'),
        col('Laboratory', 'laboratory'),
        col('Status', 'status'),
        col('Priority', 'priority'),
        col('Analyst', 'analyst'),
        col('Requested', 'requested'),
        col('Due', 'due'),
      ],
    },

    /**
     * Released results only. An export is a document that leaves the building, and so is
     * bound by the same rule as a report: nothing the laboratory has not cleared.
     */
    lab_results: {
      permission: 'lab.test.read',
      load: (tx, f) =>
        tx.many(
          `SELECT s.sample_number, j.job_number, b.code AS branch, c.name AS client,
                  t.code AS test_code, t.name AS test_name,
                  x.method_snapshot->>'code' AS method_code,
                  x.method_snapshot->>'standardReference' AS standard_reference,
                  (x.method_snapshot->>'version') AS method_version,
                  x.revision,
                  COALESCE(x.numeric_value::text, x.text_value, x.qualitative_value,
                           CASE WHEN x.boolean_value THEN 'pass' WHEN NOT x.boolean_value THEN 'fail' END) AS result,
                  x.unit, x.evaluation::text,
                  an.full_name AS analyst, ap.full_name AS approved_by,
                  to_char(x.approved_at, 'YYYY-MM-DD') AS approved,
                  to_char(x.released_at, 'YYYY-MM-DD') AS released
           FROM test_results x
           JOIN test_requests r ON r.id = x.test_request_id
           JOIN samples s ON s.id = r.sample_id
           JOIN inspection_jobs j ON j.id = s.job_id
           JOIN clients c ON c.id = s.client_id
           JOIN branches b ON b.id = r.branch_id
           JOIN lab_tests t ON t.id = r.lab_test_id
           LEFT JOIN users an ON an.id = x.analyst_id
           LEFT JOIN users ap ON ap.id = x.approved_by
           WHERE x.released_at IS NOT NULL
             AND ($1::uuid IS NULL OR r.branch_id = $1::uuid)
             AND ($2::date IS NULL OR x.released_at::date >= $2::date)
             AND ($3::date IS NULL OR x.released_at::date <= $3::date)
             AND ($4::uuid IS NULL OR s.client_id = $4::uuid)
           ORDER BY x.released_at DESC LIMIT 20000`,
          [f.branchId ?? null, f.from ?? null, f.to ?? null, f.clientId ?? null],
        ),
      columns: (locale) => [
        col('Sample no.', 'sample_number'),
        col('Job no.', 'job_number'),
        col('Branch', 'branch'),
        col('Client', 'client'),
        col('Test code', 'test_code'),
        { header: 'Test', value: (r) => (r.test_name ? localize(r.test_name as never, locale) : '') },
        col('Method', 'method_code'),
        col('Standard', 'standard_reference'),
        col('Method version', 'method_version'),
        col('Revision', 'revision'),
        col('Result', 'result'),
        col('Unit', 'unit'),
        col('Against specification', 'evaluation'),
        col('Analyst', 'analyst'),
        col('Approved by', 'approved_by'),
        col('Approved', 'approved'),
        col('Released', 'released'),
      ],
    },

    clients: {
      permission: 'client.read',
      load: (tx, f) =>
        tx.many(
          `SELECT c.name, b.code AS branch, c.gafta_fosfa_ref, c.tax_id, c.country, c.address,
                  c.contact_name, c.contact_email, c.contact_phone,
                  (SELECT count(*) FROM inspection_jobs j WHERE j.client_id = c.id)::int AS jobs,
                  to_char(c.created_at, 'YYYY-MM-DD') AS created
           FROM clients c JOIN branches b ON b.id = c.branch_id
           WHERE ($1::uuid IS NULL OR c.branch_id = $1::uuid)
           ORDER BY c.name LIMIT 20000`,
          [f.branchId ?? null],
        ),
      columns: () => [
        col('Name', 'name'),
        col('Branch', 'branch'),
        col('GAFTA / FOSFA', 'gafta_fosfa_ref'),
        col('Tax ID', 'tax_id'),
        col('Country', 'country'),
        col('Address', 'address'),
        col('Contact', 'contact_name'),
        col('Email', 'contact_email'),
        col('Phone', 'contact_phone'),
        col('Jobs', 'jobs'),
        col('Created', 'created'),
      ],
    },

    reports: {
      permission: 'report.read',
      load: (tx, f) =>
        tx.many(
          `SELECT r.report_number, r.version, r.status::text, b.code AS branch, j.job_number,
                  c.name AS client, j.type::text AS service,
                  to_char(r.approved_at, 'YYYY-MM-DD') AS issued, u.full_name AS approved_by
           FROM reports r
           JOIN branches b ON b.id = r.branch_id
           JOIN inspection_jobs j ON j.id = r.job_id
           JOIN clients c ON c.id = j.client_id
           LEFT JOIN users u ON u.id = r.approved_by
           WHERE ($1::uuid IS NULL OR r.branch_id = $1::uuid)
             AND ($2::date IS NULL OR r.created_at::date >= $2::date)
             AND ($3::date IS NULL OR r.created_at::date <= $3::date)
           ORDER BY r.created_at DESC LIMIT 20000`,
          [f.branchId ?? null, f.from ?? null, f.to ?? null],
        ),
      columns: () => [
        col('Report no.', 'report_number'),
        col('Rev.', 'version'),
        col('Status', 'status'),
        col('Branch', 'branch'),
        col('Job no.', 'job_number'),
        col('Client', 'client'),
        col('Service', 'service'),
        col('Issued', 'issued'),
        col('Approved by', 'approved_by'),
      ],
    },

    invoices: {
      permission: 'finance.read',
      load: (tx, f, base) =>
        tx.many(
          `SELECT i.invoice_number, b.code AS branch, c.name AS client, j.job_number, i.status::text,
                  i.currency, i.amount_net::float8, i.tax_rate::float8, i.tax_amount::float8,
                  i.amount_total::float8, i.amount_paid::float8,
                  (i.amount_total - i.amount_paid)::float8 AS amount_due,
                  (i.amount_total * fx_rate_on(i.currency, $4, i.issue_date))::float8 AS total_base,
                  to_char(i.issue_date, 'YYYY-MM-DD') AS issue_date,
                  to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
                  to_char(i.paid_at, 'YYYY-MM-DD') AS paid_at,
                  CASE WHEN i.status IN ('issued','partially_paid') AND i.due_date < current_date
                       THEN current_date - i.due_date END AS days_overdue
           FROM invoices i
           JOIN branches b ON b.id = i.branch_id
           JOIN clients c ON c.id = i.client_id
           LEFT JOIN inspection_jobs j ON j.id = i.job_id
           WHERE ($1::uuid IS NULL OR i.branch_id = $1::uuid)
             AND ($2::date IS NULL OR i.issue_date >= $2::date)
             AND ($3::date IS NULL OR i.issue_date <= $3::date)
           ORDER BY i.issue_date DESC LIMIT 20000`,
          [f.branchId ?? null, f.from ?? null, f.to ?? null, base],
        ),
      columns: () => [
        col('Invoice no.', 'invoice_number'),
        col('Branch', 'branch'),
        col('Client', 'client'),
        col('Job no.', 'job_number'),
        col('Status', 'status'),
        col('Currency', 'currency'),
        col('Net', 'amount_net'),
        col('VAT %', 'tax_rate'),
        col('VAT', 'tax_amount'),
        col('Total', 'amount_total'),
        col('Paid', 'amount_paid'),
        col('Outstanding', 'amount_due'),
        col(`Total, ${config.consolidationCurrency}`, 'total_base'),
        col('Issued', 'issue_date'),
        col('Due', 'due_date'),
        col('Paid at', 'paid_at'),
        col('Days overdue', 'days_overdue'),
      ],
    },

    expenses: {
      permission: 'finance.read',
      load: (tx, f, base) =>
        tx.many(
          `SELECT to_char(e.expense_date, 'YYYY-MM-DD') AS date, b.code AS branch, e.category::text,
                  e.description, e.supplier, e.currency, e.amount::float8,
                  (e.amount * fx_rate_on(e.currency, $4, e.expense_date))::float8 AS amount_base,
                  j.job_number
           FROM expenses e
           JOIN branches b ON b.id = e.branch_id
           LEFT JOIN inspection_jobs j ON j.id = e.job_id
           WHERE ($1::uuid IS NULL OR e.branch_id = $1::uuid)
             AND ($2::date IS NULL OR e.expense_date >= $2::date)
             AND ($3::date IS NULL OR e.expense_date <= $3::date)
             AND ($5::expense_category IS NULL OR e.category = $5::expense_category)
           ORDER BY e.expense_date DESC LIMIT 20000`,
          [f.branchId ?? null, f.from ?? null, f.to ?? null, base, f.category ?? null],
        ),
      columns: () => [
        col('Date', 'date'),
        col('Branch', 'branch'),
        col('Category', 'category'),
        col('Description', 'description'),
        col('Supplier', 'supplier'),
        col('Currency', 'currency'),
        col('Amount', 'amount'),
        col(`Amount, ${config.consolidationCurrency}`, 'amount_base'),
        col('Job no.', 'job_number'),
      ],
    },

    assets: {
      permission: 'asset.read',
      load: (tx, f, base) =>
        tx.many(
          `SELECT a.inventory_no, b.code AS branch, a.name, a.category::text, a.status::text, a.serial_no,
                  a.location, u.full_name AS responsible,
                  to_char(a.acquisition_date, 'YYYY-MM-DD') AS acquired,
                  a.acquisition_cost::float8, a.currency, a.useful_life_months, a.salvage_value::float8,
                  a.accumulated::float8, (a.acquisition_cost - a.accumulated)::float8 AS net_book_value,
                  ((a.acquisition_cost - a.accumulated) * fx_rate_on(a.currency, $2, current_date))::float8 AS nbv_base,
                  to_char(a.depreciated_through, 'YYYY-MM') AS depreciated_through,
                  to_char(a.disposed_on, 'YYYY-MM-DD') AS disposed_on
           FROM assets a
           JOIN branches b ON b.id = a.branch_id
           LEFT JOIN users u ON u.id = a.responsible_user_id
           WHERE ($1::uuid IS NULL OR a.branch_id = $1::uuid)
           ORDER BY b.code, a.inventory_no LIMIT 20000`,
          [f.branchId ?? null, base],
        ),
      columns: () => [
        col('Inventory no.', 'inventory_no'),
        col('Branch', 'branch'),
        col('Name', 'name'),
        col('Category', 'category'),
        col('Status', 'status'),
        col('Serial no.', 'serial_no'),
        col('Location', 'location'),
        col('Responsible', 'responsible'),
        col('Acquired', 'acquired'),
        col('Cost', 'acquisition_cost'),
        col('Currency', 'currency'),
        col('Useful life, months', 'useful_life_months'),
        col('Residual value', 'salvage_value'),
        col('Accumulated depreciation', 'accumulated'),
        col('Net book value', 'net_book_value'),
        col(`Net book value, ${config.consolidationCurrency}`, 'nbv_base'),
        col('Depreciated through', 'depreciated_through'),
        col('Disposed on', 'disposed_on'),
      ],
    },

    depreciation: {
      permission: 'asset.read',
      load: (tx, f) =>
        tx.many(
          `SELECT to_char(d.period, 'YYYY-MM') AS period, b.code AS branch, a.inventory_no, a.name,
                  a.category::text, d.amount::float8, d.currency, d.amount_base::float8, d.accumulated::float8
           FROM asset_depreciation d
           JOIN assets a ON a.id = d.asset_id
           JOIN branches b ON b.id = d.branch_id
           WHERE ($1::uuid IS NULL OR d.branch_id = $1::uuid)
             AND ($2::date IS NULL OR d.period >= date_trunc('month', $2::date))
             AND ($3::date IS NULL OR d.period <= $3::date)
           ORDER BY d.period DESC, b.code, a.inventory_no LIMIT 20000`,
          [f.branchId ?? null, f.from ?? null, f.to ?? null],
        ),
      columns: () => [
        col('Period', 'period'),
        col('Branch', 'branch'),
        col('Inventory no.', 'inventory_no'),
        col('Asset', 'name'),
        col('Category', 'category'),
        col('Depreciation', 'amount'),
        col('Currency', 'currency'),
        col(`Depreciation, ${config.consolidationCurrency}`, 'amount_base'),
        col('Accumulated', 'accumulated'),
      ],
    },

    ledger: {
      permission: 'finance.read',
      load: (tx, f) =>
        tx.many(
          `SELECT to_char(l.entry_date, 'YYYY-MM-DD') AS date, b.code AS branch, l.account,
                  l.account_group::text, l.debit::float8, l.credit::float8, l.currency,
                  l.amount_base::float8, l.fx_rate::float8, l.source_type, l.description
           FROM ledger_entries l JOIN branches b ON b.id = l.branch_id
           WHERE ($1::uuid IS NULL OR l.branch_id = $1::uuid)
             AND ($2::date IS NULL OR l.entry_date >= $2::date)
             AND ($3::date IS NULL OR l.entry_date <= $3::date)
           ORDER BY l.entry_date DESC, l.created_at DESC LIMIT 50000`,
          [f.branchId ?? null, f.from ?? null, f.to ?? null],
        ),
      columns: () => [
        col('Date', 'date'),
        col('Branch', 'branch'),
        col('Account', 'account'),
        col('Group', 'account_group'),
        col('Debit', 'debit'),
        col('Credit', 'credit'),
        col('Currency', 'currency'),
        col(`Amount, ${config.consolidationCurrency}`, 'amount_base'),
        col('FX rate', 'fx_rate'),
        col('Source', 'source_type'),
        col('Description', 'description'),
      ],
    },

    branches: {
      load: (tx) =>
        tx.many(
          `SELECT b.code, b.country, b.city, b.currency, b.legal_name, b.legal_form, b.registration_no,
                  b.tax_id, b.vat_number, b.bank_name, b.bank_account, b.bank_swift, b.phone, b.email,
                  b.website, b.established_year, b.accreditation, u.full_name AS head, b.head_title
           FROM branches b LEFT JOIN users u ON u.id = b.head_user_id
           ORDER BY b.is_hq DESC, b.code`,
        ),
      columns: () => [
        col('Code', 'code'),
        col('Country', 'country'),
        col('City', 'city'),
        col('Currency', 'currency'),
        col('Legal name', 'legal_name'),
        col('Legal form', 'legal_form'),
        col('Registration no.', 'registration_no'),
        col('Tax ID', 'tax_id'),
        col('VAT no.', 'vat_number'),
        col('Bank', 'bank_name'),
        col('Account / IBAN', 'bank_account'),
        col('SWIFT', 'bank_swift'),
        col('Phone', 'phone'),
        col('Email', 'email'),
        col('Website', 'website'),
        col('Established', 'established_year'),
        col('Accreditation', 'accreditation'),
        col('Head of branch', 'head'),
        col('Title', 'head_title'),
      ],
    },

    commodities: {
      // Reference data: the same for every branch, so the filters do not apply.
      load: (tx, _f) =>
        tx.many(
          `SELECT code, "group"::text, name->>'en' AS name_en, name->>'ru' AS name_ru, name->>'tr' AS name_tr,
                  hs_code, array_to_string(lab_methods, ' | ') AS lab_methods, is_active,
                  (SELECT count(*) FROM inspection_jobs j WHERE j.commodity_id = commodities.id)::int AS jobs
           FROM commodities ORDER BY sort_order`,
          [],
        ),
      columns: () => [
        col('Code', 'code'),
        col('Group', 'group'),
        col('Name (EN)', 'name_en'),
        col('Name (RU)', 'name_ru'),
        col('Name (TR)', 'name_tr'),
        col('HS code', 'hs_code'),
        col('Lab methods', 'lab_methods'),
        col('Active', 'is_active'),
        col('Jobs', 'jobs'),
      ],
    },

    ports: {
      load: (tx) =>
        tx.many(
          `SELECT code, name, country, is_inland, is_active,
                  (SELECT count(*) FROM inspection_jobs j WHERE j.port_id = ports.id)::int AS jobs
           FROM ports ORDER BY country, name`,
        ),
      columns: () => [
        col('Code', 'code'),
        col('Name', 'name'),
        col('Country', 'country'),
        col('Inland', 'is_inland'),
        col('Active', 'is_active'),
        col('Jobs', 'jobs'),
      ],
    },
  };

  sectionNames(user: AuthUser): string[] {
    return Object.entries(this.sections)
      .filter(([, s]) => this.allowed(user, s))
      .map(([name]) => name);
  }

  private allowed(user: AuthUser, section: Section): boolean {
    return !section.permission || (user.permissions?.includes(section.permission) ?? false);
  }

  async csv(user: AuthUser, section: string, f: ExportFilters, dialect: CsvDialect): Promise<string> {
    const def = this.sections[section];
    if (!def) throw new NotFoundException(`Unknown export section "${section}"`);
    if (!this.allowed(user, def)) {
      throw new ForbiddenException('Not allowed to export this section');
    }
    const rows = await this.db.tx(user, (tx) => def.load(tx, f, this.base));
    return toCsv(rows, def.columns(f.locale ?? user.locale ?? 'en'), dialect);
  }

  /** Every section the user may see, as one file each — for the "export everything" button. */
  async allSections(user: AuthUser, f: ExportFilters, dialect: CsvDialect): Promise<{ name: string; csv: string }[]> {
    const out: { name: string; csv: string }[] = [];
    for (const name of this.sectionNames(user)) {
      out.push({ name, csv: await this.csv(user, name, f, dialect) });
    }
    return out;
  }
}
