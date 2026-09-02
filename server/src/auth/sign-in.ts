/** The sign in account, and what makes one usable. NFR SEC 01, LMS 109, LMS 012. */

import type { Employee } from '../domain/employee.js';

/** A login as the rest of the application sees it. */
export interface SignInAccount {
  id: string;
  employeeId: string;
  /** The employee's work address. */
  companyEmail: string;
  /** Whether this login may be used at all. */
  isActive: boolean;
  /** LMS 110. */
  mfaEnabled: boolean;
  /** When this login was last used. */
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Why a sign in was refused, for the log rather than for the person. */
export type RefusalReason =
  /** No login with that address. */
  | 'NO_ACCOUNT'
  /** A login exists but nobody has set a password on it. */
  | 'NO_PASSWORD'
  /** The password did not match. */
  | 'WRONG_PASSWORD'
  /** The login is closed. */
  | 'ACCOUNT_CLOSED'
  /** The employee has left. FR 06. */
  | 'EMPLOYMENT_ENDED'
  /** The employee is suspended. */
  | 'EMPLOYMENT_SUSPENDED'
  /** A login whose employee record has gone. */
  | 'NO_EMPLOYEE';

/** A refused sign in. */
export class SignInRefused extends Error {
  readonly reason: RefusalReason;

  constructor(reason: RefusalReason) {
    super(messageFor(reason));
    this.name = 'SignInRefused';
    this.reason = reason;
  }
}

/** The generic answer. */
const CREDENTIALS_MESSAGE =
  'That email address and password do not match an account. Check both and try ' +
  'again, or ask HR to set your password if you have not signed in before.';

function messageFor(reason: RefusalReason): string {
  switch (reason) {
    case 'ACCOUNT_CLOSED':
      return (
        'This account has been closed. Your password is right, so this is not a ' +
        'typing mistake — ask HR or IT to reopen it.'
      );
    case 'EMPLOYMENT_ENDED':
      return (
        'Your access ended when your employment did. Your leave records are kept, ' +
        'and HR can answer a question about them.'
      );
    case 'EMPLOYMENT_SUSPENDED':
      return (
        'Your employment is recorded as suspended, so sign in is closed for now. ' +
        'HR can tell you more.'
      );
    default:
      return CREDENTIALS_MESSAGE;
  }
}

/** A login that is nobody's. */
export class SignInAccountNotFound extends Error {
  constructor(description: string) {
    super(`No sign in account for ${description}.`);
    this.name = 'SignInAccountNotFound';
  }
}

/**
 * An employee who already has a login.
 *
 * app_user.employee_id is UNIQUE, so this is a refusal rather than a second
 * account. One person, one login: two would be two passwords, two audit trails
 * and one of them abandoned.
 */
export class SignInAccountExists extends Error {
  constructor(companyEmail: string) {
    super(`${companyEmail} already has a sign in account.`);
    this.name = 'SignInAccountExists';
  }
}

/**
 * A login asked for on behalf of somebody who has already left.
 *
 * Separate from {@link SignInRefused}, and the separation is about who is
 * reading. A refusal is addressed to the person at the sign in box — "your
 * access ended when your employment did" — and provisioning is HR at a screen,
 * who is not that person and is not signing in. Reusing the refusal here would
 * tell an HR officer about their own employment.
 *
 * The account would be refused at the door anyway. This exists so that access
 * which has to be remembered about later is not created in the first place.
 */
export class EmploymentHasEnded extends Error {
  readonly employeeId: string;

  constructor(employee: Employee) {
    super(
      `${employee.firstName} ${employee.lastName} (${employee.employeeNumber}) left on ` +
        `${employee.exitDate ?? 'a date that was not recorded'} and cannot be given a ` +
        `sign in account. If they did not leave, correct the employee record first.`,
    );
    this.name = 'EmploymentHasEnded';
    this.employeeId = employee.id;
  }
}

/**
 * A login address that is not the employee's work address.
 *
 * Raised by the app_user_email_is_the_work_email trigger and translated by the
 * repository. Not reachable through this service, which never takes an address
 * from a caller — see {@link SignInService.provision} — so it is a report that
 * something else wrote to the table, and it says so plainly rather than being
 * folded into a general database error.
 */
export class SignInAddressMustBeTheWorkAddress extends Error {
  constructor() {
    super(
      'A sign in address must be the work address on the employee record. Change ' +
        'the work address and the login follows it.',
    );
    this.name = 'SignInAddressMustBeTheWorkAddress';
  }
}

/** A password this system will not store. */
export class WeakPassword extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeakPassword';
  }
}

