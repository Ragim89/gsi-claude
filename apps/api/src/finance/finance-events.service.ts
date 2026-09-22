import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Client } from 'pg';
import { Observable, Subject } from 'rxjs';
import type { FinanceEvent } from '@gsi/shared-types';
import { config } from '../config';

/**
 * Live feed for the finance dashboard (docs/03: событийная модель, не polling).
 *
 * The ledger trigger emits `NOTIFY gsi_finance` inside the same transaction that writes the
 * posting, so any API instance listening here learns about it the moment it commits, and
 * pushes it to browsers over SSE. The client refreshes the affected figures.
 *
 * ASSUMPTION: SSE is used instead of Socket.IO — the dashboard feed is one-directional and
 * SSE needs no extra dependency or protocol upgrade through nginx. Socket.IO can replace it
 * when the mobile app needs two-way channels (docs/05 allows either).
 */
@Injectable()
export class FinanceEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FinanceEventsService.name);
  private readonly subject = new Subject<FinanceEvent>();
  private client?: Client;
  private stopping = false;

  async onModuleInit() {
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopping) return;
    try {
      // A dedicated connection: LISTEN cannot share the pooled request connections.
      this.client = new Client({ connectionString: config.databaseUrl });
      this.client.on('error', (err) => this.reconnect(err));
      await this.client.connect();
      await this.client.query('LISTEN gsi_finance');
      this.client.on('notification', (msg) => {
        if (!msg.payload) return;
        try {
          this.subject.next(JSON.parse(msg.payload) as FinanceEvent);
        } catch (err) {
          this.logger.warn(`bad notification payload: ${(err as Error).message}`);
        }
      });
      this.logger.log('listening for finance events');
    } catch (err) {
      this.reconnect(err as Error);
    }
  }

  private reconnect(err: Error) {
    if (this.stopping) return;
    this.logger.warn(`finance listener lost (${err.message}); reconnecting in 5s`);
    this.client?.end().catch(() => undefined);
    this.client = undefined;
    setTimeout(() => this.connect(), 5000).unref?.();
  }

  /** Events for a branch, or all branches for HQ users. */
  stream(branchId: string | null): Observable<FinanceEvent> {
    return new Observable<FinanceEvent>((subscriber) => {
      const sub = this.subject.subscribe((e) => {
        if (!branchId || e.branchId === branchId) subscriber.next(e);
      });
      return () => sub.unsubscribe();
    });
  }

  async onModuleDestroy() {
    this.stopping = true;
    await this.client?.end().catch(() => undefined);
    this.subject.complete();
  }
}
