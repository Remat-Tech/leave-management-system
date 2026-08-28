import { describe, expect, it } from 'vitest';
import {
  challengeIsLive,
  checkCode,
  CodeIsMandatory,
  CodeRefused,
  codeEmail,
  codeSettings,
  DEFAULT_CODE_LENGTH,
  DEFAULT_TTL_MINUTES,
  expiryFrom,
  generateCode,
  hashCode,
  holdsMandatoryRole,
  isCodeRequired,
  MANDATORY_ROLES,
  MAX_CODE_ATTEMPTS,
} from '../../src/auth/mfa.js';
import type { SignInAccount } from '../../src/auth/sign-in.js';

/**
 * NFR SEC 01, the second factor. LMS 110.
 *
 * The rules, with no database and no mail server. What is worth pinning down
 * here is everything that quietly stops being true: a code that is predictable,
 * a challenge that outlives its expiry, a limit that can be walked past, and a
 * role for which the code has silently become optional.
 */

function account(overrides: Partial<SignInAccount> = {}): SignInAccount {
  return {
    id: '1',
    employeeId: '1',
    companyEmail: 'ama.mensah@rematholdings.com',
    isActive: true,
    mfaEnabled: false,
    lastLoginAt: null,
    createdAt: new Date('2026-01-05T09:00:00Z'),
    updatedAt: new Date('2026-01-05T09:00:00Z'),
    ...overrides,
  };
}

const NOON = new Date('2026-08-27T12:00:00Z');

describe('who has to answer a code', () => {
  it.each([...MANDATORY_ROLES])('requires one of %s whatever their account says', (role) => {
    // These three can read everybody's leave records and the medical
    // certificates attached to them. The story makes it mandatory for exactly
    // them.
    expect(isCodeRequired(account({ mfaEnabled: false }), ['EMPLOYEE', role])).toBe(true);
  });

  it('does not require one of an ordinary employee who has not asked', () => {
    expect(isCodeRequired(account({ mfaEnabled: false }), ['EMPLOYEE'])).toBe(false);
  });

  it('requires one of an ordinary employee who has asked', () => {
    expect(isCodeRequired(account({ mfaEnabled: true }), ['EMPLOYEE'])).toBe(true);
  });

  it('requires one of somebody with no roles at all who has asked', () => {
    // No roles is a real state and means "no mandatory role", never "all of them".
    expect(isCodeRequired(account({ mfaEnabled: true }), [])).toBe(true);
    expect(isCodeRequired(account({ mfaEnabled: false }), [])).toBe(false);
  });

  it('does not treat being a manager as a role', () => {
    /* Being a manager is a relationship, not a role, and MANAGER is deliberately
       not in the role table at all. A manager sees their reports' dates rather
       than their reasons, which is the ordinary employee's exposure. */
    expect(holdsMandatoryRole(['MANAGER'])).toBe(false);
  });

  it.each([
    ['hr_admin', ['hr_admin']],
    ['HR ADMIN', ['HR ADMIN']],
    ['HRADMIN', ['HRADMIN']],
  ])('does not match %s, which is not one of the codes', (_label, codes) => {
    // Matched exactly against the `role` table's codes. A near miss must not
    // quietly make the code mandatory for somebody, nor quietly optional.
    expect(holdsMandatoryRole(codes)).toBe(false);
  });
});

describe('turning it off', () => {
  it('names the roles that stop it, rather than saying no', () => {
    const error = new CodeIsMandatory(['EMPLOYEE', 'HR_ADMIN']);

    expect(error.message).toContain('HR_ADMIN');
    expect(error.message).not.toContain('EMPLOYEE');
    expect(error.roleCodes).toEqual(['HR_ADMIN']);
  });

  it('says what to do instead', () => {
    expect(new CodeIsMandatory(['HR_OFFICER']).message).toMatch(/remove the role/i);
  });
});

describe('the code itself', () => {
  it('is the configured number of digits', () => {
    expect(generateCode(6)).toMatch(/^\d{6}$/);
    expect(generateCode(8)).toMatch(/^\d{8}$/);
  });

  it('keeps leading zeroes, because a code is digits and not a number', () => {
    // 012345 is a perfectly good code and is not twelve thousand three hundred
    // and forty five. One in ten codes starts with a zero.
    const codes = Array.from({ length: 400 }, () => generateCode(DEFAULT_CODE_LENGTH));

    expect(codes.every((code) => code.length === DEFAULT_CODE_LENGTH)).toBe(true);
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
  });

  it('does not repeat itself', () => {
    // Not a test of randomness, which a unit test cannot do. It catches the
    // failure that actually happens: a generator seeded once, or not at all.
    const codes = new Set(Array.from({ length: 200 }, () => generateCode(6)));

    expect(codes.size).toBeGreaterThan(190);
  });

  it('uses every digit', () => {
    const seen = new Set([...Array.from({ length: 300 }, () => generateCode(6)).join('')]);

    expect(seen.size).toBe(10);
  });
});

describe('storing the code', () => {
  it('never stores the code itself', async () => {
    // The story asks for hashed at rest. A copy of app_user taken while people
    // are signing in must not be a list of the codes currently in flight.
    const hash = await hashCode('123456');

    expect(hash).not.toContain('123456');
    expect(hash).toMatch(/^scrypt\$/);
  });

  it('accepts the code that was sent and nothing else', async () => {
    const hash = await hashCode('123456');

    await expect(checkCode('123456', hash)).resolves.toBe(true);
    await expect(checkCode('123457', hash)).resolves.toBe(false);
    await expect(checkCode('', hash)).resolves.toBe(false);
  });

  it('refuses everything when there is no challenge', async () => {
    await expect(checkCode('123456', null)).resolves.toBe(false);
  });
});

