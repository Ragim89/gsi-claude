import type { LocalizedText } from './checklist-templates';

export const COMMODITY_GROUPS = [
  'cereals',
  'pulses',
  'oilseeds',
  'vegetable_oils',
  'meals_cakes',
  'fertilizers',
  'other',
] as const;
export type CommodityGroup = (typeof COMMODITY_GROUPS)[number];

/** A culture / cargo the company inspects and analyses (wheat, lentils, peas, flax…). */
export interface Commodity {
  id: string;
  code: string;
  group: CommodityGroup;
  name: LocalizedText;
  hsCode: string | null;
  /** Laboratory methods usually run for this commodity. */
  labMethods: string[];
  isActive: boolean;
  sortOrder: number;
  /** Number of jobs referencing it — only present on the reference screens. */
  jobCount?: number;
}

/** A port, terminal or elevator where inspections take place. */
export interface Port {
  id: string;
  code: string;
  name: string;
  country: string;
  isInland: boolean;
  isActive: boolean;
  jobCount?: number;
}

/** Inclusive date range used by every list and dashboard filter. */
export interface DateRange {
  from?: string;
  to?: string;
}
