/**
 * The one thing a browser is trusted to hand back: which employee it is. LMS 401, LMS 109, LMS 004.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** The name on the cookie. */
export const SESSION_COOKIE = 'lms_session';

/** How long a signed-in browser stays signed in. */
export const SESSION_HOURS = 8;

/** Why a presented session is not usable. */
export type SessionRefusal = 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED';

/** The secret the cookie is signed with, checked rather than defaulted. */
export function sessionSecretFrom(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.SESSION_SECRET?.trim() ?? '';

  if (secret === '' || secret === 'replace_me_with_a_long_random_string') {
    throw new Error(
      'SESSION_SECRET is not set. Sessions are signed with it, and a default one would ' +
        'let anybody mint a cookie for anybody. Generate one with `openssl rand -base64 ' +
        '32` and put it in .env. See .env.example.',
    );
  }

  if (secret.length < 32) {
    throw new Error(
      `SESSION_SECRET is ${String(secret.length)} characters. It signs every session in ` +
        'the system; use at least 32. Generate one with `openssl rand -base64 32`.',
    );
  }

  return secret;
}

/**
 * Mints a cookie value for somebody who has just proved who they are.
 *
 * `issuedAt` is a parameter rather than a clock read here, for the reason every date in
 * `/domain` is passed in: a function with a clock in it is one whose answer depends on
 * when it was asked, and this one has to be testable at both ends of its own expiry.
 */
export function mintSession(
  employeeId: string,
  secret: string,
  issuedAt: Date = new Date(),
): string {
  const payload = `${employeeId}.${String(issuedAt.getTime())}`;

  return `${payload}.${signatureOf(payload, secret)}`;
}

/**
 * Who a cookie says this is, or why it says nothing usable.
 *
 * The three refusals are told apart for the operator reading a log — rubbish from a
 * client, somebody trying it on or a secret that has been rotated, and the ordinary end
 * of a working day. They are **not** told apart to the browser, which gets one 401
 * whichever it was: which of them it is is not a stranger's business.
 */
export function whoIsThis(
  value: string,
  secret: string,
  now: Date = new Date(),
): { employeeId: string } | { refused: SessionRefusal } {
  const parts = value.split('.');

  if (parts.length !== 3) {
    return { refused: 'MALFORMED' };
  }

  const [employeeId, issuedAt, signature] = parts as [string, string, string];

  if (employeeId === '' || !/^\d+$/.test(issuedAt)) {
    return { refused: 'MALFORMED' };
  }

  /* The signature before the timestamp is believed for anything. It is inside the signed
     payload, so an unverified one is a number somebody chose. */
  if (!isTheSameSignature(signature, signatureOf(`${employeeId}.${issuedAt}`, secret))) {
    return { refused: 'BAD_SIGNATURE' };
  }

  if (now.getTime() - Number(issuedAt) >= SESSION_HOURS * 60 * 60 * 1000) {
    return { refused: 'EXPIRED' };
  }

  return { employeeId };
}

/**
 * The `Set-Cookie` attributes, in one place so no route can set half of them.
 *
 * **HttpOnly**, so a script on the page cannot read it — the one attribute that turns a
 * cross-site scripting bug from a defacement into an account takeover.
 *
 * **SameSite=Strict**, standing in for a CSRF token; see the module note.
 *
 * **Secure in production and not in development**, because a browser will not store a
 * Secure cookie from `http://localhost` and a developer whose sign in silently does
 * nothing has an afternoon to lose. Read from NODE_ENV rather than from the request, so
 * the answer cannot differ between two requests to the same server.
 */
export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: 'strict';
  secure: boolean;
  path: '/';
  maxAge: number;
}

export function sessionCookieOptions(env: NodeJS.ProcessEnv = process.env): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
  };
}

/** One cookie out of a `Cookie` header, without a parser dependency. */
export function cookieFrom(header: string | undefined, name: string): string | undefined {
  if (header === undefined) {
    return undefined;
  }

  for (const pair of header.split(';')) {
    const at = pair.indexOf('=');

    if (at > 0 && pair.slice(0, at).trim() === name) {
      return pair.slice(at + 1).trim();
    }
  }

  return undefined;
}

function signatureOf(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Constant time comparison, with a length check in front that deliberately is not one. */
function isTheSameSignature(given: string, expected: string): boolean {
  const one = Buffer.from(given);
  const other = Buffer.from(expected);

  return one.length === other.length && timingSafeEqual(one, other);
}
