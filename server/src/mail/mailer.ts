/** Sending mail, as one thing a service can be handed. */

import type { Transporter } from 'nodemailer';
import { resendSends } from './resend-transport.js';
import { createTransport, type Mail, type SentMail, sendMail } from './transport.js';

export interface Mailer {
  send(mail: Mail): Promise<SentMail>;
  /** Releases whatever is held open. */
  close(): void;
}

/**
 * The real one, over whichever transport the environment offers.
 *
 * `RESEND_API_KEY` sends over HTTPS, which is what production uses: a host that blocks
 * outbound SMTP leaves the connection hanging, and a sign in code that never arrives locks
 * out everybody who needs one. Without it, SMTP — which is Mailpit in development and every
 * existing test.
 *
 * Chosen here rather than asked about anywhere else, as the storage and scanner drivers are.
 */
export function createMailer(): Mailer {
  const apiKey = process.env.RESEND_API_KEY;

  if (apiKey) {
    const send = resendSends(apiKey);

    return {
      send,
      /* Nothing is held open: each message is one request. */
      close(): void {},
    };
  }

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
