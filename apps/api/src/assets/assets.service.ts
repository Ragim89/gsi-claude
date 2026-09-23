import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import {
  Asset,
  AssetCategory,
  AssetDepreciationEntry,
  AssetStatus,
  AuthUser,
  DepreciationMethod,
  DepreciationRunResult,
  HQ_ROLES,
} from '@gsi/shared-types';
import { DbService, Tx } from '../db/db.service';
import { StorageService } from '../storage/storage.service';
import { LedgerService } from '../finance/ledger.service';
import { buildSet } from '../common/sql';
import { config } from '../config';

const ASSET_COLUMNS = `
  a.id, a.branch_id AS "branchId", b.code AS "branchCode", a.inventory_no AS "inventoryNo", a.name,
  a.category, a.status, a.serial_no AS "serialNo", a.location,
  a.responsible_user_id AS "responsibleUserId", u.full_name AS "responsibleName",
  to_char(a.acquisition_date, 'YYYY-MM-DD') AS "acquisitionDate",
  a.acquisition_cost::float8 AS "acquisitionCost", a.currency, a.method,
  a.useful_life_months AS "usefulLifeMonths", a.salvage_value::float8 AS "salvageValue",
  a.accumulated::float8 AS accumulated,
  to_char(a.depreciated_through, 'YYYY-MM-DD') AS "depreciatedThrough",
  (a.acquisition_cost - a.accumulated)::float8 AS "netBookValue",
  ((a.acquisition_cost - a.accumulated) * fx_rate_on(a.currency, $BASE$, current_date))::float8 AS "netBookValueBase",
  (a.acquisition_cost * fx_rate_on(a.currency, $BASE$, a.acquisition_date))::float8 AS "acquisitionCostBase",
  CASE WHEN a.method = 'straight_line' AND a.useful_life_months > 0
       THEN round((a.acquisition_cost - a.salvage_value) / a.useful_life_months, 2)::float8 END AS "monthlyDepreciation",
  CASE WHEN a.method = 'straight_line' AND a.useful_life_months > 0
       THEN GREATEST(0, a.useful_life_months
            - CASE WHEN a.acquisition_cost > a.salvage_value
                   THEN floor(a.accumulated / ((a.acquisition_cost - a.salvage_value) / a.useful_life_months))
                   ELSE a.useful_life_months END)::int END AS "remainingMonths",
  to_char(a.disposed_on, 'YYYY-MM-DD') AS "disposedOn", a.disposal_amount::float8 AS "disposalAmount",
  a.disposal_note AS "disposalNote", a.photo_key AS "photoKey", a.notes, a.created_at AS "createdAt"`;

const ASSET_FROM = `
  assets a
  JOIN branches b ON b.id = a.branch_id
  LEFT JOIN users u ON u.id = a.responsible_user_id`;

export interface AssetFilters {
  branchId?: string;
  category?: AssetCategory;
  status?: AssetStatus;
  search?: string;
  from?: string;
  to?: string;
  responsibleUserId?: string;
}

export interface AssetInput {
  inventoryNo?: string;
  name?: string;
  category?: AssetCategory;
  status?: AssetStatus;
  serialNo?: string | null;
  location?: string | null;
  responsibleUserId?: string | null;
  acquisitionDate?: string;
  acquisitionCost?: number;
  currency?: string;
  method?: DepreciationMethod;
  usefulLifeMonths?: number | null;
  salvageValue?: number;
  notes?: string | null;
  branchId?: string;
}

const ALLOWED_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp']);
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);

/**
 * Company assets and their depreciation (offices, vehicles, laboratory and inspection
 * equipment, IT). Monthly depreciation is posted to the ledger like any other cost, so it
 * flows into the P&L, the expense analytics and the group dashboard automatically.
 */
