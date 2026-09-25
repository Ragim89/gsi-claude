import type { LocalizedText } from './checklist-templates';
import type { ServiceType } from './enums';

/**
 * What can be sold, and what it costs.
 *
 * `Service` is a catalogue, not branch-scoped, same shape as Commodity/Port. `Price` resolves
 * contract → client → branch default — the same order already proven for laboratory
 * specifications (see `test_specifications`/`app_resolve_specification`).
 */

export interface Service {
  id: string;
  code: string;
  name: LocalizedText;
  serviceType: ServiceType | null;
  unit: string;
  isActive: boolean;
  sortOrder: number;
}

export interface Price {
  id: string;
  branchId: string;
  serviceId: string;
  serviceCode?: string;
  serviceName?: LocalizedText;
  contractId: string | null;
  contractNo?: string | null;
  clientId: string | null;
  clientName?: string | null;
  currency: string;
  unitPrice: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  notes: string | null;
}
