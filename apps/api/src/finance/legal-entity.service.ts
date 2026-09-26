import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser, LegalEntity } from '@gsi/shared-types';
import { DbService } from '../db/db.service';
import { AuditService } from '../common/audit.service';
import { buildSet } from '../common/sql';

const LEGAL_ENTITY_COLUMNS = `
  le.id, le.organization_id AS "organizationId", le.country_id AS "countryId",
  c.code AS "countryCode", c.name AS "countryName",
  le.code, le.legal_name AS "legalName", le.legal_address AS "legalAddress",
  le.fiscal_identifier_type AS "fiscalIdentifierType", le.fiscal_identifier AS "fiscalIdentifier",
  le.vat_registered AS "vatRegistered", le.vat_registration_number AS "vatRegistrationNumber",
  le.default_tax_code AS "defaultTaxCode", le.default_currency AS "defaultCurrency",
  le.bank_name AS "bankName", le.bank_account AS "bankAccount", le.bank_swift AS "bankSwift",
  le.invoice_number_prefix AS "invoiceNumberPrefix", le.e_invoice_status AS "eInvoiceStatus",
  le.is_active AS "isActive", le.created_at AS "createdAt", le.updated_at AS "updatedAt",
  EXISTS (SELECT 1 FROM jurisdiction_profiles p
          WHERE p.country_code = c.code AND p.status = 'verified' AND p.effective_from <= current_date)
    AS "hasVerifiedProfile"`;

const LEGAL_ENTITY_FROM = `legal_entities le JOIN countries c ON c.id = le.country_id`;

export interface LegalEntityInput {
  countryId: string;
  code: string;
  legalName: string;
  legalAddress?: string | null;
  fiscalIdentifierType?: string | null;
  fiscalIdentifier?: string | null;
  vatRegistered?: boolean;
  vatRegistrationNumber?: string | null;
  defaultTaxCode?: string | null;
  /** Optional: when omitted, defaults to the country's verified jurisdiction profile
   *  (defaultDocumentCurrency) — e.g. a Kazakhstan legal entity defaults to KZT without the
   *  caller having to know that. A country with no verified profile has no default to fall
   *  back to, so it must be supplied explicitly there. */
  defaultCurrency?: string;
  bankName?: string | null;
  bankAccount?: string | null;
  bankSwift?: string | null;
  invoiceNumberPrefix?: string | null;
}

export type LegalEntityUpdateInput = Partial<LegalEntityInput> & { isActive?: boolean };

/**
 * CRUD for the fiscal identity an office trades under (migration 028). Deliberately not
 * branch-scoped by Row-Level Security the way jobs/invoices are: a legal entity can serve
 * several offices in a country, so visibility is gated by the `finance.read` permission and
 * mutation by `legal_entity.manage` (HQ/Admin only) — enforced by the RLS policies in the
 * migration, not re-implemented here.
 */
