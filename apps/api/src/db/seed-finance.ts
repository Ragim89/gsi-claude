/**
 * Demo history for the finance dashboard: ~12 months of jobs, invoices, payments and
 * expenses for every branch, plus FX rates to the consolidation currency. Branches are
 * seeded independently, so an entity added later gets its own history on the next run.
 *
 * Deterministic (fixed PRNG seed) so repeated runs and screenshots stay comparable.
 * ASSUMPTION: figures are invented for demonstration; they are not GSI's real numbers.
 */
import { ClientBase } from 'pg';
import { SERVICE_TYPES, ServiceType } from '@gsi/shared-types';
import { wrapClient, Tx } from './db.service';
import { config } from '../config';
import { seedChecklist } from '../operations/checklist-seed';

// Indicative mid-market rates to EUR (ASSUMPTION: manual reference data, see fx-rates API).
const RATES: Record<string, number> = {
  EUR: 1, TRY: 0.0235, RON: 0.201, UAH: 0.0221, UZS: 0.0000722, KZT: 0.00175, AED: 0.2334, RUB: 0.0104,
};

// Per-branch profile: monthly job volume, average invoice in local currency, cost ratio.
const PROFILE: Record<string, { jobs: number; avgInvoice: number; costRatio: number; vat: number }> = {
  TR: { jobs: 18, avgInvoice: 42000, costRatio: 0.62, vat: 20 },
  RO: { jobs: 11, avgInvoice: 4200, costRatio: 0.66, vat: 19 },
  UA: { jobs: 9, avgInvoice: 38000, costRatio: 0.6, vat: 20 },
  UZ: { jobs: 6, avgInvoice: 11000000, costRatio: 0.58, vat: 12 },
  KZ: { jobs: 7, avgInvoice: 420000, costRatio: 0.61, vat: 12 },
  AE: { jobs: 8, avgInvoice: 3600, costRatio: 0.55, vat: 5 },
  IT: { jobs: 6, avgInvoice: 900, costRatio: 0.68, vat: 22 },
  RU: { jobs: 10, avgInvoice: 95000, costRatio: 0.63, vat: 20 },
};

const EXPENSE_MIX: { category: string; share: number; supplier: string }[] = [
  { category: 'salary', share: 0.52, supplier: 'Payroll' },
  { category: 'travel', share: 0.14, supplier: 'Travel agency' },
  { category: 'subcontractor', share: 0.12, supplier: 'Local surveyor' },
  { category: 'lab_materials', share: 0.09, supplier: 'Lab supplies Ltd.' },
  { category: 'equipment', share: 0.06, supplier: 'Marine Equipment Co.' },
  { category: 'office', share: 0.07, supplier: 'Office rent' },
];

const VESSELS = ['MV Black Sea Star', 'MV Anatolian Pride', 'MV Danube Trader', 'MV Caspian Wind',
  'MV Adriatic Dawn', 'MV Bosphorus Queen', 'MV Odessa Spirit', 'MV Gulf Navigator'];
const COMMODITIES = ['Milling wheat', 'Feed barley', 'Sunflower seed', 'Sunflower oil (crude)',
  'Corn', 'Soybean meal', 'Rapeseed', 'Chickpeas'];
const LOCATIONS: Record<string, string[]> = {
  TR: ['Port of Derince, Berth 5', 'Port of Mersin', 'Port of İzmir (Alsancak)', 'Tekirdağ Akport'],
  RO: ['Port of Constanța, Berth 31', 'Port of Galați'],
  UA: ['Port of Odesa, Berth 12', 'Pivdennyi Port'],
  UZ: ['Tashkent grain terminal', 'Sergeli warehouse complex'],
  KZ: ['Astana elevator #3', 'Aktau sea port'],
  AE: ['Port of Ras Al Khaimah', 'Jebel Ali, Dubai'],
  IT: ['Port of Ravenna, Berth 22', 'Port of Venice'],
  RU: ['Новороссийск, причал 14', 'Порт Тамань', 'Ростов-на-Дону, элеватор'],
};

/** Deterministic PRNG (mulberry32) so the demo data is identical on every run. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Exchange rates only: one per month per currency, with a little drift. Separate from the rest
 * of the demo data because every posting needs a rate — including in tests, which do not want
 * a year of invoices.
 */
