import { Injectable, Logger } from '@nestjs/common';
import type { AccountGroup, AuthUser } from '@gsi/shared-types';
import type { Tx } from '../db/db.service';
import { config } from '../config';

export interface PostingLeg {
  account: string;
  group: AccountGroup;
  debit?: number;
  credit?: number;
}

export interface Posting {
  branchId: string;
  currency: string;
  date: string;
  sourceType: 'invoice' | 'payment' | 'expense';
  sourceId: string;
  description: string;
  legs: PostingLeg[];
}

/**
 * Double-entry postings behind every financial event (docs/03, §"Техническая механика" p.1).
 * Each leg is converted to the consolidation currency with the fx rate of the posting date
 * and stored alongside the branch-currency amount. An AFTER INSERT trigger updates the
 * incremental dashboard aggregate and emits a NOTIFY for the live dashboard.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);
  readonly baseCurrency = config.consolidationCurrency;

  async post(tx: Tx, user: AuthUser, p: Posting): Promise<void> {
    const balance = p.legs.reduce((sum, l) => sum + (l.debit ?? 0) - (l.credit ?? 0), 0);
    if (Math.abs(balance) > 0.01) {
      throw new Error(`Unbalanced posting for ${p.sourceType} ${p.sourceId}: ${balance}`);
    }

    const rateRow = await tx.one<{ rate: string | null }>('SELECT fx_rate_on($1, $2, $3::date) AS rate', [
      p.currency,
      this.baseCurrency,
      p.date,
    ]);
    // ASSUMPTION: if no rate is on file for that date yet, the posting still happens at 1:1
    // and is flagged in the log — bookkeeping must never be blocked by missing reference data.
    const rate = rateRow?.rate ? Number(rateRow.rate) : null;
    if (rate === null) {
      this.logger.warn(`No ${p.currency}→${this.baseCurrency} rate on ${p.date}; posting at 1.0`);
    }
    const fx = rate ?? 1;

    for (const leg of p.legs) {
      const signedLocal = (leg.debit ?? 0) - (leg.credit ?? 0);
      await tx.exec(
        `INSERT INTO ledger_entries (branch_id, entry_date, account, account_group, debit, credit,
                                     currency, amount_base, base_currency, fx_rate, source_type,
                                     source_id, description, created_by)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [p.branchId, p.date, leg.account, leg.group, leg.debit ?? 0, leg.credit ?? 0, p.currency,
         Number((signedLocal * fx).toFixed(2)), this.baseCurrency, fx, p.sourceType, p.sourceId,
         p.description, user.id],
      );
    }
  }

  /** Reverses the postings of a source document (used when an invoice is cancelled). */
  async reverse(tx: Tx, user: AuthUser, sourceType: string, sourceId: string, date: string): Promise<void> {
    await tx.exec(
      `INSERT INTO ledger_entries (branch_id, entry_date, account, account_group, debit, credit,
                                   currency, amount_base, base_currency, fx_rate, source_type,
                                   source_id, description, created_by)
       SELECT branch_id, $3::date, account, account_group, credit, debit, currency,
              -amount_base, base_currency, fx_rate, source_type, source_id,
              'Reversal: ' || COALESCE(description, ''), $4
       FROM ledger_entries
       WHERE source_type = $1 AND source_id = $2 AND description NOT LIKE 'Reversal:%'`,
      [sourceType, sourceId, date, user.id],
    );
  }
}
