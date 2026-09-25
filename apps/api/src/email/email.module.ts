import { Module } from '@nestjs/common';
import { config } from '../config';
import { EMAIL_ADAPTER } from './email.interface';
import { ConsoleEmailAdapter } from './console-email.adapter';
import { SmtpEmailAdapter } from './smtp-email.adapter';

/** PHASE 10 — one provider-neutral seam; which adapter backs it is an environment variable, not a code change. */
@Module({
  providers: [
    {
      provide: EMAIL_ADAPTER,
      useClass: config.email.provider === 'smtp' ? SmtpEmailAdapter : ConsoleEmailAdapter,
    },
  ],
  exports: [EMAIL_ADAPTER],
})
export class EmailModule {}
