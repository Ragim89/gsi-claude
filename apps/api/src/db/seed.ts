/**
 * Idempotent dev/demo seed: the 7 GSI branches, demo users per role, a few clients and one job.
 * Runs as the schema owner. Do NOT run against production (SEED_DEMO must be explicitly 'true'
 * in production mode).
 */
import * as bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { config } from '../config';
import { wrapClient } from './db.service';
import { seedInspection } from './seed-inspection';
import { seedFinance, seedFxRates } from './seed-finance';
import { seedReference } from './seed-reference';
import { seedAssets, seedDepreciation } from './seed-assets';

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
  // ASSUMPTION: Russia is not among the seven representations in docs/00-overview.md; it was
  // added on request. Novorossiysk (the main grain export port) is a placeholder city —
  // change `city`, `legalName` and the requisites once GSI confirms the entity.
  { code: 'RU', country: 'RU', city: 'Novorossiysk', currency: 'RUB', locale: 'ru', uiLocales: ['ru', 'en'], timezone: 'Europe/Moscow', legalName: 'GSI Russia — legal name TBC', address: 'Novorossiysk, Russia' },
];

/**
 * Requisites shown on the branch card and (later) on printed forms.
 * ASSUMPTION: every value here is a placeholder pending GSI's real registration, tax and
 * bank data (docs/07-open-questions.md #2) — hence the "TBC" markers.
 */
const BRANCH_PROFILE: Record<string, {
  legalForm: string; registrationNo: string; taxId: string; vatNumber?: string;
  bankName: string; bankAccount: string; bankSwift: string; phone: string; email: string;
  website: string; established: number; headEmail: string; headTitle: string; description: string;
}> = {
  TR: { legalForm: 'A.Ş.', registrationNo: 'İstanbul Trade Register TBC', taxId: 'VKN TBC', vatNumber: 'TR-TBC', bankName: 'Bank name TBC', bankAccount: 'TR00 0000 0000 0000 0000 0000 00', bankSwift: 'TBCXTRIS', phone: '+90 216 000 00 00', email: 'istanbul@gsi.example', website: 'https://gsi.example', established: 1997, headEmail: 'supervisor.tr@gsi.local', headTitle: 'Genel Müdür / General Manager', description: 'Head office of the group: inspection, laboratory and fumigation services for the Marmara and Mediterranean ports.' },
  RO: { legalForm: 'SRL', registrationNo: 'J13/TBC', taxId: 'CUI TBC', vatNumber: 'RO-TBC', bankName: 'Bank name TBC', bankAccount: 'RO00 TBC0 0000 0000 0000 0000', bankSwift: 'TBCXROBU', phone: '+40 241 000 000', email: 'constanta@gsi.example', website: 'https://gsi.example', established: 2004, headEmail: 'supervisor.ro@gsi.local', headTitle: 'Branch Manager', description: 'Constanța office: draft surveys and quality supervision on the Black Sea grain corridor.' },
  UA: { legalForm: 'LLC', registrationNo: 'EDRPOU TBC', taxId: 'TIN TBC', bankName: 'Bank name TBC', bankAccount: 'UA00 TBC0 0000 0000 0000 0000 0', bankSwift: 'TBCXUAUK', phone: '+380 48 000 0000', email: 'odesa@gsi.example', website: 'https://gsi.example', established: 2006, headEmail: 'supervisor.ua@gsi.local', headTitle: 'Branch Manager', description: 'Odesa office: loading supervision and sampling for grain and oilseed exports.' },
  UZ: { legalForm: 'LLC', registrationNo: 'Reg. No TBC', taxId: 'INN TBC', bankName: 'Bank name TBC', bankAccount: 'UZ00 TBC0 0000 0000 0000 0000', bankSwift: 'TBCXUZUZ', phone: '+998 71 000 0000', email: 'tashkent@gsi.example', website: 'https://gsi.example', established: 2015, headEmail: 'supervisor.uz@gsi.local', headTitle: 'Branch Manager', description: 'Tashkent office: warehouse and railway shipment supervision in Central Asia.' },
  KZ: { legalForm: 'TOO', registrationNo: 'BIN TBC', taxId: 'IIN/BIN TBC', bankName: 'Bank name TBC', bankAccount: 'KZ00 TBC0 0000 0000 0000', bankSwift: 'TBCXKZKA', phone: '+7 7172 00 00 00', email: 'astana@gsi.example', website: 'https://gsi.example', established: 2012, headEmail: 'supervisor.kz@gsi.local', headTitle: 'Branch Manager', description: 'Astana office: elevator stock monitoring and grain quality supervision.' },
  AE: { legalForm: 'FZE', registrationNo: 'RAK FTZ Licence TBC', taxId: 'TRN TBC', bankName: 'Bank name TBC', bankAccount: 'AE00 0000 0000 0000 0000 000', bankSwift: 'TBCXAEAD', phone: '+971 7 000 0000', email: 'rak@gsi.example', website: 'https://gsi.example', established: 2010, headEmail: 'supervisor.ae@gsi.local', headTitle: 'General Manager', description: 'Ras Al Khaimah free-zone entity: cargo supervision and collateral management for the Gulf.' },
  IT: { legalForm: 'S.p.A.', registrationNo: 'REA TBC', taxId: 'Codice Fiscale TBC', vatNumber: 'IT-TBC', bankName: 'Bank name TBC', bankAccount: 'IT00 T000 0000 0000 0000 0000 000', bankSwift: 'TBCXITRR', phone: '+39 0544 000 000', email: 'ravenna@gsi.example', website: 'https://gsi.example', established: 2008, headEmail: 'supervisor.it@gsi.local', headTitle: 'Branch Manager', description: 'Ravenna office: discharge supervision and cleanliness inspections in the Adriatic.' },
  RU: { legalForm: 'OOO', registrationNo: 'OGRN TBC', taxId: 'INN TBC', bankName: 'Bank name TBC', bankAccount: '40702810 TBC 0000000000', bankSwift: 'TBCXRUMM', phone: '+7 8617 00 00 00', email: 'novorossiysk@gsi.example', website: 'https://gsi.example', established: 2011, headEmail: 'supervisor.ru@gsi.local', headTitle: 'Branch Manager', description: 'Novorossiysk office: draft surveys and loading supervision in the Azov–Black Sea basin.' },
};

