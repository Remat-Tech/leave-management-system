import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { NotACompanyEmail } from '../../src/features/sign-in/company-email.js';
import {
  EmploymentHasEnded,
  SignInAccountExists,
  SignInAccountNotFound,
  SignInAddressMustBeTheWorkAddress,
  SignInRefused,
  WeakPassword,
} from '../../src/features/sign-in/sign-in.js';
import { EmployeeNotFound } from '../../src/features/employee/employee.js';
import { DepartmentRepository } from '../../src/features/department/department.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { RoleRepository } from '../../src/features/role/role.db.js';
import { SignInAccountRepository } from '../../src/features/sign-in/sign-in-account.db.js';
import { WorkPatternRepository } from '../../src/features/work-pattern/work-pattern.db.js';
import { EmployeeService } from '../../src/features/employee/employee.service.js';
import { type SignedIn, SignInService } from '../../src/features/sign-in/sign-in.service.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';
import { theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';

/**
 * Signing in with a company email address, against a real database. NFR SEC 01,
 * LMS 109.
 *
 * The unit suites cover the rules and the hashing. What needs a database is
 * everything the database itself decides, and everything the ordering of real
 * reads decides:
 *
 *   That a login is the employee's work address and cannot become anything else,
 *   including when the address is corrected months later by a service that has
 *   never heard of logins.
 *
 *   That access really does end when employment does, read from the employee
 *   record at the moment somebody knocks rather than from a copy made when they
 *   left.
 *
 *   That the address a person types finds the same single row the unique index
 *   would have refused a second of, whatever case they typed it in.
 *
 *   That the application role can close a login and cannot delete one.
 */

const testDatabaseUrl = await databaseForThisFile();

// The suite supplies its own rather than reading ALLOWED_EMAIL_DOMAINS, which is
// set in .env but not in CI.
const DOMAINS = ['rematholdings.com'];

/** Long enough to be accepted, and the same one throughout so a failure is legible. */
const PASSWORD = 'a passphrase nobody guesses';

/**
 * The actor these fixtures are built by, and the guard the services are given.
 *
 * {@link theSystem} rather than a person, because that is what this is: work
 * nobody asked for, setting up an organisation for the assertions below to be
 * about. It holds every role and is nobody, so no policy refuses it and no
 * "this is my own record" rule can accidentally match it.
 *
 * Whether the policies refuse the right people is not this suite's question. It
 * is server/tests/integration/authorisation.test.ts, and the rules themselves
 * are server/tests/unit/policy.test.ts.
 *
 * The guard writes refusals to stderr, which is the default. Nothing here should
 * provoke one, so a line appearing in the output is a failing test explaining
 * itself.
 */
const system = theSystem('sign in integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let accounts: SignInAccountRepository;
let logins: SignInService;
let employees: EmployeeService;

/** The ids the seed created, keyed by the names it uses for them. */
let people: Record<string, string>;

const OFFICER_EMAIL = 'adwoa.frimpong@rematholdings.com';
const LEAVER_EMAIL = 'kojo.antwi@rematholdings.com';

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  accounts = new SignInAccountRepository(db);
  logins = new SignInService(
    accounts,
    new EmployeeRepository(db),
    new RoleRepository(db),
    recordingMailer(),
    guard,
    { domains: DOMAINS },
  );
  employees = new EmployeeService(
    new EmployeeRepository(db),
    new DepartmentRepository(db),
    new WorkPatternRepository(db),
    guard,
    { domains: DOMAINS },
  );
});

beforeEach(async () => {
  people = (await seed(admin)) as Record<string, string>;
});

afterAll(async () => {
  await db?.destroy();
  await admin?.end();
});

/**
 * Runs statements in one transaction on the owner connection.
 *
 * The address trigger is deferred, so a test that wants to see it refuse
 * something has to get as far as committing. The rollback in the catch is what
 * keeps a refusal from leaving the connection in an aborted transaction and
 * failing every test after it.
 */
