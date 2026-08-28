import type { Transporter } from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeEmail } from '../../src/auth/mfa.js';
import { createTransport, sendMail } from '../../src/mail/transport.js';

/**
 * Proves the development mail path end to end: the application sends, Mailpit
 * catches, and nothing leaves the machine.
 */
const MAILPIT_API = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
  From: { Address: string };
}

async function messagesFor(subject: string): Promise<MailpitMessage[]> {
  const response = await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(subject)}`);
  if (!response.ok) throw new Error(`Mailpit search failed: ${response.status}`);

  const body = (await response.json()) as { messages: MailpitMessage[] };
  return body.messages;
}

let transport: Transporter;

beforeAll(async () => {
  const reachable = await fetch(`${MAILPIT_API}/api/v1/info`).catch(() => null);
  if (!reachable?.ok) {
    throw new Error(
      `Mailpit is not answering at ${MAILPIT_API}. Start it with "npm run mail" ` +
        'and run this again.',
    );
  }

  transport = createTransport();
});

afterAll(() => {
  transport?.close();
});

describe('outbound mail in development', () => {
  it('is captured by Mailpit rather than delivered', async () => {
    // Unique per run, so a Mailpit left running for days stays usable.
    const subject = `Leave request submitted ${crypto.randomUUID()}`;

    const sent = await sendMail(transport, {
      to: 'ama.mensah@rematholdings.com',
      subject,
      text: 'Kofi Boateng has requested 5 days of annual leave.',
    });

    expect(sent.messageId).toBeTruthy();
    expect(sent.redirected).toBe(false);

    const [caught] = await messagesFor(subject);

    expect(caught).toBeDefined();
    expect(caught.Subject).toBe(subject);
    expect(caught.To[0].Address).toBe('ama.mensah@rematholdings.com');
    expect(caught.From.Address).toBe(process.env.MAIL_FROM_ADDRESS);
  });

  it('sends everything to one address when MAIL_OVERRIDE_RECIPIENT is set', async () => {
    const previous = process.env.MAIL_OVERRIDE_RECIPIENT;
    process.env.MAIL_OVERRIDE_RECIPIENT = 'safety-net@rematholdings.com';

    try {
      const subject = `Leave request approved ${crypto.randomUUID()}`;

      const sent = await sendMail(transport, {
        to: 'someone.real@rematholdings.com',
        subject,
        text: 'This must not reach the real recipient.',
      });

      expect(sent.redirected).toBe(true);
      expect(sent.deliveredTo).toBe('safety-net@rematholdings.com');

      const [caught] = await messagesFor(subject);

      expect(caught).toBeDefined();
      expect(caught.To[0].Address).toBe('safety-net@rematholdings.com');
    } finally {
      if (previous === undefined) {
        delete process.env.MAIL_OVERRIDE_RECIPIENT;
      } else {
        process.env.MAIL_OVERRIDE_RECIPIENT = previous;
      }
    }
  });
});

describe('the sign in code', () => {
  /**
   * NFR SEC 01, LMS 110, and the one acceptance criterion that is not really
   * about the database: the code has to actually leave the application and reach
   * the company address.
   *
   * ./mfa.test.ts covers everything else about codes against a recording mailer,
   * which is faster and can read what a message said. What it cannot prove is
   * that the message goes anywhere, because nothing in it opens a socket. This
   * is the one test that does, and it lives here because this file already owns
   * the Mailpit dependency and the guard that explains it.
   */
  it('reaches the company mailbox with the code in it', async () => {
    const code = '042317';
    const mail = codeEmail('ama.mensah@rematholdings.com', code, 10);

    // Unique per run, so a Mailpit left running for days stays usable. The real
    // subject is asserted below.
    const marker = crypto.randomUUID();
    const sent = await sendMail(transport, { ...mail, subject: `${mail.subject} ${marker}` });

    expect(sent.redirected).toBe(false);
    expect(sent.deliveredTo).toBe('ama.mensah@rematholdings.com');

    const [caught] = await messagesFor(marker);

    expect(caught).toBeDefined();
    expect(caught.To[0].Address).toBe('ama.mensah@rematholdings.com');
    // In the subject, which is where a phone shows it.
    expect(caught.Subject).toContain(code);
  });
});
