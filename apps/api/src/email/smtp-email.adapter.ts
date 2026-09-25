import { Injectable, Logger } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';
import { config } from '../config';
import { EmailAdapter, EmailMessage } from './email.interface';

/** Any SMTP-speaking provider (SES, SendGrid, Mailgun, a corporate relay) — never one vendor's SDK. */
@Injectable()
export class SmtpEmailAdapter implements EmailAdapter {
  private readonly logger = new Logger('Email');
  private readonly transporter: Transporter;

  constructor() {
    this.transporter = createTransport({
      host: config.email.smtp.host,
      port: config.email.smtp.port,
      secure: config.email.smtp.secure,
      auth: config.email.smtp.user ? { user: config.email.smtp.user, pass: config.email.smtp.pass } : undefined,
    });
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      await this.transporter.sendMail({ from: config.email.from, ...message });
    } catch (err) {
      // A failed e-mail must never fail the business action it was a side effect of.
      this.logger.error(`could not send to ${message.to}: ${(err as Error).message}`);
    }
  }
}
