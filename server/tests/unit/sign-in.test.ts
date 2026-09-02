import { describe, expect, it } from 'vitest';
import {
  assertCanSignIn,
  assertUsablePassword,
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  type RefusalReason,
  type SignInAccount,
  SignInRefused,
  WeakPassword,
  whyNotSignIn,
} from '../../src/features/sign-in/sign-in.js';
import type { Employee, EmploymentStatus } from '../../src/features/employee/employee.js';

/**
 * NFR SEC 01, the rules half. LMS 109.
 *
 * Two properties are under test and they pull in opposite directions, which is
 * why they are worth pinning down together: the door has to close on everybody it
 * should close on, and it has to say why without saying it to a stranger.
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

function employee(status: EmploymentStatus, exitDate: string | null = null): Employee {
  return {
    id: '1',
    employeeNumber: 'RH-0007',
    firstName: 'Ama',
    lastName: 'Mensah',
    workEmail: 'ama.mensah@rematholdings.com',
    jobTitle: 'Accountant',
    departmentId: '2',
    managerId: '1',
    workPatternId: '1',
    startDate: '2024-03-01',
    exitDate,
    employmentType: 'FULL_TIME',
    employmentStatus: status,
    gender: null,
    createdAt: new Date('2024-03-01T09:00:00Z'),
    updatedAt: new Date('2024-03-01T09:00:00Z'),
  };
}

describe('who may use a login', () => {
  it('lets somebody who works here in', () => {
    expect(whyNotSignIn(account(), employee('ACTIVE'))).toBeNull();
    expect(() => assertCanSignIn(account(), employee('ACTIVE'))).not.toThrow();
  });

  it('closes the door on somebody who has left', () => {
    // The story's "and ends when it does". FR 06 keeps the record; this is what
    // stops the record being a way in.
    expect(whyNotSignIn(account(), employee('TERMINATED', '2026-07-31'))).toBe('EMPLOYMENT_ENDED');
  });

  it('closes it on somebody suspended', () => {
    expect(whyNotSignIn(account(), employee('SUSPENDED'))).toBe('EMPLOYMENT_SUSPENDED');
  });

  it('lets somebody serving notice in', () => {
    /* An exit date on an ACTIVE record is somebody working out their notice. They
       are still here, and they are exactly the person who needs to book the leave
       they are owed before they go. What ends access is the status. */
    expect(whyNotSignIn(account(), employee('ACTIVE', '2026-09-30'))).toBeNull();
  });

  it('closes it on an account that has been shut', () => {
    expect(whyNotSignIn(account({ isActive: false }), employee('ACTIVE'))).toBe('ACCOUNT_CLOSED');
  });

  it('tells a leaver they have left rather than that their account is shut', () => {
    // Both are true of this row. The one about the person is the useful one.
    const reason = whyNotSignIn(account({ isActive: false }), employee('TERMINATED', '2026-07-31'));

    expect(reason).toBe('EMPLOYMENT_ENDED');
  });

  it('refuses a login whose employee record is gone', () => {
    // Unreachable — nothing may delete an employee — but answered rather than
    // assumed, because the alternative in an authentication path is a pass.
    expect(whyNotSignIn(account(), undefined)).toBe('NO_EMPLOYEE');
  });

  it('throws where refusing is the point', () => {
    expect(() => assertCanSignIn(account(), employee('TERMINATED', '2026-07-31'))).toThrow(
      SignInRefused,
    );
  });
});

describe('what a refusal says', () => {
  /**
   * The three an outsider can provoke by typing into the box. They must be
   * indistinguishable, or the sign in form is a way of finding out who works
   * here.
   */
  const GUESSABLE: RefusalReason[] = ['NO_ACCOUNT', 'NO_PASSWORD', 'WRONG_PASSWORD'];

  it('gives one identical message to every reason a stranger could provoke', () => {
    const messages = new Set(GUESSABLE.map((reason) => new SignInRefused(reason).message));

    expect(messages.size).toBe(1);
  });

  it.each(GUESSABLE)('never says what was actually wrong, for %s', (reason) => {
    const { message } = new SignInRefused(reason);

    expect(message).not.toMatch(/no such|not found|unknown|does not exist|no account/i);
    expect(message).not.toMatch(/password is wrong|incorrect password|no password has/i);
  });

  it.each([
    ['EMPLOYMENT_ENDED', /ended when your employment/i],
    ['EMPLOYMENT_SUSPENDED', /suspended/i],
    ['ACCOUNT_CLOSED', /closed/i],
  ] as const)('says plainly what happened for %s, once the password is proved', (reason, text) => {
    /* These are only ever reached after a correct password, so the person has
       proved they are the account holder and nothing is being told to a stranger.
       Telling a leaver "wrong password" instead would cost them an afternoon. */
    expect(new SignInRefused(reason).message).toMatch(text);
  });

  it('keeps the real reason for the log', () => {
    expect(new SignInRefused('NO_PASSWORD').reason).toBe('NO_PASSWORD');
  });
});

describe('passwords this system will store', () => {
  it('accepts a passphrase', () => {
    expect(assertUsablePassword('correct horse battery staple')).toBe(
      'correct horse battery staple',
    );
  });

  it('changes nothing about what it was given', () => {
    // Not trimmed. A leading space is a character somebody chose, and removing it
    // means the password that was set is not the password that was typed.
    expect(assertUsablePassword('  a passphrase with spaces  ')).toBe(
      '  a passphrase with spaces  ',
    );
  });

  it.each([
    ['too short', 'short'],
    ['one character short', 'a'.repeat(MINIMUM_PASSWORD_LENGTH - 1)],
    ['empty', ''],
  ])('refuses a password that is %s', (_label, password) => {
    expect(() => assertUsablePassword(password)).toThrow(WeakPassword);
  });

  it('accepts one exactly at the minimum', () => {
    expect(() => assertUsablePassword('a'.repeat(MINIMUM_PASSWORD_LENGTH))).not.toThrow();
  });

  it('refuses one long enough to be a denial of service', () => {
    expect(() => assertUsablePassword('a'.repeat(MAXIMUM_PASSWORD_LENGTH + 1))).toThrow(
      WeakPassword,
    );
  });

  it('counts characters the way the person who typed them would', () => {
    // '👍'.length is 2, so a UTF-16 count would call eleven of these twenty two
    // characters and accept a passphrase shorter than the rule allows.
    const eleven = '👍'.repeat(MINIMUM_PASSWORD_LENGTH - 1);

    expect(eleven.length).toBeGreaterThan(MINIMUM_PASSWORD_LENGTH);
    expect(() => assertUsablePassword(eleven)).toThrow(WeakPassword);
  });

  it.each([
    ['nothing at all', undefined],
    ['null', null],
    ['a number', 12345678901234],
  ])('refuses %s rather than hashing it', (_label, value) => {
    expect(() => assertUsablePassword(value)).toThrow(WeakPassword);
  });

  it('asks for no capitals, digits or symbols', () => {
    /* Composition rules are what produce Password1! on every account in the
       building. Length is the property that costs an attacker something. */
    expect(() => assertUsablePassword('all lower case words here')).not.toThrow();
  });
});
