export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Provider-neutral seam: RemindersService and the notification centre depend on this, never on a vendor SDK. */
export interface EmailAdapter {
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_ADAPTER = Symbol('EMAIL_ADAPTER');