@Injectable()
export class LegalEntityService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  list(user: AuthUser, opts: { includeInactive?: boolean; countryId?: string } = {}) {
    return this.db.tx(user, (tx) =>
      tx.many<LegalEntity>(
        `SELECT ${LEGAL_ENTITY_COLUMNS} FROM ${LEGAL_ENTITY_FROM}
         WHERE ($1::boolean OR le.is_active) AND ($2::uuid IS NULL OR le.country_id = $2::uuid)
         ORDER BY c.code, le.code`,
        [opts.includeInactive ?? false, opts.countryId ?? null],
      ),
    );
  }

  get(user: AuthUser, id: string) {
    return this.db.tx(user, async (tx) => {
      const row = await tx.one<LegalEntity>(`SELECT ${LEGAL_ENTITY_COLUMNS} FROM ${LEGAL_ENTITY_FROM} WHERE le.id = $1`, [id]);
      if (!row) throw new NotFoundException('Legal entity not found');
      return row;
    });
  }

  create(user: AuthUser, input: LegalEntityInput) {
    return this.db.tx(user, async (tx) => {
      const org = await tx.one<{ id: string }>('SELECT id FROM organizations ORDER BY code LIMIT 1');
      if (!org) throw new NotFoundException('Organization not found');
      const country = await tx.one<{ id: string; code: string }>('SELECT id, code FROM countries WHERE id = $1', [input.countryId]);
      if (!country) throw new BadRequestException('Unknown country');

      let defaultCurrency = input.defaultCurrency?.toUpperCase();
      if (!defaultCurrency) {
        const profile = await tx.one<{ default_document_currency: string }>(
          `SELECT default_document_currency FROM jurisdiction_profiles
           WHERE country_code = $1 AND status = 'verified' AND effective_from <= current_date
           ORDER BY effective_from DESC LIMIT 1`,
          [country.code],
        );
        if (!profile) {
          throw new BadRequestException(
            `${country.code} has no verified jurisdiction profile to default a currency from — pass defaultCurrency explicitly`,
          );
        }
        defaultCurrency = profile.default_document_currency;
      }

      const row = await tx.one<{ id: string }>(
        `INSERT INTO legal_entities
           (organization_id, country_id, code, legal_name, legal_address, fiscal_identifier_type,
            fiscal_identifier, vat_registered, vat_registration_number, default_tax_code,
            default_currency, bank_name, bank_account, bank_swift, invoice_number_prefix, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id`,
        [
          org.id, input.countryId, input.code.trim(), input.legalName.trim(), input.legalAddress ?? null,
          input.fiscalIdentifierType ?? null, input.fiscalIdentifier ?? null, input.vatRegistered ?? false,
          input.vatRegistrationNumber ?? null, input.defaultTaxCode ?? null, defaultCurrency,
          input.bankName ?? null, input.bankAccount ?? null, input.bankSwift ?? null,
          input.invoiceNumberPrefix ?? null, user.id,
        ],
      );
      const entity = await tx.one<LegalEntity>(`SELECT ${LEGAL_ENTITY_COLUMNS} FROM ${LEGAL_ENTITY_FROM} WHERE le.id = $1`, [row!.id]);
      await this.audit.record(tx, user, {
        action: 'legal_entity.create',
        entityType: 'legal_entity',
        entityId: row!.id,
        entityLabel: entity!.legalName,
        after: {
          countryCode: entity!.countryCode, vatRegistered: entity!.vatRegistered,
          defaultCurrency: entity!.defaultCurrency, fiscalIdentifier: entity!.fiscalIdentifier,
        },
      });
      return entity;
    });
  }

  update(user: AuthUser, id: string, input: LegalEntityUpdateInput) {
    const { sql, params } = buildSet(input as Record<string, unknown>, {
      legalName: 'legal_name',
      legalAddress: 'legal_address',
      fiscalIdentifierType: 'fiscal_identifier_type',
      fiscalIdentifier: 'fiscal_identifier',
      vatRegistered: 'vat_registered',
      vatRegistrationNumber: 'vat_registration_number',
      defaultTaxCode: 'default_tax_code',
      defaultCurrency: 'default_currency',
      bankName: 'bank_name',
      bankAccount: 'bank_account',
      bankSwift: 'bank_swift',
      invoiceNumberPrefix: 'invoice_number_prefix',
      isActive: 'is_active',
    }, 2);
    if (!sql) throw new BadRequestException('Nothing to update');

    return this.db.tx(user, async (tx) => {
      const before = await tx.one<Record<string, unknown>>(
        `SELECT legal_name, legal_address, fiscal_identifier_type, fiscal_identifier, vat_registered,
                vat_registration_number, default_tax_code, default_currency, bank_name, bank_account,
                bank_swift, invoice_number_prefix, is_active
         FROM legal_entities WHERE id = $1`,
        [id],
      );
      if (!before) throw new NotFoundException('Legal entity not found');
      await tx.exec(`UPDATE legal_entities SET ${sql} WHERE id = $1`, [id, ...params]);
      const after = await tx.one<Record<string, unknown>>(
        `SELECT legal_name, legal_address, fiscal_identifier_type, fiscal_identifier, vat_registered,
                vat_registration_number, default_tax_code, default_currency, bank_name, bank_account,
                bank_swift, invoice_number_prefix, is_active
         FROM legal_entities WHERE id = $1`,
        [id],
      );
      const changed = AuditService.diff(before, after);
      const entity = await tx.one<LegalEntity>(`SELECT ${LEGAL_ENTITY_COLUMNS} FROM ${LEGAL_ENTITY_FROM} WHERE le.id = $1`, [id]);
      await this.audit.record(tx, user, {
        action: 'legal_entity.update',
        entityType: 'legal_entity',
        entityId: id,
        entityLabel: entity!.legalName,
        before: changed?.before,
        after: changed?.after,
      });
      return entity;
    });
  }
}
