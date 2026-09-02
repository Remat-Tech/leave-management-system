import { describe, expect, it } from 'vitest';
import {
  cookieFrom,
  mintSession,
  SESSION_COOKIE,
  SESSION_HOURS,
  sessionCookieOptions,
  sessionSecretFrom,
  whoIsThis,
} from '../../src/routes/session-cookie.js';

/**
 * The session cookie. LMS 401.
 *
 * The first credential this system issues, and the only part of the route layer that is
 * pure enough to test without a socket. ../integration/balances-api.test.ts proves it
 * works over HTTP; this proves the arithmetic underneath, which is where a mistake would
 * be both silent and total.
 *
 * Four claims, and the first two are the ones that matter:
 *
 *   **A cookie cannot be edited.** Not the employee id, which would be somebody reading
 *   anybody's balances, and not the timestamp, which would be a session that never ends.
 *   Both are inside the MAC, which is the whole design.
 *
 *   **It runs out.** Eight hours, checked against a clock passed in rather than read, so
 *   that both sides of the boundary can be asserted rather than one of them being taken
 *   on trust.
 *
 *   **There is no default secret.** A default signing key is a system that runs perfectly
 *   well in production while anybody can mint a cookie for anybody, and the failure is
 *   silent until somebody notices. It has to be a refusal at start-up.
 *
 *   **The attributes are the ones a browser needs.** `HttpOnly` and `SameSite=Strict` are
 *   standing in for a script-proof store and a CSRF token respectively, and both are one
 *   word away from being neither.
 */

const SECRET = 'a-test-signing-secret-of-at-least-32-chars';

describe('who a cookie says this is', () => {
  it('reads back the employee it was minted for', () => {
    expect(whoIsThis(mintSession('7', SECRET), SECRET)).toEqual({ employeeId: '7' });
  });

  /* The point of the signature. Without it the cookie is a text field naming whose
     balances to show. */
  it('refuses one whose employee id has been edited', () => {
    const forged = mintSession('7', SECRET).replace('7.', '11.');

    expect(whoIsThis(forged, SECRET)).toEqual({ refused: 'BAD_SIGNATURE' });
  });

  it('refuses one signed with a different secret', () => {
    const elsewhere = mintSession('7', 'a-completely-different-secret-32-chars-long');

    expect(whoIsThis(elsewhere, SECRET)).toEqual({ refused: 'BAD_SIGNATURE' });
  });

  /**
   * The timestamp is inside the signed payload, and this is why.
   *
   * Outside it, extending a session would be editing a number — which is to say there
   * would be no expiry at all, only a suggestion of one.
   */
  it('and refuses one whose issued-at has been pushed back', () => {
    const cookie = mintSession('7', SECRET, new Date('2026-09-02T08:00:00Z'));
    const [employeeId, , signature] = cookie.split('.');
    const later = `${employeeId}.${String(Date.now())}.${signature}`;

    expect(whoIsThis(later, SECRET)).toEqual({ refused: 'BAD_SIGNATURE' });
  });

  it('refuses something that is not a cookie of this shape at all', () => {
    for (const rubbish of ['', 'nonsense', 'a.b', 'a.b.c.d', '.100.sig', '7.notanumber.sig']) {
      expect(whoIsThis(rubbish, SECRET)).toHaveProperty('refused');
    }
  });
});

describe('when a session runs out', () => {
  const issued = new Date('2026-09-02T08:00:00Z');
  const cookie = mintSession('7', SECRET, issued);

  function at(hours: number): Date {
    return new Date(issued.getTime() + hours * 60 * 60 * 1000);
  }

  it('is good up to the last minute of its life', () => {
    expect(whoIsThis(cookie, SECRET, at(SESSION_HOURS - 0.01))).toEqual({ employeeId: '7' });
  });

  /* Exactly eight hours is expired rather than valid — the comparison is `>=`, so the
     boundary belongs to the refusal. A session that is good *at* its expiry is a session
     whose expiry is off by one, and this is the assertion that pins which side it is. */
  it('and is expired at exactly its expiry, not a moment after', () => {
    expect(whoIsThis(cookie, SECRET, at(SESSION_HOURS))).toEqual({ refused: 'EXPIRED' });
  });

  it('and stays expired afterwards', () => {
    expect(whoIsThis(cookie, SECRET, at(SESSION_HOURS + 100))).toEqual({ refused: 'EXPIRED' });
  });

  /* Told apart from a bad signature in the return value and deliberately not to the
     browser, which gets one 401 either way. An operator reading a log needs to know
     whether a secret was rotated or a working day ended; a stranger does not. */
  it('and says which of the three it was, for a log rather than for a browser', () => {
    expect(whoIsThis('rubbish', SECRET)).toEqual({ refused: 'MALFORMED' });
    expect(whoIsThis(mintSession('7', 'another-secret-of-at-least-32-characters'), SECRET)).toEqual(
      { refused: 'BAD_SIGNATURE' },
    );
  });
});

