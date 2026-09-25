import { Injectable, Logger } from '@nestjs/common';
import { EmailAdapter, EmailMessage } from './email.interface';

/** The default adapter: no outbound network call, so a fresh checkout can never mail a real client by accident. */
@Injectable()
export class ConsoleEmailAdapter implements EmailAdapter {
  private readonly logger = new Logger('Email');

  async send(message: EmailMessage): Promise<void> {
    this.logger.log(`(console adapter, not sent) to=${message.to} subject="${message.subject}"`);
  }
}
