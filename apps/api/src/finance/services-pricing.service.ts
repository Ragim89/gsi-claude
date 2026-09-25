import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser, Price, Service } from '@gsi/shared-types';
import { DbService } from '../db/db.service';

export interface CreateServiceInput {
  code: string;
  name: Record<string, string>;
  serviceType?: string | null;
  unit?: string;
  sortOrder?: number;
}

export interface CreatePriceInput {
  serviceId: string;
  branchId: string;
  contractId?: string | null;
  clientId?: string | null;
  currency: string;
  unitPrice: number;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  notes?: string | null;
}

/** The service catalogue and its prices (PHASE 8), resolved contract → client → branch default. */
@Injectable()
export class ServicesPricingService {
  constructor(private readonly db: DbService) {}

  listServices(user: AuthUser, activeOnly = true) {
    return this.db.tx(user, (tx) =>
      tx.many<Service>(
        `SELECT id, code, name, service_type AS "serviceType", unit, is_active AS "isActive", sort_order AS "sortOrder"
         FROM services WHERE ($1::boolean IS FALSE OR is_active) ORDER BY sort_order, code`,
        [activeOnly],
      ),
    );
  }

  createService(user: AuthUser, input: CreateServiceInput) {
    return this.db.tx(user, (tx) =>
      tx.one<Service>(
        `INSERT INTO services (code, name, service_type, unit, sort_order)
         VALUES ($1, $2::jsonb, $3::service_type, $4, $5)
         RETURNING id, code, name, service_type AS "serviceType", unit, is_active AS "isActive", sort_order AS "sortOrder"`,
        [input.code, JSON.stringify(input.name), input.serviceType ?? null, input.unit ?? 'unit', input.sortOrder ?? 100],
      ),
    );
  }

  updateService(user: AuthUser, id: string, input: Partial<CreateServiceInput> & { isActive?: boolean }) {
    return this.db.tx(user, async (tx) => {
      const row = await tx.one<Service>(
        `UPDATE services SET
           code = COALESCE($2, code), name = COALESCE($3::jsonb, name),
           service_type = COALESCE($4::service_type, service_type), unit = COALESCE($5, unit),
           sort_order = COALESCE($6, sort_order), is_active = COALESCE($7, is_active)
         WHERE id = $1
         RETURNING id, code, name, service_type AS "serviceType", unit, is_active AS "isActive", sort_order AS "sortOrder"`,
        [id, input.code ?? null, input.name ? JSON.stringify(input.name) : null, input.serviceType ?? null,
         input.unit ?? null, input.sortOrder ?? null, input.isActive ?? null],
      );
      if (!row) throw new NotFoundException('Service not found');
      return row;
    });
  }

  listPrices(user: AuthUser, f: { serviceId?: string; branchId?: string; clientId?: string }) {
    return this.db.tx(user, (tx) =>
      tx.many<Price>(
        `SELECT p.id, p.branch_id AS "branchId", p.service_id AS "serviceId", s.code AS "serviceCode", s.name AS "serviceName",
                p.contract_id AS "contractId", co.contract_no AS "contractNo", p.client_id AS "clientId", c.name AS "clientName",
                p.currency, p.unit_price::float8 AS "unitPrice", to_char(p.effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
                to_char(p.effective_to, 'YYYY-MM-DD') AS "effectiveTo", p.is_active AS "isActive", p.notes
         FROM prices p
         JOIN services s ON s.id = p.service_id
         LEFT JOIN contracts co ON co.id = p.contract_id
         LEFT JOIN clients c ON c.id = p.client_id
         WHERE ($1::uuid IS NULL OR p.service_id = $1::uuid)
           AND ($2::uuid IS NULL OR p.branch_id = $2::uuid)
           AND ($3::uuid IS NULL OR p.client_id = $3::uuid)
         ORDER BY s.sort_order, p.effective_from DESC
         LIMIT 500`,
        [f.serviceId ?? null, f.branchId ?? null, f.clientId ?? null],
      ),
    );
  }

  createPrice(user: AuthUser, input: CreatePriceInput) {
    return this.db.tx(user, (tx) =>
      tx.one<Price>(
        `INSERT INTO prices (branch_id, service_id, contract_id, client_id, currency, unit_price,
                             effective_from, effective_to, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::date, current_date), $8::date, $9, $10)
         RETURNING id, branch_id AS "branchId", service_id AS "serviceId", contract_id AS "contractId",
                   client_id AS "clientId", currency, unit_price::float8 AS "unitPrice",
                   to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
                   to_char(effective_to, 'YYYY-MM-DD') AS "effectiveTo", is_active AS "isActive", notes`,
        [input.branchId, input.serviceId, input.contractId ?? null, input.clientId ?? null, input.currency,
         input.unitPrice, input.effectiveFrom ?? null, input.effectiveTo ?? null, input.notes ?? null, user.id],
      ),
    );
  }

  deactivatePrice(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const n = await tx.exec('UPDATE prices SET is_active = false WHERE id = $1', [id]);
      if (n === 0) throw new NotFoundException('Price not found');
    });
  }

  /** The price that applies right now, for pre-filling a quote line. */
  resolve(user: AuthUser, serviceId: string, branchId: string, clientId?: string, contractId?: string, onDate?: string) {
    return this.db.tx(user, async (tx) => {
      const row = await tx.one<{ id: string }>(
        `SELECT app_resolve_price($1, $2, $3, $4, COALESCE($5::date, current_date)) AS id`,
        [serviceId, branchId, clientId ?? null, contractId ?? null, onDate ?? null],
      );
      if (!row?.id) return null;
      const price = await tx.one<Price>(
        `SELECT id, branch_id AS "branchId", service_id AS "serviceId", currency, unit_price::float8 AS "unitPrice",
                to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom", to_char(effective_to, 'YYYY-MM-DD') AS "effectiveTo",
                is_active AS "isActive", notes
         FROM prices WHERE id = $1`,
        [row.id],
      );
      return price;
    });
  }
}
