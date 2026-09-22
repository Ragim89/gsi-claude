/**
 * Idempotent dev/demo seed: the 7 GSI branches, demo users per role, a few clients and one job.
 * Runs as the schema owner. Do NOT run against production (SEED_DEMO must be explicitly 'true'
 * in production mode).
 */
import * as bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { config } from '../config';
import { wrapClient } from './db.service';
import { seedChecklist } from '../operations/checklist-seed';
import { seedFinance } from './seed-finance';

// ASSUMPTION: legal names / addresses are placeholders until GSI confirms the list of legal
// entities (docs/07-open-questions.md #2). Only the Turkish accreditation data comes from the brief.
const BRANCHES = [
  {
    code: 'TR', country: 'TR', city: 'Istanbul', currency: 'TRY', locale: 'tr', uiLocales: ['tr', 'en'],
    timezone: 'Europe/Istanbul', isHq: true, template: 'tr-default',
    legalName: 'General Survey Inspection (Türkiye) — legal name TBC',
    address: 'Ataşehir, İstanbul, Türkiye',
    accreditation: 'TS EN ISO/IEC 17020:2012 — Type A Inspection Body, No. AB-0193-M',
  },
  { code: 'RO', country: 'RO', city: 'Constanța', currency: 'RON', locale: 'ro', uiLocales: ['ro', 'en'], timezone: 'Europe/Bucharest', legalName: 'GSI Romania — legal name TBC', address: 'Constanța, România' },
  { code: 'UA', country: 'UA', city: 'Odesa', currency: 'UAH', locale: 'uk', uiLocales: ['uk', 'ru'], timezone: 'Europe/Kyiv', legalName: 'GSI Ukraine — legal name TBC', address: 'Odesa, Ukraine' },
  { code: 'UZ', country: 'UZ', city: 'Tashkent', currency: 'UZS', locale: 'uz', uiLocales: ['uz', 'ru'], timezone: 'Asia/Tashkent', legalName: 'GSI Uzbekistan — legal name TBC', address: 'Tashkent, Uzbekistan' },
  { code: 'KZ', country: 'KZ', city: 'Astana', currency: 'KZT', locale: 'ru', uiLocales: ['ru', 'kk'], timezone: 'Asia/Almaty', legalName: 'GSI Kazakhstan — legal name TBC', address: 'Astana, Kazakhstan' },
  { code: 'AE', country: 'AE', city: 'Ras Al Khaimah', currency: 'AED', locale: 'en', uiLocales: ['en', 'ar'], timezone: 'Asia/Dubai', legalName: 'GSI FZE — legal name TBC', address: 'Ras Al Khaimah, UAE' },
  { code: 'IT', country: 'IT', city: 'Ravenna', currency: 'EUR', locale: 'it', uiLocales: ['it', 'en'], timezone: 'Europe/Rome', legalName: 'GSI Italy — legal name TBC', address: 'Ravenna, Italia' },
];

const USERS = [
  { email: 'admin@gsi.local', name: 'System Administrator', role: 'admin', branch: 'TR', locale: 'en' },
  { email: 'cfo@gsi.local', name: 'Group CFO', role: 'cfo', branch: 'TR', locale: 'en' },
  { email: 'finance.tr@gsi.local', name: 'Elif Kaya', role: 'finance_controller', branch: 'TR', locale: 'tr' },
  { email: 'supervisor.tr@gsi.local', name: 'Ayşe Demir', role: 'supervisor', branch: 'TR', locale: 'tr' },
  { email: 'inspector.tr@gsi.local', name: 'Mehmet Yılmaz', role: 'inspector', branch: 'TR', locale: 'tr' },
  { email: 'inspector2.tr@gsi.local', name: 'Can Öztürk', role: 'inspector', branch: 'TR', locale: 'tr' },
  { email: 'supervisor.ro@gsi.local', name: 'Andrei Popescu', role: 'supervisor', branch: 'RO', locale: 'en' },
  { email: 'inspector.ro@gsi.local', name: 'Ioana Ionescu', role: 'inspector', branch: 'RO', locale: 'en' },
  { email: 'finance.ro@gsi.local', name: 'Elena Marin', role: 'finance_controller', branch: 'RO', locale: 'en' },
  { email: 'supervisor.ua@gsi.local', name: 'Olha Kovalenko', role: 'supervisor', branch: 'UA', locale: 'ru' },
  { email: 'inspector.ua@gsi.local', name: 'Dmytro Shevchenko', role: 'inspector', branch: 'UA', locale: 'ru' },
  { email: 'supervisor.uz@gsi.local', name: 'Aziz Rakhimov', role: 'supervisor', branch: 'UZ', locale: 'ru' },
  { email: 'inspector.uz@gsi.local', name: 'Sanjar Yusupov', role: 'inspector', branch: 'UZ', locale: 'ru' },
  { email: 'supervisor.kz@gsi.local', name: 'Aliya Nurpeisova', role: 'supervisor', branch: 'KZ', locale: 'ru' },
  { email: 'inspector.kz@gsi.local', name: 'Yerlan Sagyndykov', role: 'inspector', branch: 'KZ', locale: 'ru' },
  { email: 'supervisor.ae@gsi.local', name: 'Omar Al Naqbi', role: 'supervisor', branch: 'AE', locale: 'en' },
  { email: 'inspector.ae@gsi.local', name: 'Rashid Hassan', role: 'inspector', branch: 'AE', locale: 'en' },
  { email: 'supervisor.it@gsi.local', name: 'Marco Bianchi', role: 'supervisor', branch: 'IT', locale: 'en' },
  { email: 'inspector.it@gsi.local', name: 'Giulia Rossi', role: 'inspector', branch: 'IT', locale: 'en' },
];

