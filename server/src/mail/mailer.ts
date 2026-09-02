/** Sending mail, as one thing a service can be handed. */

import type { Transporter } from 'nodemailer';
import { createTransport, type Mail, type SentMail, sendMail } from './transport.js';

export interface Mailer {
  send(mail: Mail): Promise<SentMail>;
  /** Releases whatever is held open. */
  close(): void;
}

/** The real one. */
export function createMailer(): Mailer {
  let transport: Transporter | undefined;

  return {
    async send(mail: Mail): Promise<SentMail> {
      transport ??= createTransport();
      return sendMail(transport, mail);
    },
    close(): void {
      transport?.close();
      transport = undefined;
    },
  };
}