describe('whether a challenge is still answerable', () => {
  const live = new Date('2026-08-27T12:10:00Z');

  it('is answerable before it expires', () => {
    expect(challengeIsLive(live, 0, NOON)).toBeNull();
  });

  it('is not answerable when there is none', () => {
    expect(challengeIsLive(null, 0, NOON)).toBe('NO_CHALLENGE');
  });

  it('is not answerable at the instant it expires', () => {
    // A code that expires at the moment it is checked has expired. The other way
    // round is a rule with a hole in it exactly one tick wide.
    expect(challengeIsLive(NOON, 0, NOON)).toBe('EXPIRED');
  });

  it('is not answerable after it expires', () => {
    expect(challengeIsLive(NOON, 0, new Date('2026-08-27T12:00:01Z'))).toBe('EXPIRED');
  });

  it('survives some wrong answers and not more', () => {
    expect(challengeIsLive(live, MAX_CODE_ATTEMPTS - 1, NOON)).toBeNull();
    expect(challengeIsLive(live, MAX_CODE_ATTEMPTS, NOON)).toBe('TOO_MANY_ATTEMPTS');
  });

  it('reports expiry before attempts', () => {
    /* Both are true of an exhausted, expired challenge. Expiry is the one to
       report, because "sign in again" is the same instruction either way and the
       clock is the reason a person will understand. */
    expect(challengeIsLive(NOON, MAX_CODE_ATTEMPTS, NOON)).toBe('EXPIRED');
  });

  it('counts the expiry from now', () => {
    expect(expiryFrom(NOON, 10)).toEqual(new Date('2026-08-27T12:10:00Z'));
  });
});

describe('what a refusal says', () => {
  it.each([
    ['NO_CHALLENGE', /no code waiting/i],
    ['EXPIRED', /expired/i],
    ['TOO_MANY_ATTEMPTS', /too many times/i],
  ] as const)('is specific for %s', (reason, text) => {
    /* Unlike a refused password, these are specific, and it is safe because
       nobody reaches a challenge without having already given the right
       password. There is no stranger left to keep anything from. */
    expect(new CodeRefused(reason).message).toMatch(text);
  });

  it('says how many attempts are left', () => {
    expect(new CodeRefused('WRONG_CODE', 3).message).toContain('3 attempts left');
  });

  it('counts the last one in words rather than as "1 attempts"', () => {
    expect(new CodeRefused('WRONG_CODE', 1).message).toMatch(/one more attempt/i);
  });

  it('tells every refusal apart in the log', () => {
    expect(new CodeRefused('EXPIRED').reason).toBe('EXPIRED');
  });
});

describe('the message the code arrives in', () => {
  const mail = codeEmail('ama.mensah@rematholdings.com', '042317', 10);

  it('goes to the company address', () => {
    expect(mail.to).toBe('ama.mensah@rematholdings.com');
  });

  it('puts the code in the subject, where a phone shows it', () => {
    expect(mail.subject).toContain('042317');
  });

  it('puts it in the body too', () => {
    expect(mail.text).toContain('042317');
  });

  it('says how long it lasts', () => {
    expect(mail.text).toContain('10 minutes');
  });

  it('says what to do about a code nobody asked for', () => {
    // The most valuable sentence in the message: an unexpected code is the first
    // and often the only sign that somebody else has your password.
    expect(mail.text).toMatch(/were not signing in/i);
    expect(mail.text).toMatch(/tell IT/i);
  });

  it('carries no link', () => {
    /* A sign in email with a link in it teaches staff that clicking links in
       sign in emails is normal, which is the habit every phishing attack against
       them will rely on. */
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.html).toBeUndefined();
  });
});

describe('reading the code settings', () => {
  it('has a usual answer when nothing is configured', () => {
    // Unlike an empty allow list, silence here is not ambiguous. There is a usual
    // code length and a usual lifetime, and they are not a security decision
    // somebody has to make before the system will start.
    expect(codeSettings({} as NodeJS.ProcessEnv)).toEqual({
      length: DEFAULT_CODE_LENGTH,
      ttlMinutes: DEFAULT_TTL_MINUTES,
    });
  });

  it('takes the configured values', () => {
    expect(
      codeSettings({ MFA_CODE_LENGTH: '8', MFA_CODE_TTL_MINUTES: '5' } as NodeJS.ProcessEnv),
    ).toEqual({ length: 8, ttlMinutes: 5 });
  });

  it.each([
    ['a length that is not a number', { MFA_CODE_LENGTH: 'six' }],
    ['a length short enough to guess', { MFA_CODE_LENGTH: '1' }],
    ['a fractional length', { MFA_CODE_LENGTH: '6.5' }],
    ['a lifetime of nothing', { MFA_CODE_TTL_MINUTES: '0' }],
    ['a lifetime of a day', { MFA_CODE_TTL_MINUTES: '1440' }],
    ['a negative lifetime', { MFA_CODE_TTL_MINUTES: '-10' }],
  ])('refuses %s rather than shipping it', (_label, env) => {
    /* The failure that matters is the quiet one. A length of 1 read from a typo
       is a ten possibility second factor that looks exactly like a working one. */
    expect(() => codeSettings(env as NodeJS.ProcessEnv)).toThrow(/MFA_CODE/);
  });
});