/**
 * The shortest password this system accepts.
 *
 * Twelve, and length is the only rule. Composition rules — a capital, a digit,
 * a symbol — are what produce `Password1!` on every account in the building,
 * because they describe what a password must contain rather than how much of it
 * there is, and people satisfy them the cheapest way. Length is the property
 * that actually costs an attacker something, and twelve characters of anything
 * beats eight characters of everything.
 *
 * What is deliberately absent is a check against the lists of passwords already
 * known to have been breached, which is the one further rule worth having and
 * the one that needs a data set this repository does not carry. It is not done,
 * and it is worth doing.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;

/**
 * The longest, which is a denial of service limit and not a security one.
 *
 * scrypt hashes whatever it is given, and a megabyte of it takes a megabyte's
 * worth of time on a request nobody has authenticated yet. Long enough that no
 * passphrase anybody writes comes near it.
 */
export const MAXIMUM_PASSWORD_LENGTH = 256;

/**
 * Whether a password may be stored.
 *
 * Counted in code points rather than in UTF-16 units, so that a passphrase in a
 * script outside the basic plane is measured the way the person who typed it
 * would measure it: `'👍'.length` is 2, and telling somebody their eleven
 * character passphrase is twelve characters long is not a rule anybody can work
 * with.
 *
 * Nothing is trimmed. A leading or trailing space is a character somebody chose,
 * and quietly removing it means the password that was set is not the password
 * that was typed.
 */
export function assertUsablePassword(password: unknown): string {
  if (typeof password !== 'string') {
    throw new WeakPassword('A password is required.');
  }

  const length = [...password].length;

  if (length < MINIMUM_PASSWORD_LENGTH) {
    throw new WeakPassword(
      `A password needs at least ${MINIMUM_PASSWORD_LENGTH} characters. Length is ` +
        `what makes one hard to guess, so a phrase you will remember is better than ` +
        `a short word with a symbol in it.`,
    );
  }

  if (length > MAXIMUM_PASSWORD_LENGTH) {
    throw new WeakPassword(`A password may be at most ${MAXIMUM_PASSWORD_LENGTH} characters.`);
  }

  return password;
}

/**
 * Why this account may not be used, or null if it may.
 *
 * Asked only after the password has been verified. Everything it can answer is
 * something the account holder is entitled to know and a stranger is not, and
 * the ordering in {@link SignInService.signIn} is what keeps that true rather
 * than any property of this function.
 *
 * `employee` is the record the account belongs to, read at the moment of the
 * attempt. Passing it in rather than reading it here is what keeps this file
 * free of a database, and passing the *current* record rather than a status
 * copied onto the account is the whole of why a leaver cannot sign in.
 *
 * `undefined` is a login whose employee record has gone. It cannot happen —
 * app_user.employee_id is a foreign key with no cascade, and nothing may delete
 * an employee at all — but it is answered rather than assumed, because the
 * alternative in an authentication path is a crash or, worse, a pass.
 */
export function whyNotSignIn(
  account: SignInAccount,
  employee: Employee | undefined,
): RefusalReason | null {
  if (employee === undefined) {
    return 'NO_EMPLOYEE';
  }

  /* Employment first, because it is the reason that is true of the person rather
     than of the account, and it is the one the story is about. Somebody who has
     left is told that they have left, not that their account is closed, even if
     both happen to be so. */
  if (employee.employmentStatus === 'TERMINATED') {
    return 'EMPLOYMENT_ENDED';
  }
  if (employee.employmentStatus === 'SUSPENDED') {
    return 'EMPLOYMENT_SUSPENDED';
  }

  if (!account.isActive) {
    return 'ACCOUNT_CLOSED';
  }

  return null;
}

/**
 * The same question, for the paths where refusing is the point.
 *
 * An exit date on an ACTIVE record is deliberately not a refusal. It is somebody
 * serving notice, who works here until the day they do not and needs to book the
 * leave they are owed before they go. What ends access is the status, which is
 * what {@link EmployeeService.terminate} sets on the day it becomes true.
 */
export function assertCanSignIn(account: SignInAccount, employee: Employee | undefined): void {
  const reason = whyNotSignIn(account, employee);

  if (reason !== null) {
    throw new SignInRefused(reason);
  }
}
