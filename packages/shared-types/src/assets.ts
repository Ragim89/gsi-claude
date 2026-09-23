import type { BreakdownSlice } from './finance';
import type { Timestamp } from './entities';

export const ASSET_CATEGORIES = [
  'real_estate',
  'vehicles',
  'lab_equipment',
  'inspection_equipment',
  'it_equipment',
  'furniture',
  'intangible',
  'other',
] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export const ASSET_STATUSES = ['in_use', 'in_repair', 'idle', 'disposed', 'written_off'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const DEPRECIATION_METHODS = ['straight_line', 'none'] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

/** A fixed asset: office, vehicle, laboratory or inspection equipment, IT, furniture. */
export interface Asset {
  id: string;
  branchId: string;
  branchCode?: string;
  inventoryNo: string;
  name: string;
  category: AssetCategory;
  status: AssetStatus;
  serialNo: string | null;
  location: string | null;
  responsibleUserId: string | null;
  responsibleName?: string | null;
  acquisitionDate: string;
  acquisitionCost: number;
  currency: string;
  method: DepreciationMethod;
  usefulLifeMonths: number | null;
  salvageValue: number;
  accumulated: number;
  depreciatedThrough: string | null;
  /** acquisitionCost − accumulated, in the asset's own currency. */
  netBookValue?: number;
  /** Net book value converted to the consolidation currency. */
  netBookValueBase?: number;
  acquisitionCostBase?: number;
  /** Monthly charge under the current parameters. */
  monthlyDepreciation?: number;
  /** Months of useful life left. */
  remainingMonths?: number | null;
  disposedOn: string | null;
  disposalAmount: number | null;
  disposalNote: string | null;
  photoUrl?: string | null;
  notes: string | null;
  createdAt: Timestamp;
}

export interface AssetDepreciationEntry {
  id: string;
  assetId: string;
  period: string;
  amount: number;
  currency: string;
  amountBase: number;
  accumulated: number;
  createdAt: Timestamp;
}

export interface AssetSummary {
  baseCurrency: string;
  totals: {
    count: number;
    inUse: number;
    acquisitionCostBase: number;
    accumulatedBase: number;
    netBookValueBase: number;
    /** Depreciation charged in the selected period. */
    periodDepreciationBase: number;
    monthlyDepreciationBase: number;
    fullyDepreciated: number;
    disposed: number;
  };
  byCategory: (BreakdownSlice & { count: number; netBookValueBase: number })[];
  byBranch: (BreakdownSlice & { branchId: string; code: string; country: string; count: number })[];
  /** Net book value at the end of each month, plus the charge of that month. */
  monthly: { month: string; depreciationBase: number; netBookValueBase: number }[];
  /** Assets whose useful life ends within the next 6 months. */
  endingSoon: { id: string; inventoryNo: string; name: string; remainingMonths: number; netBookValueBase: number }[];
}

export interface DepreciationRunResult {
  period: string;
  assetsProcessed: number;
  totalBase: number;
  skipped: number;
}
