import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser, ClientStatement, ClientStatementEntry } from '@gsi/shared-types';
import { DbService } from '../db/db.service';
import { round2, today } from './invoices.service';
import { config } from '../config';

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * A client's running balance: every invoice issued (debit) and every payment applied
 * (credit), chronological, each converted at its own date's fx rate. Payments come from
 * `payment_allocations`; an invoice with none yet (untouched since before PHASE 8) falls back
 * to its ledger postings, the same rule `InvoicesService.payments()` uses.
 */
@Injectable()
export class ClientStatementService {
  constructor(private readonly db: DbService) {}

  async build(user: AuthUser, clientId: string, from?: string, to?: string): Promise<ClientStatement> {
    const base = config.consolidationCurrency;
    const periodFrom = from ?? defaultFrom();
    const periodTo = to ?? today();

    return this.db.tx(user, async (tx) => {
      const client = await tx.one<{ name: string }>('SELECT name FROM clients WHERE id = $1', [clientId]);
      if (!client) throw new NotFoundException('Client not found');

      const rows = await tx.many<Record<string, unknown>>(
        `SELECT to_char(date, 'YYYY-MM-DD') AS date, kind, reference, currency, debit, credit,
                (debit * fx_rate_on(currency, $2, date))::float8 AS "debitBase",
                (credit * fx_rate_on(currency, $2, date))::float8 AS "creditBase"
         FROM (
           SELECT i.issue_date AS date, 'invoice' AS kind, i.invoice_number AS reference, i.currency,
                  i.amount_total::float8 AS debit, 0::float8 AS credit
           FROM invoices i
           WHERE i.client_id = $1 AND i.deleted_at IS NULL AND i.status NOT IN ('draft', 'cancelled')
           UNION ALL
           SELECT pay.payment_date AS date, 'payment' AS kind,
                  COALESCE(i.invoice_number, pay.reference, 'payment') AS reference, pay.currency,
                  0::float8 AS debit, pa.amount::float8 AS credit
           FROM payment_allocations pa
           JOIN payments pay ON pay.id = pa.payment_id
           JOIN invoices i ON i.id = pa.invoice_id
           WHERE pay.direction = 'inbound' AND i.client_id = $1
           UNION ALL
           SELECT l.entry_date AS date, 'payment' AS kind, i2.invoice_number AS reference, l.currency,
                  0::float8 AS debit, l.debit::float8 AS credit
           FROM ledger_entries l
           JOIN invoices i2 ON i2.id = l.source_id
           WHERE l.source_type = 'payment' AND l.account_group = 'cash' AND l.debit > 0
             AND i2.client_id = $1
             AND NOT EXISTS (SELECT 1 FROM payment_allocations pa2 WHERE pa2.invoice_id = i2.id)
         ) events (date, kind, reference, currency, debit, credit)
         ORDER BY date`,
        [clientId, base],
      );

      const opening = rows.filter((r) => String(r.date) < periodFrom)
        .reduce((s, r) => s + n(r.debitBase) - n(r.creditBase), 0);

      let balance = round2(opening);
      const entries: ClientStatementEntry[] = [];
      for (const r of rows) {
        const date = String(r.date);
        if (date < periodFrom || date > periodTo) continue;
        balance = round2(balance + n(r.debitBase) - n(r.creditBase));
        entries.push({
          date,
          kind: r.kind as 'invoice' | 'payment',
          reference: String(r.reference),
          currency: String(r.currency),
          debit: round2(n(r.debit)),
          credit: round2(n(r.credit)),
          debitBase: round2(n(r.debitBase)),
          creditBase: round2(n(r.creditBase)),
          balanceBase: balance,
        });
      }

      return {
        clientId,
        clientName: client.name,
        baseCurrency: base,
        period: { from: periodFrom, to: periodTo },
        openingBalanceBase: round2(opening),
        closingBalanceBase: balance,
        entries,
      };
    });
  }
}

function defaultFrom(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 11);
  return d.toISOString().slice(0, 10);
}
