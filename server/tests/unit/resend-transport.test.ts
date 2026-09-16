import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resendSends } from '../../src/mail/resend-transport.js';

/**
 * Mail over HTTPS. NFR SEC 01.
 *
 * Against a stubbed `fetch`, so this stays a unit test and never sends anything. What is
 * proved here is the shape of the request and the two rules the SMTP transport also keeps:
 * the override redirects, and the intended recipient is kept rather than discarded.
 */

const KEY = 'a-resend-api-key-for-a-test';

let calls: { url: string; body: Record<string, unknown>; authorization: string }[];

beforeEach(() => {
  calls = [];

  process.env.MAIL_FROM_NAME = 'Remat Holdings Leave';
  process.env.MAIL_FROM_ADDRESS = 'leave@rematholdings.com';
  delete process.env.MAIL_OVERRIDE_RECIPIENT;

  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      authorization: (init.headers as Record<string, string>).authorization,
    });

    return Promise.resolve(
      new Response(JSON.stringify({ id: 'a-message-id' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MAIL_OVERRIDE_RECIPIENT;
});

const aMessage = {
  to: 'adwoa.frimpong@rematholdings.com',
  subject: '123456 is your code',
  text: 'Your sign in code is 123456.',
};

describe('sending over HTTPS', () => {
  it('posts the message to Resend, with the key in the header rather than the body', async () => {
    const sent = await resendSends(KEY)(aMessage);

    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].body.to).toEqual(['adwoa.frimpong@rematholdings.com']);
    expect(calls[0].body.subject).toBe('123456 is your code');
    expect(calls[0].body.from).toBe('"Remat Holdings Leave" <leave@rematholdings.com>');
    expect(sent).toEqual({
      messageId: 'a-message-id',
      deliveredTo: 'adwoa.frimpong@rematholdings.com',
      redirected: false,
    });
  });

  it('says what Resend said when it refuses, because the reason is the fix', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('{"message":"The domain is not verified"}', { status: 403 })),
    );

    await expect(resendSends(KEY)(aMessage)).rejects.toThrow(/not verified/);
  });
});

describe('the override', () => {
  beforeEach(() => {
    process.env.MAIL_OVERRIDE_RECIPIENT = 'somebody.testing@rematholdings.com';
  });

  it('sends everything to one address instead of the real recipient', async () => {
    const sent = await resendSends(KEY)(aMessage);

    expect(calls[0].body.to).toEqual(['somebody.testing@rematholdings.com']);
    expect(sent.redirected).toBe(true);
  });

  it('keeps who it was for, so a redirected mailbox still says whose it was', async () => {
    await resendSends(KEY)(aMessage);

    expect(calls[0].body.headers).toEqual({
      'X-Intended-Recipient': 'adwoa.frimpong@rematholdings.com',
    });
  });
});