const CLIENTS = [
  { branch: 'TR', name: 'Anatolia Grain Trading A.Ş.', ref: 'GAFTA-M-0000', country: 'TR', email: 'ops@anatolia-grain.example' },
  { branch: 'TR', name: 'Bosphorus Oilseeds Ltd.', ref: 'FOSFA-0000', country: 'TR', email: 'trade@bosphorus-oil.example' },
  { branch: 'TR', name: 'Marmara Shipping & Chartering', ref: 'GAFTA-M-0001', country: 'TR', email: 'chartering@marmara-ship.example' },
  { branch: 'RO', name: 'Danube Agri SRL', ref: null, country: 'RO', email: 'office@danube-agri.example' },
  { branch: 'RO', name: 'Constanta Bulk Terminal SA', ref: 'GAFTA-M-0002', country: 'RO', email: 'terminal@cbt.example' },
  { branch: 'UA', name: 'Chornomorsk Grain Union', ref: 'GAFTA-M-0003', country: 'UA', email: 'export@cgu.example' },
  { branch: 'UA', name: 'Odesa Sunflower Export LLC', ref: 'FOSFA-0001', country: 'UA', email: 'sales@osx.example' },
  { branch: 'UZ', name: 'Tashkent Agro Holding', ref: null, country: 'UZ', email: 'info@tashagro.example' },
  { branch: 'KZ', name: 'Astana Grain Company', ref: 'GAFTA-M-0004', country: 'KZ', email: 'trade@astanagrain.example' },
  { branch: 'AE', name: 'Gulf Commodities FZE', ref: 'FOSFA-0002', country: 'AE', email: 'ops@gulfcomm.example' },
  { branch: 'AE', name: 'Emirates Feed Imports', ref: null, country: 'AE', email: 'imports@emfeed.example' },
  { branch: 'IT', name: 'Adriatica Cereali SpA', ref: 'GAFTA-M-0005', country: 'IT', email: 'ufficio@adriatica.example' },
];

export async function seed(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO !== 'true') {
    console.log('seed skipped (production)');
    return;
  }
  const password = process.env.SEED_PASSWORD ?? 'ChangeMe123!';
  const hash = await bcrypt.hash(password, 10);

  const client = new Client({ connectionString: config.databaseOwnerUrl });
  await client.connect();
  const tx = wrapClient(client);
  try {
    await client.query('BEGIN');

    for (const b of BRANCHES) {
      await tx.exec(
        `INSERT INTO branches (code, country, city, currency, locale, ui_locales, timezone, legal_name, address,
                               accreditation, is_hq, letterhead_template_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (code) DO NOTHING`,
        [b.code, b.country, b.city, b.currency, b.locale, b.uiLocales, b.timezone, b.legalName, b.address,
         b.accreditation ?? null, b.isHq ?? false, b.template ?? 'tr-default'],
      );
    }
    const branchId = new Map(
      (await tx.many<{ id: string; code: string }>('SELECT id, code FROM branches')).map((r) => [r.code, r.id]),
    );

    for (const u of USERS) {
      await tx.exec(
        `INSERT INTO users (branch_id, email, password_hash, full_name, role, locale)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT ((lower(email))) DO NOTHING`,
        [branchId.get(u.branch), u.email, hash, u.name, u.role, u.locale],
      );
    }

    for (const c of CLIENTS) {
      await tx.exec(
        `INSERT INTO clients (branch_id, name, gafta_fosfa_ref, country, contact_email)
         SELECT $1::uuid, $2::text, $3::text, $4::text, $5::text
         WHERE NOT EXISTS (SELECT 1 FROM clients WHERE branch_id = $1 AND name = $2)`,
        [branchId.get(c.branch), c.name, c.ref, c.country, c.email],
      );
    }

    // One demo job in Turkey assigned to the TR inspector.
    const hasJob = await tx.one('SELECT 1 FROM inspection_jobs LIMIT 1');
    if (!hasJob) {
      const tr = branchId.get('TR')!;
      // next_doc_number() checks the caller's branch context.
      await client.query(`SELECT set_config('app.role', 'admin', true), set_config('app.branch_id', $1, true)`, [tr]);
      const clientRow = await tx.one<{ id: string }>(`SELECT id FROM clients WHERE branch_id = $1 ORDER BY name LIMIT 1`, [tr]);
      const inspector = await tx.one<{ id: string }>(`SELECT id FROM users WHERE email = 'inspector.tr@gsi.local'`);
      const supervisor = await tx.one<{ id: string }>(`SELECT id FROM users WHERE email = 'supervisor.tr@gsi.local'`);
      const job = await tx.one<{ id: string }>(
        `INSERT INTO inspection_jobs (branch_id, job_number, client_id, type, status, assigned_inspector_id,
                                      location, vessel_or_object, commodity, quantity, scheduled_at, created_by)
         VALUES ($1, next_doc_number($1, 'J'), $2, 'loading_discharge', 'assigned', $3,
                 'Port of Derince, Berth 5', 'MV Demo Carrier', 'Milling wheat', '25,000 MT ±10%', now() + interval '1 day', $4)
         RETURNING id`,
        [tr, clientRow!.id, inspector!.id, supervisor!.id],
      );
      await seedChecklist(tx, job!.id, 'loading_discharge');
    }

    // A year of group-wide financial history for the dashboard (jobs, invoices, expenses, FX).
    await seedFinance(client);

    await client.query('COMMIT');
    console.log(process.env.SEED_PASSWORD ? "seed complete — demo users use SEED_PASSWORD" : `seed complete — demo users use the default password ${password}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  seed().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
