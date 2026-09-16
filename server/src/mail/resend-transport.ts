/**
 * Mail over HTTPS, through Resend's API. NFR SEC 01.
 *
 * SMTP is the ordinary way to send and it is the way that does not work everywhere: a managed
 * host that blocks outbound 25, 465 and 587 leaves a connection hanging rather than refusing
 * it, so the first anybody hears of it is a sign in that takes a minute and then fails. Port
 * 443 is the one port every host lets out.
 *
 * Same interface as the SMTP transport and the same override rule, so nothing above `Mailer`
 * knows which one is running — and development keeps Mailpit, which speaks SMTP and nothing
 * else.
 */

import { fromAddress, type Mail, type SentMail } from './transport.js';

const ENDPOINT = 'https://api.resend.com/emails';

/** How long to wait before deciding the send is not going to happen. */
const TIMEOUT_MS = 15_000;

export function resendSends(apiKey: string): (mail: Mail) => Promise<SentMail> {
  return async (mail: Mail): Promise<SentMail> => {
    const override = process.env.MAIL_OVERRIDE_RECIPIENT;
    const deliveredTo = override || mail.to;

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress(),
        to: [deliveredTo],
        subject: mail.subject,
        text: mail.text,
        ...(mail.html === undefined ? {} : { html: mail.html }),
        /* The intended recipient is kept rather than thrown away, as the SMTP transport keeps
           it, so a mailbox full of redirected mail can still say who each was for. */
        ...(override === undefined ? {} : { headers: { 'X-Intended-Recipient': mail.to } }),
      }),
      /* A hung send is worse than a failed one: it holds the request open and the person
         waiting sees a minute of nothing. This is the whole reason for this transport. */
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      /* Resend says what was wrong — an unverified sending domain, usually — and that sentence
         is worth more in the log than the status on its own. */
      const said = await response.text().catch(() => '');

      throw new Error(`Resend refused the message (${String(response.status)}). ${said}`.trim());
    }

    const { id } = (await response.json()) as { id?: string };

    return {
      messageId: id ?? 'sent',
      deliveredTo,
      redirected: Boolean(override),
    };
  };
}
