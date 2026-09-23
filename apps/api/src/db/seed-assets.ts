/**
 * Demo fixed assets for every branch — offices, vehicles, laboratory and inspection equipment,
 * IT — with depreciation charged month by month for the last two years, so the register, the
 * schedule and the capitalisation figure all have something real behind them.
 *
 * ASSUMPTION: the items, costs and useful lives are invented for demonstration. Useful lives
 * follow ordinary practice (buildings 25 years, vehicles 5–7, lab instruments 5–8, IT 3).
 */
import { ClientBase } from 'pg';
import { wrapClient } from './db.service';
import { config } from '../config';

type Item = {
  name: string;
  category: string;
  life: number | null;
  /** Cost in EUR; converted to the branch currency with the seeded rate. */
  costEur: number;
  serial?: boolean;
  monthsAgo: number;
};

const CATALOGUE: Item[] = [
  { name: 'Office fit-out', category: 'real_estate', life: 300, costEur: 120000, monthsAgo: 60 },
  { name: 'Toyota Hilux 4x4 (surveyor vehicle)', category: 'vehicles', life: 84, costEur: 34000, serial: true, monthsAgo: 34 },
  { name: 'Ford Transit (sampling van)', category: 'vehicles', life: 72, costEur: 28000, serial: true, monthsAgo: 22 },
  { name: 'NIR grain analyser', category: 'lab_equipment', life: 96, costEur: 42000, serial: true, monthsAgo: 41 },
  { name: 'Moisture meter set', category: 'inspection_equipment', life: 60, costEur: 4200, serial: true, monthsAgo: 17 },
  { name: 'Draft survey kit (draft gauges, densimeters)', category: 'inspection_equipment', life: 60, costEur: 6800, monthsAgo: 29 },
  { name: 'Automatic grain sampler', category: 'inspection_equipment', life: 84, costEur: 18500, serial: true, monthsAgo: 13 },
  { name: 'Laboratory oven and scales', category: 'lab_equipment', life: 72, costEur: 9600, monthsAgo: 26 },
  { name: 'Laptops and tablets for inspectors', category: 'it_equipment', life: 36, costEur: 7400, monthsAgo: 9 },
  { name: 'Office furniture', category: 'furniture', life: 84, costEur: 11000, monthsAgo: 47 },
  { name: 'ERP and lab software licences', category: 'intangible', life: 36, costEur: 15000, monthsAgo: 6 },
];

/** How many items of the catalogue each branch gets (HQ is fully equipped). */
const BRANCH_ITEMS: Record<string, number> = { TR: 11, RO: 8, UA: 8, RU: 8, KZ: 6, UZ: 6, AE: 7, IT: 6 };

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function seedAssets(client: ClientBase): Promise<void> {
  const tx = wrapClient(client);
  const base = config.consolidationCurrency;

  const branches = await tx.many<{ id: string; code: string; currency: string }>(
    'SELECT id, code, currency FROM branches ORDER BY code',
  );
  const today = new Date();
  let created = 0;

  for (const branch of branches) {
    const count = BRANCH_ITEMS[branch.code] ?? 5;
    const existing = await tx.one('SELECT 1 FROM assets WHERE branch_id = $1 LIMIT 1', [branch.id]);
    if (existing) continue;

    const supervisor = await tx.one<{ id: string }>(
      `SELECT id FROM users WHERE branch_id = $1 AND role IN ('supervisor', 'finance_controller')
       ORDER BY role LIMIT 1`,
      [branch.id],
    );
    const head = await tx.one<{ head_user_id: string | null; city: string }>(
      'SELECT head_user_id, city FROM branches WHERE id = $1',
      [branch.id],
    );

    for (const [i, item] of CATALOGUE.slice(0, count).entries()) {
      const acquired = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - item.monthsAgo, 10));
      // Convert the catalogue price into the branch currency with the rate of that date.
      const rate = await tx.one<{ rate: string | null }>('SELECT fx_rate_on($1, $2, $3::date) AS rate', [
        branch.currency, base, iso(acquired),
      ]);
      const cost = Math.round(item.costEur / Number(rate?.rate || 1) * 100) / 100;

      await tx.exec(
        `INSERT INTO assets (branch_id, inventory_no, name, category, status, serial_no, location,
                             responsible_user_id, acquisition_date, acquisition_cost, currency, method,
                             useful_life_months, salvage_value, created_by)
         VALUES ($1, $2, $3, $4::asset_category, 'in_use', $5, $6, $7, $8::date, $9, $10,
                 CASE WHEN $11::int IS NULL THEN 'none'::depreciation_method ELSE 'straight_line'::depreciation_method END,
                 $11, $12, $13)
         ON CONFLICT (branch_id, inventory_no) DO NOTHING`,
        [
          branch.id,
          `${branch.code}-${String(i + 1).padStart(3, '0')}`,
          item.name,
          item.category,
          item.serial ? `SN-${branch.code}-${1000 + i * 7}` : null,
          `${head?.city ?? ''} — ${item.category === 'vehicles' ? 'fleet' : 'office'}`,
          supervisor?.id ?? head?.head_user_id ?? null,
          iso(acquired),
          cost,
          branch.currency,
          item.life,
          // Vehicles keep a residual value; the rest depreciate to zero.
          item.category === 'vehicles' ? Math.round(cost * 0.1 * 100) / 100 : 0,
          supervisor?.id ?? null,
        ],
      );
      created++;
    }
  }

  if (created) console.log(`assets: ${created} items created`);
}

