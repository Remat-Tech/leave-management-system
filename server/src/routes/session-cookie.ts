/**
 * The one thing a browser is trusted to hand back: which employee it is. LMS 401.
 *
 * The first credential this system issues. `SignInService` has proved who somebody is
 * since LMS 109 and has deliberately issued nothing — "it returns who signed in rather
 * than issuing anything, because there is no HTTP layer to set one on" — and
 * SESSION_SECRET has sat in `.env` unread since LMS 004 with a comment saying what it is
 * waiting for. Phase 4 is the first story with a browser in it, so this is where that
 * stops.
 *
 * ## What is in it, and what is emphatically not
 *
 * **An employee id, when it was issued, and a signature over both.** Nothing else. In
 * particular **no roles**, and that is the instruction `SignedIn.actor` gives in as many
 * words: "a route layer must derive its own from whatever it uses to identify a request
 * rather than taking one over the wire — the whole point of this object is that it is the
 * *answer* to 'who is this', never the evidence for it."
 *
 * A signed cookie carrying `HR_ADMIN` would not be forgeable, so the objection is not
 * about forgery. It is that a role revoked this morning would go on working until its
 * holder happened to sign in again, and the evidence would be in the hand of the person
 * it is being used against. Reading the roles per request costs two small queries and
 * makes closing an account something the *next* request cannot survive — which is
 * strictly better than the snapshot the README's "what is not built" describes, and it is
 * what ./identify.ts does.
 *
 * ## Signed, not encrypted, and the difference matters
 *
 * An employee id is not a secret — it is on every screen a manager opens — so there is
 * nothing here to hide. What has to be impossible is *changing* it, which is a MAC rather
 * than a cipher. HMAC-SHA256 over `id.issuedAt`, compared with `timingSafeEqual` so that
 * a wrong signature takes the same time as a right one whatever is wrong about it.
 *
 * The issued-at is inside the signed payload rather than beside it, and that is the whole
 * of why an expiry cannot be pushed back by editing the cookie. A timestamp outside the
 * MAC is a session that never ends.
 *
 * ## What this is not, stated rather than hidden
 *
 * **There is no server side session, so there is no revocation list.** A cookie is good
 * until it expires, and signing out clears the browser's copy rather than invalidating
 * it. That is the honest limit of a stateless credential and it is bounded two ways:
 * {@link SESSION_HOURS} is short, and ./identify.ts re-reads the account and the
 * employment status on every single request — so the cases that actually matter, an
 * account closed or somebody terminated, are shut off at once whatever the cookie says.
 * What survives is a stolen cookie for the rest of its life, and the answer to that is a
 * session table, which is a story with a migration in it.
 *
 * **There is no CSRF token.** `SameSite=Strict` stands in for one, which is why it is
 * Strict rather than the more usual Lax: Lax lets a top level GET carry the cookie, and a
 * GET that only reads is safe today without that being a property future routes are
 * obliged to keep. The day this application needs a cross-site flow, it needs a token in
 * the same change.
 *
 * **There is no rate limit in front of it.** The README says that is outstanding and it
 * still is; this file does not close it.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** The name on the cookie. */
export const SESSION_COOKIE = 'lms_session';

/**
 * How long a signed-in browser stays signed in. Eight hours, which is a working day.
 *
 * Short, because nothing can revoke one early; see the module note. A constant rather
 * than a setting because a session length nobody has to justify is one that grows — the
 * day it should be configurable it can be, with an argument attached.
 */
export const SESSION_HOURS = 8;

/** Why a presented session is not usable. Told apart for a log, never for the browser. */
export type SessionRefusal = 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED';

/**
 * The secret the cookie is signed with, checked rather than defaulted.
 *
 * There is no fallback and there must never be one. A default secret is a system that
 * runs perfectly well in production with a signing key that is in a public repository,
 * and the failure is silent until somebody notices they can mint a cookie for anybody.
 * So a missing or unchanged SESSION_SECRET stops the process at start-up with the command
 * that generates one in the message — which is what `.env.example` already says beside
 * the key, said again where somebody meets it.
 */
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

/**
 * One cookie out of a `Cookie` header, without a parser dependency.
 *
 * Deliberately small: it splits on `;`, takes the first `=`, and does not decode. The
 * only cookie this application reads is one it minted itself out of base64url and digits,
 * which needs no decoding — and a value that has been tampered with fails the signature
 * check a moment later rather than being repaired here.
 */
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

/**
 * Constant time comparison, with a length check in front that deliberately is not one.
 *
 * `timingSafeEqual` throws on buffers of different lengths, so the length is compared
 * first. That leaks the length of a signature which is the same length every time, and
 * leaks nothing about the secret.
 */
function isTheSameSignature(given: string, expected: string): boolean {
  const one = Buffer.from(given);
  const other = Buffer.from(expected);

  return one.length === other.length && timingSafeEqual(one, other);
}