/** Country names in their own language, for the country level of the hierarchy. */
const COUNTRY_NAMES: Record<string, string> = {
  TR: 'Türkiye',
  RO: 'România',
  UA: 'Україна',
  UZ: 'Oʻzbekiston',
  KZ: 'Қазақстан',
  AE: 'United Arab Emirates',
  IT: 'Italia',
  RU: 'Россия',
};

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
  { email: 'supervisor.ru@gsi.local', name: 'Сергей Волков', role: 'supervisor', branch: 'RU', locale: 'ru' },
  { email: 'inspector.ru@gsi.local', name: 'Николай Орлов', role: 'inspector', branch: 'RU', locale: 'ru' },
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
  { branch: 'RU', name: 'Новороссийский зерновой терминал', ref: 'GAFTA-M-0006', country: 'RU', email: 'export@nzt.example' },
  { branch: 'RU', name: 'Кубань Агро Экспорт', ref: null, country: 'RU', email: 'trade@kubanagro.example' },
];

export interface SeedOptions {
  /**
   * Whether to generate the bulky demo history (a year of jobs, invoices, expenses, assets
   * and depreciation). Tests turn it off: they need the reference data and the accounts,
   * not 900 invoices. Defaults to the SEED_DEMO_VOLUME environment variable.
   */
  volume?: boolean;
}

export async function seed(options: SeedOptions = {}): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO !== 'true') {
    console.log('seed skipped (production)');
    return;
  }
  if (process.env.NODE_ENV === 'production') {
    console.warn('WARNING: seeding demo data into a production database because SEED_DEMO=true');
  }
  const withVolume = options.volume ?? process.env.SEED_DEMO_VOLUME !== 'false';
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
      // Every demo account carries its role explicitly. Without this a user would fall back
      // to whichever role happens to declare their legacy value first, which is fragile.
      await tx.exec(
        `INSERT INTO user_roles (user_id, role_code)
         SELECT usr.id, $2 FROM users usr WHERE lower(usr.email) = lower($1)
         ON CONFLICT DO NOTHING`,
        [u.email, u.role],
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
      await seedInspection(tx, {
        jobId: job!.id,
        branchId: tr,
        type: 'loading_discharge',
        jobStatus: 'assigned',
        leadInspectorId: inspector!.id,
        location: 'Port of Derince, Berth 5',
        scheduledStart: new Date(Date.now() + 86400000).toISOString(),
        createdBy: supervisor!.id,
      });
    }

    // Countries are created by the branch trigger with the ISO code as their name; give the
    // ones the group works in their proper names.
    for (const [code, name] of Object.entries(COUNTRY_NAMES)) {
      await tx.exec(`UPDATE countries SET name = $2 WHERE code = $1 AND name = code`, [code, name]);
    }

    // Requisites and the head of each entity (idempotent: only fills what is still empty).
    for (const [code, p] of Object.entries(BRANCH_PROFILE)) {
      await tx.exec(
        `UPDATE branches b SET
           legal_form = COALESCE(b.legal_form, $2), registration_no = COALESCE(b.registration_no, $3),
           tax_id = COALESCE(b.tax_id, $4), vat_number = COALESCE(b.vat_number, $5),
           bank_name = COALESCE(b.bank_name, $6), bank_account = COALESCE(b.bank_account, $7),
           bank_swift = COALESCE(b.bank_swift, $8), phone = COALESCE(b.phone, $9),
           email = COALESCE(b.email, $10), website = COALESCE(b.website, $11),
           established_year = COALESCE(b.established_year, $12), description = COALESCE(b.description, $13),
           head_title = COALESCE(b.head_title, $14),
           head_user_id = COALESCE(b.head_user_id, (SELECT u.id FROM users u WHERE lower(u.email) = lower($15)))
         WHERE b.code = $1`,
        [code, p.legalForm, p.registrationNo, p.taxId, p.vatNumber ?? null, p.bankName, p.bankAccount,
         p.bankSwift, p.phone, p.email, p.website, p.established, p.description, p.headTitle, p.headEmail],
      );
    }

    // Commodities and ports: the references every filter and report works on.
    await seedReference(client);

    // Exchange rates are needed by every posting, demo volume or not.
    await seedFxRates(client);

    if (withVolume) {
      // A year of group-wide financial history for the dashboard (jobs, invoices, expenses, FX).
      await seedFinance(client);

      // Fixed assets and their depreciation history (feeds capitalisation and the P&L).
      await seedAssets(client);
      await seedDepreciation(client);
    }

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
