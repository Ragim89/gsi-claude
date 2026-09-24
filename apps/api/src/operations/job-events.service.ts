import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';
import type { JobAction, JobStatus } from '@gsi/shared-types';

export interface JobEvent {
  type: 'job.status_changed' | 'job.assigned' | 'job.unassigned';
  jobId: string;
  jobNumber: string;
  branchId: string;
  actorId: string;
  from?: JobStatus;
  to?: JobStatus;
  action?: JobAction;
  userId?: string;
  reason?: string | null;
}

/**
 * The seam notifications will plug into.
 *
 * Phase 10 builds the notification centre; until then this exists so the workflow has
 * somewhere to announce what happened without knowing who listens. An in-process emitter is
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
