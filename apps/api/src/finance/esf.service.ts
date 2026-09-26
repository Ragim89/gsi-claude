import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser, EsfStatus, FiscalSnapshot } from '@gsi/shared-types';
import { DbService } from '../db/db.service';
import { AuditService } from '../common/audit.service';

/**
 * Electronic-invoice (ЭСФ) integration boundary (migration 028, task section 11).
 *
 * This is deliberately a mapping/export helper and a manual status recorder — nothing here
 * calls, or pretends to call, Kazakhstan's ИС ЭСФ (esf.gov.kz) or any other government system.
 * A PDF is never presented as a registered ЭСФ unless `esfStatus` says `registered` and that
 * value was set here because an operator entered what the real system returned.
 */
@Injectable()
export class EsfService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** What an operator needs to key (or, later, an official integration to submit) into ИС ЭСФ. */
  async exportPayload(user: AuthUser, invoiceId: string) {
    return this.db.tx(user, async (tx) => {
      const inv = await tx.one<{
        invoice_number: string; jurisdiction_country_code: string | null; fiscal_snapshot: FiscalSnapshot | null;
        esf_status: EsfStatus; esf_registration_number: string | null;
      }>(
        `SELECT invoice_number, jurisdiction_country_code, fiscal_snapshot, esf_status, esf_registration_number
         FROM invoices WHERE id = $1`,
        [invoiceId],
      );
      if (!inv) throw new NotFoundException('Invoice not found');
      if (!inv.fiscal_snapshot) {
        throw new BadRequestException(
          'This invoice has no fiscal snapshot (legacy or not yet issued) — nothing to export to an e-invoice system',
        );
      }
      const s = inv.fiscal_snapshot;
      return {
        invoiceNumber: inv.invoice_number,
        countryCode: inv.jurisdiction_country_code,
        currentStatus: inv.esf_status,
        registrationNumber: inv.esf_registration_number,
        seller: s.legalEntity,
        buyer: s.buyer,
        supplyDate: s.supplyDate,
        currency: s.documentCurrency,
        taxCode: s.taxCode,
        taxRate: s.taxRate,
        lines: s.lines,
        subtotalNet: s.subtotalNet,
        taxAmount: s.taxAmount,
        grandTotal: s.grandTotal,
        eInvoiceSystem: s.eInvoice.system,
      };
    });
  }

  /** Records what actually happened in the real system. Never transitions on its own. */
  setStatus(user: AuthUser, invoiceId: string, status: EsfStatus, registrationNumber: string | null) {
    return this.db.tx(user, async (tx) => {
      const before = await tx.one<{ esf_status: EsfStatus; invoice_number: string }>(
        'SELECT esf_status, invoice_number FROM invoices WHERE id = $1',
        [invoiceId],
      );
      if (!before) throw new NotFoundException('Invoice not found');

      const timestampColumn =
        status === 'submitted' ? 'esf_submitted_at' : status === 'registered' ? 'esf_registered_at' : null;
      await tx.exec(
        `UPDATE invoices SET esf_status = $2::esf_status, esf_registration_number = $3
                ${timestampColumn ? `, ${timestampColumn} = now()` : ''}
         WHERE id = $1`,
        [invoiceId, status, registrationNumber],
      );
      await this.audit.record(tx, user, {
        action: 'invoice.esf_status',
        entityType: 'invoice',
        entityId: invoiceId,
        entityLabel: before.invoice_number,
        before: { esfStatus: before.esf_status },
        after: { esfStatus: status, registrationNumber },
      });
      return tx.one('SELECT esf_status AS "esfStatus", esf_registration_number AS "esfRegistrationNumber" FROM invoices WHERE id = $1', [
        invoiceId,
      ]);
    });
  }
}
