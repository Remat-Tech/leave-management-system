import type { Mailer } from '../../src/mail/mailer.js';
import type { Mail, SentMail } from '../../src/mail/transport.js';

/**
 * A {@link Mailer} that keeps what it was given and opens no socket.
 *
 * Most of what is worth testing about an email is in what it said and where it
 * went, and a suite that can only ask a live SMTP server whether *something* was
 * sent checks the least interesting half. This keeps the messages so a test can
 * read them.
 *
 * The real transport is covered end to end in ../integration/mail.test.ts, which
 * is where the nodemailer wiring, the Mailpit round trip and the override
 * recipient belong. Nothing here proves that mail leaves the building; it proves
 * what the application asked to be sent.
 */
export interface RecordingMailer extends Mailer {
  readonly sent: Mail[];
  /** The most recent message, which is what a test almost always wants. */
  last(): Mail;
  clear(): void;
  /** Makes the next send throw, for the paths that have to survive one. */
  failNext(error?: Error): void;
}

export function recordingMailer(): RecordingMailer {
  const sent: Mail[] = [];
  let failure: Error | undefined;

  return {
    sent,

    async send(mail: Mail): Promise<SentMail> {
      if (failure !== undefined) {
        const thrown = failure;
        failure = undefined;
        throw thrown;
      }

      sent.push(mail);
      return { messageId: `test-${sent.length}`, deliveredTo: mail.to, redirected: false };
    },

    close(): void {},

    last(): Mail {
      const mail = sent[sent.length - 1];
      if (mail === undefined) {
        throw new Error('No mail was sent.');
      }
      return mail;
    },

    clear(): void {
      sent.length = 0;
      failure = undefined;
    },

    failNext(error = new Error('SMTP is not answering.')): void {
      failure = error;
    },
  };
}
