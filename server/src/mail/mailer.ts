/**
 * Sending mail, as one thing a service can be handed.
 *
 * ./transport.ts is the nodemailer wiring: a `Transporter` built from the
 * environment, and a `sendMail` that takes one. That shape is right for the
 * module that owns the connection and wrong for everything above it, which wants
 * to send a message and not to hold a connection open, close it, or know that
 * nodemailer exists.
 *
 * So this is the same arrangement `/storage` has and for the same reason:
 * one interface, one factory that decides what is behind it, and nothing above
 * the line knowing which. A service takes a {@link Mailer}; the application hands
 * it {@link createMailer}; a test hands it something that keeps what it was given
 * in an array and never opens a socket.
 *
 * That last part is not a convenience. The alternative is a test suite that
 * cannot check what an email said without a live SMTP server, which means it
 * checks that one was sent and stops there — and the interesting failures are all
 * in what it said and who it went to.
 */

import type { Transporter } from 'nodemailer';
import { createTransport, type Mail, type SentMail, sendMail } from './transport.js';

export interface Mailer {
  send(mail: Mail): Promise<SentMail>;
  /** Releases whatever is held open. Safe to call on a mailer that holds nothing. */
  close(): void;
}

/**
 * The real one. Builds its transport from the environment on first use.
 *
 * Lazily, so that constructing a service does not open a connection to an SMTP
 * server that a process may never send anything through — and so that a missing
 * SMTP_HOST is an error when something tries to send rather than when something
 * is wired up.
 */
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