async function inTransaction(...statements: string[]): Promise<void> {
  await admin.query('BEGIN');
  try {
    for (const statement of statements) {
      await admin.query(statement);
    }
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

/**
 * The seed gives everybody a login and nobody a password, which is the honest
 * state of a freshly provisioned account. Most tests want one they can sign in
 * with.
 */
async function withPassword(employeeId: string, password = PASSWORD): Promise<void> {
  await logins.setPassword(system, employeeId, password);
}

/** A joiner nobody has provisioned, in the officer's department and under her lead. */
async function newEmployee(email = 'esi.nyarko@rematholdings.com') {
  const officer = await employees.byId(system, people.officer);

  return employees.create(system, {
    employeeNumber: 'RH-0100',
    firstName: 'Esi',
    lastName: 'Nyarko',
    workEmail: email,
    departmentId: officer.departmentId,
    managerId: officer.managerId,
    startDate: '2026-09-01',
  });
}

describe('signing in', () => {
  it('accepts the work address and the password that was set', async () => {
    await withPassword(people.officer);

    const { employee, account } = await signedIn(OFFICER_EMAIL, PASSWORD);

    expect(employee.workEmail).toBe(OFFICER_EMAIL);
    expect(account.employeeId).toBe(people.officer);
  });

  it('does not care what case the address was typed in', async () => {
    // Nobody types their own address the same way twice, and no mail server
    // treats these as separate mailboxes.
    await withPassword(people.officer);

    await expect(
      logins.signIn('Adwoa.Frimpong@REMATHOLDINGS.COM', PASSWORD),
    ).resolves.toMatchObject({
      account: { employeeId: people.officer },
    });
  });

  it('tolerates the whitespace a paste or an autofill leaves behind', async () => {
    await withPassword(people.officer);

    await expect(logins.signIn(`  ${OFFICER_EMAIL}  `, PASSWORD)).resolves.toBeDefined();
  });

  it('records when the account was last used', async () => {
    await withPassword(people.officer);
    const before = new Date();

    const { account } = await signedIn(OFFICER_EMAIL, PASSWORD);

    expect(account.lastLoginAt).not.toBeNull();
    expect(account.lastLoginAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);

    // And it is in the table, not only in the object that was returned.
    const stored = await logins.forEmployee(system, people.officer);
    expect(stored?.lastLoginAt).not.toBeNull();
  });

  it('is exact about the password', async () => {
    await withPassword(people.officer);

    await expect(logins.signIn(OFFICER_EMAIL, 'a passphrase nobody guesse')).rejects.toThrow(
      SignInRefused,
    );
    await expect(logins.signIn(OFFICER_EMAIL, 'A Passphrase Nobody Guesses')).rejects.toThrow(
      SignInRefused,
    );
  });

  it('refuses an account nobody has set a password on', async () => {
    // Every login the seed creates is in this state, and so is a joiner's
    // between HR creating it and somebody choosing a password.
    await expect(logins.signIn(OFFICER_EMAIL, PASSWORD)).rejects.toMatchObject({
      reason: 'NO_PASSWORD',
    });
  });

  it('says the same thing whether the address is unknown or the password is wrong', async () => {
    /* The sign in box must not be a way of finding out who works here. Two
       different messages here is a staff list an attacker did not have. */
    await withPassword(people.officer);

    const unknown = await refusal(() => logins.signIn('nobody.here@rematholdings.com', PASSWORD));
    const wrong = await refusal(() => logins.signIn(OFFICER_EMAIL, 'not the password'));

    expect(unknown.reason).toBe('NO_ACCOUNT');
    expect(wrong.reason).toBe('WRONG_PASSWORD');
    expect(unknown.message).toBe(wrong.message);
  });
});

describe('only the configured company domains, at the login door', () => {
  it('refuses a personal address, and says why', async () => {
    // The story's second acceptance criterion. Specific on purpose: which domains
    // the company uses is public, and telling somebody their Gmail address will
    // never work here saves them trying it again tomorrow.
    const error = await rejection(() => logins.signIn('adwoa.frimpong@gmail.com', PASSWORD));

    expect(error).toBeInstanceOf(NotACompanyEmail);
    expect(error.message).toMatch(/not a company address/i);
    expect(error.message).toContain('adwoa.frimpong@gmail.com');
  });

  it.each([
    ['a subdomain, which is a different domain', 'adwoa@hr.rematholdings.com'],
    ['a domain that merely ends the same way', 'attacker@notrematholdings.com'],
    ['the domain hidden in the local part', 'adwoa@rematholdings.com@evil.net'],
    ['a trailing dot, which resolves to the same host', 'adwoa.frimpong@rematholdings.com.'],
  ])('refuses %s', async (_label, email) => {
    await expect(logins.signIn(email, PASSWORD)).rejects.toThrow(NotACompanyEmail);
  });

  it('refuses an address outside the list even when that address has a login', async () => {
    /* The reason the list is checked at both doors rather than only at
       provisioning. This record was created while the domain was accepted; the
       question at the door is whether it is accepted today. */
    await withPassword(people.officer);

    const narrower = new SignInService(
      accounts,
      new EmployeeRepository(db),
      new RoleRepository(db),
      recordingMailer(),
      guard,
      { domains: ['remat.tech'] },
    );

    await expect(narrower.signIn(OFFICER_EMAIL, PASSWORD)).rejects.toThrow(NotACompanyEmail);
  });
});

describe('access ends when employment does', () => {
  it('shuts the door on somebody who has left, password or no password', async () => {
    /* The seed's leaver, whose record FR 06 keeps. Their password is set first,
       so this is not a wrong password quietly passing for a closed door: the
       credential is right and the employment is over. */
    await withPassword(people.leaver);

    const refused = await refusal(() => logins.signIn(LEAVER_EMAIL, PASSWORD));

    expect(refused.reason).toBe('EMPLOYMENT_ENDED');
    expect(refused.message).toMatch(/ended when your employment/i);
  });

  it('shuts it the moment somebody is terminated, with nothing written to the login', async () => {
    await withPassword(people.officer);
    await expect(logins.signIn(OFFICER_EMAIL, PASSWORD)).resolves.toBeDefined();

    await employees.terminate(system, people.officer, { exitDate: '2026-09-30' });

    await expect(logins.signIn(OFFICER_EMAIL, PASSWORD)).rejects.toMatchObject({
      reason: 'EMPLOYMENT_ENDED',
    });

    /* And the account itself was never touched. That is the design: the status is
       read from the employee record at the moment somebody knocks, so there is no
       copy to keep in step and no path that can forget to. */
    const account = await logins.forEmployee(system, people.officer);
    expect(account?.isActive).toBe(true);
  });

  it('opens again if the termination was a mistake', async () => {
    // The dividend of never having deleted anything. Correcting a termination is
    // an ordinary edit, and the door follows the record rather than needing its
    // own correction.
    await withPassword(people.officer);
    await employees.terminate(system, people.officer, { exitDate: '2026-09-30' });

    await employees.update(system, people.officer, { employmentStatus: 'ACTIVE', exitDate: null });

    await expect(logins.signIn(OFFICER_EMAIL, PASSWORD)).resolves.toBeDefined();
  });

  it('lets somebody working out their notice carry on', async () => {
    // An exit date on an ACTIVE record is somebody serving notice, and they are
    // exactly the person who needs to book the leave they are owed.
    await withPassword(people.officer);
    await employees.update(system, people.officer, { exitDate: '2026-12-31' });

    await expect(logins.signIn(OFFICER_EMAIL, PASSWORD)).resolves.toBeDefined();
  });

  it('shuts the door on a suspended employee', async () => {
    await withPassword(people.officer);
    await employees.update(system, people.officer, { employmentStatus: 'SUSPENDED' });

    await expect(logins.signIn(OFFICER_EMAIL, PASSWORD)).rejects.toMatchObject({
      reason: 'EMPLOYMENT_SUSPENDED',
    });
  });
});

describe('closing a login on its own', () => {
  it('closes and reopens, without touching the employee record', async () => {
    await withPassword(people.officer);

    await logins.close(system, people.officer);
    await expect(logins.signIn(OFFICER_EMAIL, PASSWORD)).rejects.toMatchObject({
      reason: 'ACCOUNT_CLOSED',
    });

    const employee = await employees.byId(system, people.officer);
    expect(employee.employmentStatus).toBe('ACTIVE');

    await logins.reopen(system, people.officer);
    await expect(logins.signIn(OFFICER_EMAIL, PASSWORD)).resolves.toBeDefined();
  });

  it('tells a closed account holder that it is closed, not that they typed it wrong', async () => {
    /* Only reachable after a correct password, so the person has proved who they
       are and there is no stranger left to keep anything from. */
    await withPassword(people.officer);
    await logins.close(system, people.officer);

    const refused = await refusal(() => logins.signIn(OFFICER_EMAIL, PASSWORD));
    const wrong = await refusal(() => logins.signIn(OFFICER_EMAIL, 'not the password'));

    expect(refused.message).not.toBe(wrong.message);
    expect(refused.message).toMatch(/closed/i);
  });

  it('refuses to act on somebody with no login at all', async () => {
    const joiner = await newEmployee();

    await expect(logins.close(system, joiner.id)).rejects.toThrow(SignInAccountNotFound);
    await expect(logins.setPassword(system, joiner.id, PASSWORD)).rejects.toThrow(
      SignInAccountNotFound,
    );
  });
});

describe('provisioning a login', () => {
  it('takes the address from the employee record rather than from the caller', async () => {
    const joiner = await newEmployee();

    const account = await logins.provision(system, joiner.id, { password: PASSWORD });

    expect(account.companyEmail).toBe(joiner.workEmail);
    await expect(logins.signIn(joiner.workEmail, PASSWORD)).resolves.toBeDefined();
  });

  it('creates one without a password, which nobody can sign in with', async () => {
    const joiner = await newEmployee();

    const account = await logins.provision(system, joiner.id);

    expect(account.isActive).toBe(true);
    await expect(logins.signIn(joiner.workEmail, PASSWORD)).rejects.toMatchObject({
      reason: 'NO_PASSWORD',
    });

    // And it becomes usable when somebody sets one, without being recreated.
    await logins.setPassword(system, joiner.id, PASSWORD);
    await expect(logins.signIn(joiner.workEmail, PASSWORD)).resolves.toMatchObject({
      account: { id: account.id },
    });
  });

  it('gives nobody a second login', async () => {
    // app_user.employee_id is UNIQUE. Two logins would be two passwords, two
    // audit trails, and one of them abandoned.
    await expect(logins.provision(system, people.officer)).rejects.toThrow(SignInAccountExists);
  });

  it('gives a leaver none, and says so to the person asking', async () => {
    const leaver = await employees.byId(system, people.leaver);
    await admin.query('DELETE FROM app_user WHERE employee_id = $1', [leaver.id]);

    const error = await rejection(() => logins.provision(system, leaver.id));

    /* Not a SignInRefused. That message is addressed to the person at the sign in
       box, and this one is read by an HR officer who is neither that person nor
       signing in. */
    expect(error).toBeInstanceOf(EmploymentHasEnded);
    expect(error.message).toContain('Kojo Antwi');
    expect(error.message).toContain('2026-07-31');
  });

  it('refuses an employee who is nobody', async () => {
    await expect(logins.provision(system, '999999')).rejects.toThrow(EmployeeNotFound);
  });

  it('refuses a password too short to be worth hashing', async () => {
    const joiner = await newEmployee();

    await expect(logins.provision(system, joiner.id, { password: 'short' })).rejects.toThrow(
      WeakPassword,
    );

    // And nothing was created on the way to refusing.
    expect(await logins.forEmployee(system, joiner.id)).toBeUndefined();
  });

  it('never stores the password', async () => {
    const joiner = await newEmployee();
    await logins.provision(system, joiner.id, { password: PASSWORD });

    const { rows } = await admin.query<{ hash: string }>(
      'SELECT password_hash AS hash FROM app_user WHERE employee_id = $1',
      [joiner.id],
    );

    expect(rows[0].hash).not.toContain(PASSWORD);
    expect(rows[0].hash).toMatch(/^scrypt\$/);
  });
});

describe('the login is the work address, and stays it', () => {
  it('follows a corrected work address, carried by the database', async () => {
    /* The whole of "access is tied to the company account". EmployeeService knows
       nothing about logins and should not have to: HR corrects a misspelled
       address and the login moves with it, whoever is writing. */
    await withPassword(people.officer);
    const corrected = 'adwoa.frimpong-mensah@rematholdings.com';

    await employees.update(system, people.officer, { workEmail: corrected });

    const account = await logins.forEmployee(system, people.officer);
    expect(account?.companyEmail).toBe(corrected);

    await expect(logins.signIn(corrected, PASSWORD)).resolves.toBeDefined();

    // And the address they no longer have is no longer a way in — which also
    // means it is free for the next joiner to be issued.
    await expect(logins.signIn(OFFICER_EMAIL, PASSWORD)).rejects.toMatchObject({
      reason: 'NO_ACCOUNT',
    });
  });

  it('refuses a login address written directly to something else', async () => {
    /* lms_app holds UPDATE on app_user, so this is reachable from the
       application and is refused rather than trusted not to happen. Deferred, so
       it arrives at COMMIT. */
    await expect(
      inTransaction(
        `UPDATE app_user SET company_email = 'someone.else@rematholdings.com'
          WHERE employee_id = ${people.officer}`,
      ),
    ).rejects.toThrow(/app_user_email_is_the_work_email|not the work address/);
  });

  it('refuses a login created with an address that is not the employee’s', async () => {
    /* Reached through the repository, because the service takes the address from
       the employee record and cannot provoke this. An address somebody else's
       login already holds would be caught first, and immediately, by
       app_user_company_email_unique; this one belongs to no login and no
       employee, so it is the deferred trigger that refuses it at COMMIT. */
    const joiner = await newEmployee();

    await expect(
      accounts.create(system, {
        employeeId: joiner.id,
        companyEmail: 'someone.else@rematholdings.com',
        passwordHash: null,
      }),
    ).rejects.toThrow(SignInAddressMustBeTheWorkAddress);
  });

  it('keeps the tie when only the capitals change', async () => {
    // Folded on both sides, because a tie that held for one spelling of the same
    // address and not the other would be no tie at all.
    await expect(
      inTransaction(
        `UPDATE app_user SET company_email = upper(company_email)
          WHERE employee_id = ${people.officer}`,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('what the database holds whatever is writing', () => {
  it('refuses a blank sign in address', async () => {
    await expect(
      admin.query(`UPDATE app_user SET company_email = '' WHERE employee_id = ${people.officer}`),
    ).rejects.toThrow(/app_user_company_email_not_blank/);
  });

  it('refuses a blank password hash', async () => {
    // Neither a password nor the absence of one: a value no password verifies
    // against and every password fails, silently, forever.
    await expect(
      admin.query(`UPDATE app_user SET password_hash = '' WHERE employee_id = ${people.officer}`),
    ).rejects.toThrow(/app_user_password_hash_not_blank/);
  });

  it('lets the application close a login and never delete one', async () => {
    /* The privilege is the enforcement. user_role rows point at a login, and
       LMS 113's audit entries will name it; an account that was removed rather
       than closed leaves a trail referring to somebody nobody can identify. */
    const { rows } = await admin.query<{ del: boolean; upd: boolean; ins: boolean }>(
      `SELECT has_table_privilege('lms_app', 'app_user', 'DELETE') AS del,
              has_table_privilege('lms_app', 'app_user', 'UPDATE') AS upd,
              has_table_privilege('lms_app', 'app_user', 'INSERT') AS ins`,
    );

    expect(rows[0].del).toBe(false);
    expect(rows[0].upd).toBe(true);
    expect(rows[0].ins).toBe(true);
  });

  it('records when a login last changed', async () => {
    // "When was this account created" and "when did it last change" are the first
    // two questions asked of access nobody can account for.
    const before = await logins.forEmployee(system, people.officer);
    expect(before?.createdAt).toBeInstanceOf(Date);

    await withPassword(people.officer);

    const after = await logins.forEmployee(system, people.officer);
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
    expect(after!.createdAt.getTime()).toBe(before!.createdAt.getTime());
  });

  it('never hands a password hash to anything above the repository', async () => {
    /* The hash leaves the repository through one method whose name says so. Every
       other read is a login without its credential, so a hash cannot reach a log
       line by being carried along in an object nobody looked inside. */
    await withPassword(people.officer);

    const account = await logins.forEmployee(system, people.officer);

    expect(JSON.stringify(account)).not.toContain('scrypt');
    expect(Object.keys(account!)).not.toContain('passwordHash');
  });
});

/**
 * Signs in and asserts that the door actually opened.
 *
 * Since LMS 110 a sign in either opens the door or sends a code, and everybody in
 * this file holds only EMPLOYEE, so it opens. Saying so through a helper rather
 * than a cast means that if somebody makes the code mandatory for everyone, these
 * tests fail with "expected SIGNED_IN, got CODE_SENT" rather than with a
 * property missing from an object.
 */
async function signedIn(email: string, password: string): Promise<SignedIn> {
  const outcome = await logins.signIn(email, password);

  expect(outcome.status).toBe('SIGNED_IN');
  return outcome as { status: 'SIGNED_IN' } & SignedIn;
}

/** The {@link SignInRefused} a call produced, having asserted that it produced one. */
async function refusal(call: () => Promise<unknown>): Promise<SignInRefused> {
  const error = await rejection(call);

  expect(error).toBeInstanceOf(SignInRefused);
  return error as SignInRefused;
}

/** Whatever a call threw, having asserted that it threw. */
async function rejection(call: () => Promise<unknown>): Promise<Error> {
  try {
    await call();
  } catch (error) {
    return error as Error;
  }

  throw new Error('Expected the call to be refused, and it was not.');
}