describe('the secret', () => {
  it('is accepted when it is long enough', () => {
    expect(sessionSecretFrom({ SESSION_SECRET: SECRET })).toBe(SECRET);
  });

  /**
   * No fallback, ever.
   *
   * The failure a default would produce is the worst shape a failure can have: everything
   * works, nothing complains, and the signing key is in a public repository. So it is a
   * refusal at start-up, and the message carries the command that fixes it.
   */
  it('and refused when it is missing', () => {
    expect(() => sessionSecretFrom({})).toThrow(/SESSION_SECRET is not set/);
    expect(() => sessionSecretFrom({ SESSION_SECRET: '   ' })).toThrow(/SESSION_SECRET is not set/);
  });

  /* The placeholder in `.env.example`, refused by name — because the way this actually
     goes wrong is somebody copying the example and filling in the database line. */
  it('and refused when it is still the one from .env.example', () => {
    expect(() =>
      sessionSecretFrom({ SESSION_SECRET: 'replace_me_with_a_long_random_string' }),
    ).toThrow(/openssl rand/);
  });

  it('and refused when it is too short to be worth signing with', () => {
    expect(() => sessionSecretFrom({ SESSION_SECRET: 'short' })).toThrow(/at least 32/);
  });
});

describe('the attributes a browser is given', () => {
  /* HttpOnly is the one that turns a cross-site scripting bug from a defacement into an
     account takeover, and SameSite=Strict is standing in for a CSRF token. Neither is a
     preference. */
  it('are HttpOnly and SameSite=Strict, always', () => {
    for (const environment of ['development', 'production', undefined]) {
      const options = sessionCookieOptions({ NODE_ENV: environment });

      expect(options.httpOnly).toBe(true);
      expect(options.sameSite).toBe('strict');
      expect(options.path).toBe('/');
    }
  });

  /**
   * Secure in production and not in development, and the development half is not
   * laziness.
   *
   * A browser will not store a `Secure` cookie from `http://localhost`, so signing in
   * would appear to succeed and then do nothing at all — which is an afternoon lost to a
   * bug that reports itself as "the login does not work".
   */
  it('and Secure in production, and not from http://localhost', () => {
    expect(sessionCookieOptions({ NODE_ENV: 'production' }).secure).toBe(true);
    expect(sessionCookieOptions({ NODE_ENV: 'development' }).secure).toBe(false);
    expect(sessionCookieOptions({}).secure).toBe(false);
  });

  it('and last as long as the session does', () => {
    expect(sessionCookieOptions({}).maxAge).toBe(SESSION_HOURS * 60 * 60 * 1000);
  });
});

describe('reading one cookie out of a header', () => {
  it('finds it wherever it is among the others', () => {
    expect(cookieFrom(`${SESSION_COOKIE}=abc`, SESSION_COOKIE)).toBe('abc');
    expect(cookieFrom(`other=1; ${SESSION_COOKIE}=abc; third=3`, SESSION_COOKIE)).toBe('abc');
    expect(cookieFrom(` ${SESSION_COOKIE}=abc `, SESSION_COOKIE)).toBe('abc');
  });

  it('and answers nothing where there is no header or no such cookie', () => {
    expect(cookieFrom(undefined, SESSION_COOKIE)).toBeUndefined();
    expect(cookieFrom('other=1', SESSION_COOKIE)).toBeUndefined();
    expect(cookieFrom('', SESSION_COOKIE)).toBeUndefined();
  });

  /* A cookie whose name merely ends with ours is a different cookie. Matching on a suffix
     would let anything set `xlms_session` and be read as the session. */
  it('and is not fooled by a name that merely ends with this one', () => {
    expect(cookieFrom(`not_${SESSION_COOKIE}=abc`, SESSION_COOKIE)).toBeUndefined();
  });
});