export async function seedFxRates(client: ClientBase): Promise<void> {
  const tx = wrapClient(client);
  const base = config.consolidationCurrency;
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1));

  for (const [currency, rate] of Object.entries(RATES)) {
    if (currency === base) continue;
    const rand = rng(currency.charCodeAt(0) * 31);
    for (let m = 0; m <= 12; m++) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, 1));
      const drift = 1 + (rand() - 0.5) * 0.06;
      await tx.exec(
        `INSERT INTO fx_rates (currency, base_currency, rate, rate_date) VALUES ($1, $2, $3, $4::date)
         ON CONFLICT (currency, base_currency, rate_date) DO NOTHING`,
        [currency, base, (rate * drift).toFixed(10), iso(d)],
      );
    }
  }
  await tx.exec(`INSERT INTO fx_rates (currency, base_currency, rate, rate_date) VALUES ($1, $1, 1, $2::date)
                 ON CONFLICT DO NOTHING`, [base, iso(today)]);
}

export async function seedFinance(client: ClientBase): Promise<void> {
  const tx = wrapClient(client);
  const base = config.consolidationCurrency;
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1));

  await seedFxRates(client);

  const branches = await tx.many<{ id: string; code: string; currency: string }>(
    'SELECT id, code, currency FROM branches ORDER BY code',
  );
  const users = await tx.many<{ id: string; branch_id: string; role: string }>(
    `SELECT id, branch_id, role FROM users`,
  );
  const clientsByBranch = new Map<string, { id: string }[]>();
  for (const b of branches) {
    clientsByBranch.set(
      b.id,
      await tx.many<{ id: string }>('SELECT id FROM clients WHERE branch_id = $1 ORDER BY name', [b.id]),
    );
  }

  let jobs = 0;
  let invoices = 0;
  let expenses = 0;

  for (const branch of branches) {
    const profile = PROFILE[branch.code];
    // Per-branch check: a branch added later (e.g. RU) still gets its history on the next run.
    if (await tx.one('SELECT 1 FROM invoices WHERE branch_id = $1 LIMIT 1', [branch.id])) continue;
    const clients = clientsByBranch.get(branch.id) ?? [];
    if (!profile || !clients.length) continue;

    const inspectors = users.filter((u) => u.branch_id === branch.id && u.role === 'inspector');
    const supervisor = users.find((u) => u.branch_id === branch.id && u.role === 'supervisor')
      ?? users.find((u) => u.role === 'admin')!;
    const rand = rng(branch.code.charCodeAt(0) * 977 + branch.code.charCodeAt(1));

    // next_doc_number() and RLS need a branch context; the seed runs as the schema owner.
    await client.query(`SELECT set_config('app.role', 'admin', true), set_config('app.branch_id', $1, true),
                               set_config('app.user_id', $2, true)`, [branch.id, supervisor.id]);

    for (let m = 0; m < 12; m++) {
      const monthStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, 1));
      if (monthStart > today) break;
      // Seasonality: grain season peaks after harvest (Jul–Oct).
      const month = monthStart.getUTCMonth();
      const season = month >= 6 && month <= 9 ? 1.35 : month <= 1 ? 0.75 : 1;
      const count = Math.max(1, Math.round(profile.jobs * season * (0.8 + rand() * 0.4)));

      let monthRevenue = 0;
      for (let i = 0; i < count; i++) {
        const day = 1 + Math.floor(rand() * 27);
        const date = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), day, 9));
        if (date > today) continue;
        const type = SERVICE_TYPES[Math.floor(rand() * SERVICE_TYPES.length)] as ServiceType;
        const clientId = clients[Math.floor(rand() * clients.length)].id;
        const inspector = inspectors.length ? inspectors[Math.floor(rand() * inspectors.length)] : null;
        const locations = LOCATIONS[branch.code];

        // Most demo history is finished work, with a realistic tail of jobs still running —
        // an operations screen that only ever shows approved jobs teaches nobody anything.
        const roll = rand();
        const status =
          roll < 0.72 ? 'approved'
          : roll < 0.78 ? 'completed'
          : roll < 0.84 ? 'invoiced'
          : roll < 0.88 ? 'closed'
          : roll < 0.92 ? 'in_progress'
          : roll < 0.95 ? 'assigned'
          : roll < 0.97 ? 'under_review'
          : roll < 0.985 ? 'confirmed'
          : 'on_hold';
        const finished = ['approved', 'completed', 'invoiced', 'closed'].includes(status);
        const priorityRoll = rand();
        const priority =
          priorityRoll < 0.08 ? 'urgent' : priorityRoll < 0.25 ? 'high' : priorityRoll < 0.9 ? 'normal' : 'low';

        const job = await tx.one<{ id: string }>(
          `INSERT INTO inspection_jobs (branch_id, job_number, client_id, type, status, priority,
              assigned_inspector_id, location, vessel_or_object, commodity, quantity, scheduled_at,
              requested_date, created_at, submitted_at, approved_at, approved_by, created_by,
              status_before_hold)
           VALUES ($1, next_doc_number($1, 'J'), $2, $3, $11::job_status, $12::job_priority, $4, $5, $6, $7, $8,
                   $9::timestamptz, ($9::timestamptz - interval '2 day')::date, $9::timestamptz,
                   CASE WHEN $13 THEN $9::timestamptz + interval '1 day' END,
                   CASE WHEN $13 THEN $9::timestamptz + interval '2 day' END,
                   CASE WHEN $13 THEN $10::uuid END, $10,
                   CASE WHEN $11 = 'on_hold' THEN 'in_progress'::job_status END)
           RETURNING id`,
          [branch.id, clientId, type, inspector?.id ?? null, locations[Math.floor(rand() * locations.length)],
           VESSELS[Math.floor(rand() * VESSELS.length)], COMMODITIES[Math.floor(rand() * COMMODITIES.length)],
           `${(5 + Math.floor(rand() * 45)) * 1000} MT`, date.toISOString(), supervisor.id, status, priority, finished],
        );
        await seedChecklist(tx, job!.id, type);
        if (finished || status === 'under_review') {
          await tx.exec(
            `UPDATE job_checklist_items SET result = 'ok', updated_by = $2 WHERE job_id = $1`,
            [job!.id, inspector?.id ?? supervisor.id],
          );
        }
        // The inspector on the job is its lead; some jobs also carry a second pair of hands.
        if (inspector) {
          await tx.exec(
            `INSERT INTO job_assignments (job_id, branch_id, user_id, role, assigned_by, assigned_at)
             VALUES ($1, $2, $3, 'lead_inspector', $4, $5::timestamptz) ON CONFLICT DO NOTHING`,
            [job!.id, branch.id, inspector.id, supervisor.id, date.toISOString()],
          );
          const second = inspectors.find((i) => i.id !== inspector.id);
          if (second && rand() < 0.3) {
            await tx.exec(
              `INSERT INTO job_assignments (job_id, branch_id, user_id, role, assigned_by, assigned_at)
               VALUES ($1, $2, $3, 'sampler', $4, $5::timestamptz) ON CONFLICT DO NOTHING`,
              [job!.id, branch.id, second.id, supervisor.id, date.toISOString()],
            );
          }
        }
        await tx.exec(
          `INSERT INTO job_status_history (job_id, branch_id, from_status, to_status, changed_by, created_at, metadata)
           VALUES ($1, $2, NULL, $3::job_status, $4, $5::timestamptz, '{"seed": true}'::jsonb)`,
          [job!.id, branch.id, status, supervisor.id, date.toISOString()],
        );
        jobs++;

        // Only finished work gets invoiced in the demo history.
        if (!finished) continue;

        // Invoice for the job: issued a day after approval, most of them already paid.
        const net = round2(profile.avgInvoice * (0.55 + rand()));
        const tax = round2((net * profile.vat) / 100);
        const issueDate = new Date(date.getTime() + 3 * 86400000);
        if (issueDate > today) continue;
        const dueDate = new Date(issueDate.getTime() + 30 * 86400000);
        const paidRoll = rand();
        const paid = paidRoll < 0.78 ? net + tax : paidRoll < 0.88 ? round2((net + tax) * 0.4) : 0;
        const invoiceStatus = paid >= net + tax ? 'paid' : paid > 0 ? 'partially_paid' : 'issued';

        const inv = await tx.one<{ id: string }>(
          `INSERT INTO invoices (branch_id, client_id, job_id, invoice_number, status, currency, amount_net,
              tax_rate, tax_amount, amount_total, amount_paid, issue_date, due_date, paid_at, created_by, created_at)
           VALUES ($1, $2, $3, next_doc_number($1, 'I'), $4::invoice_status, $5, $6, $7, $8, $9, $10, $11::date, $12::date,
                   CASE WHEN $4::invoice_status = 'paid' THEN $13::timestamptz END, $14, $11::date)
           RETURNING id`,
          [branch.id, clientId, job!.id, invoiceStatus, branch.currency, net, profile.vat, tax, round2(net + tax),
           paid, iso(issueDate), iso(dueDate), new Date(Math.min(issueDate.getTime() + 20 * 86400000, today.getTime())).toISOString(),
           supervisor.id],
        );
        await tx.exec(
          `INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price, sort_order)
           VALUES ($1, $2, 1, $3, 10)`,
          [inv!.id, `Inspection services — job of ${iso(date)}`, net],
        );
        invoices++;
        monthRevenue += net;

        // Ledger: revenue + receivable on issue, cash on payment.
        await postLedger(tx, branch, iso(issueDate), 'invoice', inv!.id, supervisor.id, base, [
          { account: 'ar.trade', group: 'receivable', debit: round2(net + tax) },
          { account: 'revenue.services', group: 'revenue', credit: net },
          ...(tax > 0 ? [{ account: 'tax.output_vat', group: 'tax', credit: tax }] : []),
        ]);
        if (paid > 0) {
          const payDate = new Date(Math.min(issueDate.getTime() + (10 + rand() * 25) * 86400000, today.getTime()));
          await postLedger(tx, branch, iso(payDate), 'payment', inv!.id, supervisor.id, base, [
            { account: 'cash.bank', group: 'cash', debit: paid },
            { account: 'ar.trade', group: 'receivable', credit: paid },
          ]);
        }
      }

      // Monthly running costs, proportional to revenue.
      const monthCost = monthRevenue * PROFILE[branch.code].costRatio;
      for (const mix of EXPENSE_MIX) {
        const amount = round2(monthCost * mix.share * (0.9 + rand() * 0.2));
        if (amount <= 0) continue;
        const day = 3 + Math.floor(rand() * 20);
        const date = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), day));
        if (date > today) continue;
        const exp = await tx.one<{ id: string }>(
          `INSERT INTO expenses (branch_id, category, description, supplier, currency, amount, expense_date, created_by, created_at)
           VALUES ($1, $2::expense_category, $3, $4, $5, $6, $7::date, $8, $7::date) RETURNING id`,
          [branch.id, mix.category, `${mix.category.replace('_', ' ')} — ${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`,
           mix.supplier, branch.currency, amount, iso(date), supervisor.id],
        );
        await postLedger(tx, branch, iso(date), 'expense', exp!.id, supervisor.id, base, [
          { account: `expense.${mix.category}`, group: 'expense', debit: amount },
          { account: 'cash.bank', group: 'cash', credit: amount },
        ]);
        expenses++;
      }
    }
  }

  console.log(`finance demo data: ${jobs} jobs, ${invoices} invoices, ${expenses} expenses`);
}

async function postLedger(
  tx: Tx,
  branch: { id: string; currency: string },
  date: string,
  sourceType: string,
  sourceId: string,
  userId: string,
  base: string,
  legs: { account: string; group: string; debit?: number; credit?: number }[],
): Promise<void> {
  for (const leg of legs) {
    const signed = (leg.debit ?? 0) - (leg.credit ?? 0);
    await tx.exec(
      `INSERT INTO ledger_entries (branch_id, entry_date, account, account_group, debit, credit, currency,
          amount_base, base_currency, fx_rate, source_type, source_id, description, created_by)
       SELECT $1, $2::date, $3, $4::account_group, $5, $6, $7,
              round($8 * COALESCE(fx_rate_on($7, $9, $2::date), 1), 2), $9,
              COALESCE(fx_rate_on($7, $9, $2::date), 1), $10, $11, $12, $13`,
      [branch.id, date, leg.account, leg.group, leg.debit ?? 0, leg.credit ?? 0, branch.currency,
       signed, base, sourceType, sourceId, `${sourceType} ${sourceId.slice(0, 8)}`, userId],
    );
  }
}
