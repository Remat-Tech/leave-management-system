/** The one time code sent to a work address at sign in. NFR SEC 01, LMS 110. */

import { randomInt } from 'node:crypto';
import type { Mail } from '../mail/transport.js';
import { hashPassword, verifyPassword } from './password.js';
import type { RoleCode } from './roles.js';
import type { SignInAccount } from './sign-in.js';

/** The roles for which a code is not optional. */
export const MANDATORY_ROLES: readonly RoleCode[] = ['HR_OFFICER', 'HR_ADMIN', 'SYS_ADMIN'];

/** How many wrong answers a challenge survives. */
export const MAX_CODE_ATTEMPTS = 5;

/** How long a code lives when nothing says otherwise. */
export const DEFAULT_TTL_MINUTES = 10;

/** How many digits a code has when nothing says otherwise. */
export const DEFAULT_CODE_LENGTH = 6;

export interface CodeSettings {
  length: number;
  ttlMinutes: number;
}

/** The code settings from configuration. */
export function codeSettings(env: NodeJS.ProcessEnv = process.env): CodeSettings {
  return {
    length: wholeNumber(env.MFA_CODE_LENGTH, 'MFA_CODE_LENGTH', DEFAULT_CODE_LENGTH, 4, 12),
    ttlMinutes: wholeNumber(
      env.MFA_CODE_TTL_MINUTES,
      'MFA_CODE_TTL_MINUTES',
      DEFAULT_TTL_MINUTES,
      1,
      60,
    ),
  };
}

function wholeNumber(
  value: string | undefined,
  name: string,
  fallback: number,
  least: number,
  most: number,
): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value.trim());

  if (!Number.isInteger(parsed) || parsed < least || parsed > most) {
    throw new Error(
      `${name} is "${value}". It must be a whole number between ${least} and ${most}. ` +
        `See .env.example.`,
    );
  }

  return parsed;
}

/**
 * Whether this account has to answer a code.
 *
 * Two ways to be true, and they are different kinds of fact. `mfaEnabled` is a
 * choice somebody made and can unmake; a mandatory role is a consequence of what
 * they can see, and holds whatever the flag says. The order of the `||` is
 * therefore not the interesting part — what matters is that the role half is
 * never read from the account, because a copy of somebody's roles on their login
 * row is a copy that is wrong the day HR changes them.
 *
 * `roleCodes` is what they hold right now, read at the moment they sign in. It is
 * the same reasoning that keeps employment status off the account: derived, there
 * is nothing to keep in step.
 */
export function isCodeRequired(account: SignInAccount, roleCodes: readonly string[]): boolean {
  return account.mfaEnabled || holdsMandatoryRole(roleCodes);
}

export function holdsMandatoryRole(roleCodes: readonly string[]): boolean {
  return roleCodes.some((code) => (MANDATORY_ROLES as readonly string[]).includes(code));
}

/**
 * Somebody trying to turn off a code they do not get to turn off.
 *
 * Refused rather than silently ignored. Quietly leaving it on would be safe and
 * would also mean an HR officer believes they have switched something off that is
 * still on, which is how somebody stops trusting what a screen tells them.
 */
export class CodeIsMandatory extends Error {
  readonly roleCodes: readonly string[];

  constructor(roleCodes: readonly string[]) {
    const held = roleCodes.filter((code) => (MANDATORY_ROLES as readonly string[]).includes(code));

    super(
      `A one time code is required for ${held.join(' and ')} and cannot be turned off. ` +
        `These roles can read everybody's leave records and the medical certificates ` +
        `attached to them. Remove the role first if that is what was meant.`,
    );
    this.name = 'CodeIsMandatory';
    this.roleCodes = held;
  }
}

/** Why a code was not accepted. */
export type CodeRefusalReason =
  /** No challenge is in progress for this account. */
  | 'NO_CHALLENGE'
  /** There was one and it has run out. */
  | 'EXPIRED'
  /** Wrong code, and there are attempts left. */
  | 'WRONG_CODE'
  /** Wrong code, and that was the last attempt. */
  | 'TOO_MANY_ATTEMPTS';

/** A code that was not accepted. */
export class CodeRefused extends Error {
  readonly reason: CodeRefusalReason;

  constructor(reason: CodeRefusalReason, remaining = 0) {
    super(messageFor(reason, remaining));
    this.name = 'CodeRefused';
    this.reason = reason;
  }
}

