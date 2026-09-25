import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import type { JobAction } from '@gsi/shared-types';

/** Which record moved. Defaults to 'job' — the type this bus started with, before other workflows reused it. */
export type DomainEntityType = 'job' | 'sample' | 'test_request' | 'report';

export interface JobEvent {
  type: 'job.status_changed' | 'job.assigned' | 'job.unassigned';
  entityType?: DomainEntityType;
  jobId: string;
  jobNumber: string;
  branchId: string;
  actorId: string;
  from?: string;
  to?: string;
  action?: JobAction | string;
  userId?: string;
  reason?: string | null;
}

/**
 * The seam PHASE 10's notification centre plugs into (`notifications/notification-events.listener.ts`).
 *
 * Despite the name this bus now carries status changes for jobs, samples, test requests and
 * reports alike — job-workflow, sample-workflow, lab-workflow and report-workflow all emit
 * through the one instance rather than each inventing its own. An in-process emitter is
 * deliberate — a message broker for a monolith that does not need one yet would be a cost
 * with no payer.
 */
@Injectable()
export class JobEventsService {
  private readonly logger = new Logger(JobEventsService.name);
  private readonly emitter = new EventEmitter();

  emit(event: JobEvent): void {
    this.logger.log(
      `${event.type} ${event.jobNumber}` +
        (event.from ? ` ${event.from} → ${event.to}` : '') +
        (event.userId ? ` user=${event.userId}` : ''),
    );
    // A listener must never break the transaction that produced the event.
    try {
      this.emitter.emit(event.type, event);
      this.emitter.emit('*', event);
    } catch (err) {
      this.logger.warn(`job event listener failed: ${(err as Error).message}`);
    }
  }

  on(type: JobEvent['type'] | '*', listener: (event: JobEvent) => void): () => void {
    this.emitter.on(type, listener);
    return () => this.emitter.off(type, listener);
  }
}