/**
 * Charges depreciation month by month up to the current month, exactly as the API endpoint
 * does, so the demo has a full history instead of one lump sum.
 */
export async function seedDepreciation(client: ClientBase, months = 24): Promise<void> {
  const tx = wrapClient(client);
  const base = config.consolidationCurrency;
  const admin = await tx.one<{ id: string }>(`SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1`);
  if (!admin) return;

  const already = await tx.one('SELECT 1 FROM asset_depreciation LIMIT 1');
  if (already) return;

  const today = new Date();
  let posted = 0;

  for (let back = months; back >= 0; back--) {
    const period = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 1));
    const target = iso(period);

    const assets = await tx.many<{
      id: string; branch_id: string; inventory_no: string; name: string; category: string;
      currency: string; cost: string; salvage: string; accumulated: string; life: number; acquired: string;
    }>(
      `SELECT id, branch_id, inventory_no, name, category, currency, acquisition_cost AS cost,
              salvage_value AS salvage, accumulated, useful_life_months AS life,
              to_char(acquisition_date, 'YYYY-MM-DD') AS acquired
       FROM assets
       WHERE method = 'straight_line' AND status IN ('in_use', 'in_repair', 'idle')
         AND acquisition_date < $1::date
         AND (depreciated_through IS NULL OR depreciated_through < $1::date)`,
      [target],
    );

    for (const a of assets) {
      const cost = Number(a.cost);
      const depreciable = cost - Number(a.salvage);
      const remaining = depreciable - Number(a.accumulated);
      if (remaining <= 0.009 || !a.life) continue;
      const monthly = Math.round((depreciable / a.life) * 100) / 100;
      const amount = Math.min(monthly, Math.round(remaining * 100) / 100);
      const accumulated = Math.round((Number(a.accumulated) + amount) * 100) / 100;

      const rate = await tx.one<{ rate: string | null }>('SELECT fx_rate_on($1, $2, $3::date) AS rate', [
        a.currency, base, target,
      ]);
      const fx = Number(rate?.rate || 1);
      const amountBase = Math.round(amount * fx * 100) / 100;

      await tx.exec(
        `INSERT INTO asset_depreciation (asset_id, period, amount, currency, amount_base, accumulated, created_by)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7) ON CONFLICT (asset_id, period) DO NOTHING`,
        [a.id, target, amount, a.currency, amountBase, accumulated, admin.id],
      );
      await tx.exec('UPDATE assets SET accumulated = $2, depreciated_through = $3::date WHERE id = $1', [
        a.id, accumulated, target,
      ]);
      // Ledger: depreciation expense against accumulated depreciation (no cash movement).
      for (const leg of [
        { account: `expense.depreciation.${a.category}`, group: 'expense', debit: amount, credit: 0 },
        { account: 'asset.accumulated_depreciation', group: 'asset', debit: 0, credit: amount },
      ]) {
        const signed = leg.debit - leg.credit;
        await tx.exec(
          `INSERT INTO ledger_entries (branch_id, entry_date, account, account_group, debit, credit, currency,
              amount_base, base_currency, fx_rate, source_type, source_id, description, created_by)
           VALUES ($1, $2::date, $3, $4::account_group, $5, $6, $7, $8, $9, $10, 'expense', $11, $12, $13)`,
          [a.branch_id, target, leg.account, leg.group, leg.debit, leg.credit, a.currency,
           Math.round(signed * fx * 100) / 100, base, fx, a.id,
           `Depreciation ${target.slice(0, 7)} — ${a.inventory_no} ${a.name}`, admin.id],
        );
      }
      posted++;
    }
  }

  if (posted) console.log(`depreciation: ${posted} monthly charges posted`);
}