function messageFor(reason: CodeRefusalReason, remaining: number): string {
  switch (reason) {
    case 'NO_CHALLENGE':
      return 'There is no code waiting to be entered. Sign in again to be sent one.';
    case 'EXPIRED':
      return 'That code has expired. Sign in again to be sent a new one.';
    case 'TOO_MANY_ATTEMPTS':
      return (
        'That code has been entered wrongly too many times and is no longer valid. ' +
        'Sign in again to be sent a new one.'
      );
    default:
      return remaining === 1
        ? 'That code is not right. One more attempt before a new code is needed.'
        : `That code is not right. ${remaining} attempts left.`;
  }
}

/**
 * A code, as digits.
 *
 * `randomInt` rather than `Math.random`, because this is a credential and
 * `Math.random` is a fast generator whose output is predictable from enough of
 * its previous output. One call per digit, padded, so that every code of the
 * configured length is equally likely — deriving digits from one large random
 * number by taking a remainder is the usual way to make the low digits slightly
 * more likely than the high ones.
 *
 * Kept as a string throughout, and never as a number. `012345` is a perfectly
 * good code and is not twelve thousand three hundred and forty five.
 */
export function generateCode(length: number = DEFAULT_CODE_LENGTH): string {
  let code = '';

  for (let digit = 0; digit < length; digit += 1) {
    code += String(randomInt(0, 10));
  }

  return code;
}

/**
 * A code as it is stored, which is not as it was sent.
 *
 * The same treatment a password gets, and for a reason worth stating rather than
 * assuming: a copy of `app_user` taken while people are signing in is otherwise a
 * list of the codes currently in flight, next to the addresses to use them at.
 * The story asks for hashed at rest, and hashed at rest means hashed the way the
 * other secret in this table is hashed, not encoded.
 *
 * The cost is the password cost, which is heavier than a ten minute six digit
 * code strictly needs. It is kept because the alternative is a second, weaker
 * hashing path in the same file as the first, and because it makes a stolen
 * column expensive to grind even at a million possibilities.
 */
export async function hashCode(code: string): Promise<string> {
  return hashPassword(code);
}

/** The same comparison, timing safe, and false for anything unreadable. */
export async function checkCode(code: string, stored: string | null): Promise<boolean> {
  return verifyPassword(code, stored);
}

/**
 * Whether a challenge is still answerable, ignoring what was typed.
 *
 * `now` is passed in rather than read, so a test can stand at any moment it likes
 * and so there is exactly one clock in the sign in path. Expiry is `>=` rather
 * than `>`: a code that expires at the instant it is checked has expired.
 */
export function challengeIsLive(
  expiresAt: Date | null,
  attempts: number,
  now: Date,
): CodeRefusalReason | null {
  if (expiresAt === null) {
    return 'NO_CHALLENGE';
  }
  if (now.getTime() >= expiresAt.getTime()) {
    return 'EXPIRED';
  }
  if (attempts >= MAX_CODE_ATTEMPTS) {
    return 'TOO_MANY_ATTEMPTS';
  }

  return null;
}

/** When a code issued now runs out. */
export function expiryFrom(now: Date, ttlMinutes: number): Date {
  return new Date(now.getTime() + ttlMinutes * 60_000);
}

/**
 * The message the code goes in.
 *
 * Plain text and short. Three things it deliberately does and one it deliberately
 * does not:
 *
 *   The code is in the subject line as well as the body, because that is where a
 *   phone shows it and copying it from a notification is what people actually do.
 *
 *   It says how long the code lasts, so that somebody who comes back to it in an
 *   hour knows why it stopped working rather than thinking the system is broken.
 *
 *   It says what to do if they were not signing in, because an unexpected code is
 *   the first and often the only sign that somebody else has their password. That
 *   sentence is the most valuable one in the message.
 *
 *   It carries no link. A sign in email with a link in it teaches staff that
 *   clicking links in sign in emails is normal, which is the exact habit every
 *   phishing attack against them will rely on.
 */
export function codeEmail(to: string, code: string, ttlMinutes: number): Mail {
  return {
    to,
    subject: `${code} is your Remat Holdings leave sign in code`,
    text: [
      `Your sign in code is ${code}.`,
      '',
      `It works once, and only for the next ${ttlMinutes} minutes.`,
      '',
      'If you were not signing in, somebody else may have your password. Do not',
      'enter this code, and tell IT so that your password can be changed.',
      '',
      'Remat Holdings Leave',
    ].join('\n'),
  };
}