@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);
  private readonly base = config.consolidationCurrency;

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly ledger: LedgerService,
  ) {}

  private columns(): string {
    // fx_rate_on needs the consolidation currency as a literal inside the column list.
    return ASSET_COLUMNS.split('$BASE$').join(`'${this.base}'`);
  }

  list(user: AuthUser, f: AssetFilters): Promise<Asset[]> {
    return this.db.tx(user, async (tx) => {
      const rows = await tx.many<Asset & { photoKey: string | null }>(
        `SELECT ${this.columns()} FROM ${ASSET_FROM}
         WHERE ($1::uuid IS NULL OR a.branch_id = $1::uuid)
           AND ($2::asset_category IS NULL OR a.category = $2::asset_category)
           AND ($3::asset_status IS NULL OR a.status = $3::asset_status)
           AND ($4::text IS NULL OR a.name ILIKE '%' || $4 || '%' OR a.inventory_no ILIKE '%' || $4 || '%'
                OR a.serial_no ILIKE '%' || $4 || '%' OR a.location ILIKE '%' || $4 || '%')
           AND ($5::date IS NULL OR a.acquisition_date >= $5::date)
           AND ($6::date IS NULL OR a.acquisition_date <= $6::date)
           AND ($7::uuid IS NULL OR a.responsible_user_id = $7::uuid)
         ORDER BY a.acquisition_date DESC, a.inventory_no
         LIMIT 500`,
        [f.branchId ?? null, f.category ?? null, f.status ?? null, f.search?.trim() || null,
         f.from ?? null, f.to ?? null, f.responsibleUserId ?? null],
      );
      return Promise.all(rows.map((r) => this.sign(r)));
    });
  }

  get(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const asset = await this.load(tx, id);
      const history = await tx.many<AssetDepreciationEntry>(
        `SELECT id, asset_id AS "assetId", to_char(period, 'YYYY-MM-DD') AS period,
                amount::float8 AS amount, currency, amount_base::float8 AS "amountBase",
                accumulated::float8 AS accumulated, created_at AS "createdAt"
         FROM asset_depreciation WHERE asset_id = $1 ORDER BY period DESC LIMIT 60`,
        [id],
      );
      return { ...asset, history };
    });
  }

  create(user: AuthUser, input: AssetInput) {
    const { inventoryNo, name, acquisitionDate, acquisitionCost } = input;
    if (!name || !inventoryNo || !acquisitionDate || acquisitionCost == null) {
      throw new BadRequestException('inventoryNo, name, acquisitionDate and acquisitionCost are required');
    }
    const branchId = HQ_ROLES.includes(user.role) && input.branchId ? input.branchId : user.branchId;
    return this.db.tx(user, async (tx) => {
      const branch = await tx.one<{ currency: string }>('SELECT currency FROM branches WHERE id = $1', [branchId]);
      if (!branch) throw new NotFoundException('Branch not found');
      const row = await tx.one<{ id: string }>(
        `INSERT INTO assets (branch_id, inventory_no, name, category, status, serial_no, location,
                             responsible_user_id, acquisition_date, acquisition_cost, currency, method,
                             useful_life_months, salvage_value, notes, created_by)
         VALUES ($1, $2, $3, COALESCE($4::asset_category, 'other'), COALESCE($5::asset_status, 'in_use'),
                 $6, $7, $8, $9::date, $10, COALESCE($11, $12), COALESCE($13::depreciation_method, 'straight_line'),
                 $14, COALESCE($15, 0), $16, $17)
         RETURNING id`,
        [branchId, inventoryNo.trim(), name.trim(), input.category ?? null, input.status ?? null,
         input.serialNo ?? null, input.location ?? null, input.responsibleUserId ?? null, acquisitionDate,
         acquisitionCost, input.currency ?? null, branch.currency, input.method ?? null,
         input.usefulLifeMonths ?? null, input.salvageValue ?? null, input.notes ?? null, user.id],
      );
      return this.load(tx, row!.id);
    });
  }

  update(user: AuthUser, id: string, input: AssetInput) {
    const { sql, params } = buildSet(input as Record<string, unknown>, {
      inventoryNo: 'inventory_no',
      name: 'name',
      category: 'category',
      status: 'status',
      serialNo: 'serial_no',
      location: 'location',
      responsibleUserId: 'responsible_user_id',
      acquisitionDate: 'acquisition_date',
      acquisitionCost: 'acquisition_cost',
      method: 'method',
      usefulLifeMonths: 'useful_life_months',
      salvageValue: 'salvage_value',
      notes: 'notes',
    }, 2);
    if (!sql) throw new BadRequestException('Nothing to update');
    return this.db.tx(user, async (tx) => {
      const n = await tx.exec(`UPDATE assets SET ${sql} WHERE id = $1`, [id, ...params]);
      if (!n) throw new NotFoundException('Asset not found');
      return this.load(tx, id);
    });
  }

  /** Sale or write-off: stops depreciation and records the outcome. */
  dispose(user: AuthUser, id: string, input: { disposedOn?: string; amount?: number | null; note?: string | null; writeOff?: boolean }) {
    return this.db.tx(user, async (tx) => {
      const asset = await this.load(tx, id);
      if (asset.status === 'disposed' || asset.status === 'written_off') {
        throw new ConflictException('Asset is already disposed');
      }
      const on = input.disposedOn ?? new Date().toISOString().slice(0, 10);
      await tx.exec(
        `UPDATE assets SET status = $2::asset_status, disposed_on = $3::date, disposal_amount = $4, disposal_note = $5
         WHERE id = $1`,
        [id, input.writeOff ? 'written_off' : 'disposed', on, input.amount ?? null, input.note ?? null],
      );
      // ASSUMPTION: proceeds from a sale are recorded as cash against the asset; the gain or
      // loss on disposal is left to the accounting integration rather than guessed here.
      if (input.amount && input.amount > 0) {
        await this.ledger.post(tx, user, {
          branchId: asset.branchId,
          currency: asset.currency,
          date: on,
          sourceType: 'expense',
          sourceId: id,
          description: `Disposal of ${asset.inventoryNo} ${asset.name}`,
          legs: [
            { account: 'cash.bank', group: 'cash', debit: input.amount },
            { account: 'asset.fixed', group: 'asset', credit: input.amount },
          ],
        });
      }
      return this.load(tx, id);
    });
  }

  remove(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const used = await tx.one('SELECT 1 FROM asset_depreciation WHERE asset_id = $1 LIMIT 1', [id]);
      if (used) throw new ConflictException('Asset has depreciation history; dispose of it instead');
      const n = await tx.exec('DELETE FROM assets WHERE id = $1', [id]);
      if (!n) throw new NotFoundException('Asset not found');
    });
  }

  async uploadPhoto(user: AuthUser, id: string, file: Express.Multer.File) {
    if (!file) throw new BadRequestException('File is required');
    if (!ALLOWED_IMAGE.has(file.mimetype)) throw new BadRequestException(`Unsupported file type ${file.mimetype}`);
    const jpeg = await sharp(file.buffer).rotate().resize(1200, 900, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    return this.db.tx(user, async (tx) => {
      const asset = await tx.one<{ branch_code: string; old: string | null }>(
        `SELECT b.code AS branch_code, a.photo_key AS old FROM assets a JOIN branches b ON b.id = a.branch_id WHERE a.id = $1`,
        [id],
      );
      if (!asset) throw new NotFoundException('Asset not found');
      const key = `branches/${asset.branch_code}/assets/${id}-${randomUUID()}.jpg`;
      await this.storage.put(key, jpeg, 'image/jpeg', { 'uploaded-by': user.id });
      await tx.exec('UPDATE assets SET photo_key = $2 WHERE id = $1', [id, key]);
      if (asset.old) await this.storage.delete(asset.old).catch(() => undefined);
      return this.load(tx, id);
    });
  }

  /**
   * Monthly depreciation run (docs/03: every financial event goes straight to the ledger).
   *
   * Straight line: (cost − salvage) ÷ useful life, charged from the month after acquisition
   * until the net book value reaches the salvage value. Idempotent per asset and month —
   * a repeat run for the same period changes nothing.
   */
  runDepreciation(user: AuthUser, period?: string): Promise<DepreciationRunResult> {
    const target = period ? `${period.slice(0, 7)}-01` : monthStart(new Date());
    return this.db.tx(user, async (tx) => {
      const assets = await tx.many<{
        id: string; branch_id: string; inventory_no: string; name: string; currency: string;
        cost: string; salvage: string; accumulated: string; life: number; acquired: string;
        depreciated_through: string | null; category: AssetCategory;
      }>(
        `SELECT id, branch_id, inventory_no, name, currency, acquisition_cost AS cost, salvage_value AS salvage,
                accumulated, useful_life_months AS life, to_char(acquisition_date, 'YYYY-MM-DD') AS acquired,
                to_char(depreciated_through, 'YYYY-MM-DD') AS depreciated_through, category
         FROM assets
         WHERE method = 'straight_line' AND status IN ('in_use', 'in_repair', 'idle')
           AND acquisition_date < date_trunc('month', $1::date) + interval '1 month'
           AND (depreciated_through IS NULL OR depreciated_through < $1::date)
         ORDER BY branch_id, inventory_no
         FOR UPDATE`,
        [target],
      );

      let processed = 0;
      let skipped = 0;
      let totalBase = 0;

      for (const a of assets) {
        const cost = Number(a.cost);
        const salvage = Number(a.salvage);
        const accumulated = Number(a.accumulated);
        const depreciable = cost - salvage;
        const remaining = depreciable - accumulated;
        if (remaining <= 0.009 || !a.life) {
          skipped++;
          continue;
        }
        // Depreciation starts the month after the asset is put into use.
        if (a.acquired.slice(0, 7) >= target.slice(0, 7)) {
          skipped++;
          continue;
        }
        const monthly = Math.round((depreciable / a.life) * 100) / 100;
        const amount = Math.min(monthly, Math.round(remaining * 100) / 100);
        const newAccumulated = Math.round((accumulated + amount) * 100) / 100;

        const rate = await tx.one<{ rate: string | null }>('SELECT fx_rate_on($1, $2, $3::date) AS rate', [
          a.currency, this.base, target,
        ]);
        const amountBase = Math.round(amount * Number(rate?.rate ?? 1) * 100) / 100;

        await tx.exec(
          `INSERT INTO asset_depreciation (asset_id, period, amount, currency, amount_base, accumulated, created_by)
           VALUES ($1, $2::date, $3, $4, $5, $6, $7)
           ON CONFLICT (asset_id, period) DO NOTHING`,
          [a.id, target, amount, a.currency, amountBase, newAccumulated, user.id],
        );
        await tx.exec(
          `UPDATE assets SET accumulated = $2, depreciated_through = $3::date WHERE id = $1`,
          [a.id, newAccumulated, target],
        );
        await this.ledger.post(tx, user, {
          branchId: a.branch_id,
          currency: a.currency,
          date: target,
          sourceType: 'expense',
          sourceId: a.id,
          description: `Depreciation ${target.slice(0, 7)} — ${a.inventory_no} ${a.name}`,
          legs: [
            { account: `expense.depreciation.${a.category}`, group: 'expense', debit: amount },
            { account: 'asset.accumulated_depreciation', group: 'asset', credit: amount },
          ],
        });
        processed++;
        totalBase += amountBase;
      }

      this.logger.log(`depreciation ${target}: ${processed} assets, ${totalBase.toFixed(2)} ${this.base}`);
      return { period: target, assetsProcessed: processed, totalBase: Math.round(totalBase * 100) / 100, skipped };
    });
  }

  private async load(tx: Tx, id: string): Promise<Asset> {
    const row = await tx.one<Asset & { photoKey: string | null }>(
      `SELECT ${this.columns()} FROM ${ASSET_FROM} WHERE a.id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('Asset not found');
    return this.sign(row);
  }

  private async sign(row: Asset & { photoKey: string | null }): Promise<Asset> {
    const { photoKey, ...asset } = row;
    return { ...asset, photoUrl: photoKey ? await this.storage.presignGet(photoKey) : null };
  }
}
