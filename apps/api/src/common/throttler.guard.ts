import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { config } from '../config';

/**
 * Rate limiting with two adjustments to the default behaviour:
 *
 * - it can be switched off entirely (only the test suite does that, so throttling does not
 *   make tests flaky);
 * - authenticated callers are counted per user, not per IP, so a whole office behind one
 *   NAT address does not share a single budget while an attacker still gets their own.
 */
@Injectable()
export class GsiThrottlerGuard extends ThrottlerGuard {
  protected async shouldSkip(): Promise<boolean> {
    return config.rateLimit.disabled;
  }

  protected async getTracker(req: Request & { user?: { id: string } }): Promise<string> {
    return req.user?.id ?? req.ip ?? 'unknown';
  }

  /** The default message is the exception's class name; this one tells the person what to do. */
  protected async throwThrottlingException(_ctx: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    const seconds = Math.max(1, Math.ceil(detail.timeToBlockExpire || config.rateLimit.windowSeconds));
    throw new HttpException(
      `Too many requests. Please wait ${seconds} seconds and try again.`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
