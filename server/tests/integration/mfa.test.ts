import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import type { Kysely } from 'kysely';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import {
  CodeIsMandatory,
  CodeRefused,
  MANDATORY_ROLES,
  MAX_CODE_ATTEMPTS,
} from '../../src/features/sign-in/mfa.js';
import { SignInRefused } from '../../src/features/sign-in/sign-in.js';
import { DepartmentRepository } from '../../src/features/department/department.db.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { RoleRepository } from '../../src/features/role/role.db.js';
import { SignInAccountRepository } from '../../src/features/sign-in/sign-in-account.db.js';
import { WorkPatternRepository } from '../../src/features/work-pattern/work-pattern.db.js';
import { EmployeeService } from '../../src/features/employee/employee.service.js';
import { type SignedIn, SignInService } from '../../src/features/sign-in/sign-in.service.js';
import { recordingMailer, type RecordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';
import { theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';

/**
 * The one time code, against a real database. NFR SEC 01, LMS 110.
 *
 * The unit suite covers the rules. What needs a database is the whole of what
 * makes a code a second factor rather than a formality:
 *
 *   That the code is decided by the roles somebody holds *now*, read from
 *   user_role at the moment they sign in, so that granting HR_OFFICER this
 *   morning is enough and nothing has to be copied anywhere.
 *
 *   That it really is single use — consumed on success, replaced on reissue, and
 *   gone after the attempt limit — which is three different writes to the same
 *   three columns and is the thing most likely to have a path that forgets one.
 *
 *   That the attempt count survives concurrent guesses, which a read, add and
 *   write does not.
 *
 *   That what is in the column is a hash, and that the constraints hold whatever
 *   is writing.
 *
 * The mailer is a recording one rather than SMTP. Whether nodemailer can reach a
 * server is ./mail.test.ts's question; what is asked here is what the
 * application put in the message and who it addressed it to, which is the half
 * that carries the story's first acceptance criterion.
 */

const testDatabaseUrl = await databaseForThisFile();

const DOMAINS = ['rematholdings.com'];
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
const system = theSystem('one time code integration fixtures');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let accounts: SignInAccountRepository;
let roles: RoleRepository;
let mailer: RecordingMailer;
let logins: SignInService;
let employees: EmployeeService;

let people: Record<string, string>;

/** Adwoa Frimpong, an ordinary employee: EMPLOYEE and nothing else. */
const OFFICER_EMAIL = 'adwoa.frimpong@rematholdings.com';

/** Ama Mensah, who holds HR_ADMIN in the seed. A code is not optional for her. */
const HR_ADMIN_EMAIL = 'ama.mensah@rematholdings.com';

/** Efua Owusu, HR_OFFICER in the base fixture. */
const HR_OFFICER_EMAIL = 'efua.owusu@rematholdings.com';

beforeAll(async () => {
  db = databaseFor(testDatabaseUrl);

  admin = new Client({ connectionString: testDatabaseUrl });
  await admin.connect();

  accounts = new SignInAccountRepository(db);
  roles = new RoleRepository(db);
  mailer = recordingMailer();

  logins = new SignInService(accounts, new EmployeeRepository(db), roles, mailer, guard, {
    domains: DOMAINS,
  });
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
  mailer.clear();
});

afterAll(async () => {
  await db?.destroy();
  await admin?.end();
});

/** The seed gives everybody a login and nobody a password. */
async function withPassword(employeeId: string): Promise<void> {
  await logins.setPassword(system, employeeId, PASSWORD);
}

/**
 * Signs in as far as the code, and reads the code out of the message that was
 * sent.
 *
 * Reading it from the mail rather than from the database is the point: the
 * database holds a hash, and a test that could recover the code from the column
 * would be a test proving the code is not hashed.
 */
async function codeSentTo(email: string): Promise<string> {
  const outcome = await logins.signIn(email, PASSWORD);

  expect(outcome.status).toBe('CODE_SENT');

  const digits = /\b(\d{6})\b/.exec(mailer.last().text);
  expect(digits).not.toBeNull();

  return digits![1];
}

/** Signs in in one step, asserting that no code was asked for. */
async function signedInDirectly(email: string): Promise<SignedIn> {
  const outcome = await logins.signIn(email, PASSWORD);

  expect(outcome.status).toBe('SIGNED_IN');
  return outcome as { status: 'SIGNED_IN' } & SignedIn;
}

/** The challenge as it stands on the row, which nothing above the repository sees. */
async function challengeRow(employeeId: string) {
  const { rows } = await admin.query<{
    hash: string | null;
    expires: Date | null;
    attempts: number;
  }>(
    `SELECT mfa_code_hash AS hash, mfa_code_expires_at AS expires, mfa_code_attempts AS attempts
       FROM app_user WHERE employee_id = $1`,
    [employeeId],
  );

  return rows[0];
}

describe('who is asked for a code', () => {
  it('does not ask an ordinary employee', async () => {
    await withPassword(people.officer);

    await signedInDirectly(OFFICER_EMAIL);
    expect(mailer.sent).toHaveLength(0);
  });

  it.each([
    ['the HR Administrator', 'headOfHr', HR_ADMIN_EMAIL],
    ['the HR Officer', 'hrOfficer', HR_OFFICER_EMAIL],
  ])('asks %s, whose account never opted in', async (_label, key, email) => {
    /* The story's third criterion. Neither has mfa_enabled set — the seed sets it
       on nobody — and both are asked anyway, because the role decides. */
    await withPassword(people[key]);
    const before = await logins.forEmployee(system, people[key]);
    expect(before?.mfaEnabled).toBe(false);

    const outcome = await logins.signIn(email, PASSWORD);

    expect(outcome).toMatchObject({ status: 'CODE_SENT', companyEmail: email });
  });

  it('asks an ordinary employee who has asked to be asked', async () => {
    await withPassword(people.officer);
    await logins.requireCode(system, people.officer);

    expect(await logins.signIn(OFFICER_EMAIL, PASSWORD)).toMatchObject({ status: 'CODE_SENT' });
  });

  it('starts asking the moment a role is granted, with nothing else changed', async () => {
    /* Read from user_role at the moment they sign in, never copied onto the
       account. LMS 111 will grant roles through a service; whatever it writes,
       this is true the next time they sign in. */
    await withPassword(people.officer);
    await signedInDirectly(OFFICER_EMAIL);

    await admin.query(
      `INSERT INTO user_role (user_id, role_id)
       SELECT u.id, r.id FROM app_user u, role r
        WHERE u.employee_id = $1 AND r.code = 'HR_OFFICER'`,
      [people.officer],
    );

    expect(await logins.signIn(OFFICER_EMAIL, PASSWORD)).toMatchObject({ status: 'CODE_SENT' });
  });

  it('stops asking the moment the role is taken away', async () => {
    await withPassword(people.headOfHr);
    expect(await logins.signIn(HR_ADMIN_EMAIL, PASSWORD)).toMatchObject({ status: 'CODE_SENT' });

    await admin.query(
      `DELETE FROM user_role ur USING app_user u, role r
        WHERE ur.user_id = u.id AND ur.role_id = r.id
          AND u.employee_id = $1 AND r.code = 'HR_ADMIN'`,
      [people.headOfHr],
    );

    await signedInDirectly(HR_ADMIN_EMAIL);
  });

  it('holds the same role codes the database does', async () => {
    /* MANDATORY_ROLES is matched exactly against the `role` table. A role renamed
       in one place and not the other would make the code silently optional for
       somebody it is mandatory for, which is not a failure anybody would notice. */
    const seeded = (await roles.list()).map((role) => role.code);

    for (const code of MANDATORY_ROLES) {
      expect(seeded).toContain(code);
    }
  });

  it('says whether somebody will be asked, and whether they get a choice', async () => {
    expect(await logins.codePolicyFor(system, people.officer)).toEqual({
      required: false,
      mandatory: false,
    });
    expect(await logins.codePolicyFor(system, people.headOfHr)).toEqual({
      required: true,
      mandatory: true,
    });

    await logins.requireCode(system, people.officer);
    expect(await logins.codePolicyFor(system, people.officer)).toEqual({
      required: true,
      mandatory: false,
    });
  });
});

describe('turning the code off', () => {
  it('lets an ordinary employee turn off what they turned on', async () => {
    await logins.requireCode(system, people.officer);
    await logins.stopRequiringCode(system, people.officer);

    await withPassword(people.officer);
    await signedInDirectly(OFFICER_EMAIL);
  });

  it('refuses to turn it off for somebody whose role requires it', async () => {
    const error = await rejection(() => logins.stopRequiringCode(system, people.headOfHr));

    expect(error).toBeInstanceOf(CodeIsMandatory);
    expect(error.message).toContain('HR_ADMIN');
  });

  it('leaves it genuinely on after refusing', async () => {
    // A switch that reports off while the thing is on is worse than one that
    // refuses.
    await rejection(() => logins.stopRequiringCode(system, people.headOfHr));

    await withPassword(people.headOfHr);
    expect(await logins.signIn(HR_ADMIN_EMAIL, PASSWORD)).toMatchObject({ status: 'CODE_SENT' });
  });
});

describe('the code that is sent', () => {
  it('goes to the company address and nowhere else', async () => {
    // The story's first criterion. The address is the login's, which the
    // sign-in-account-rules migration ties to the employee record.
    await withPassword(people.headOfHr);
    await logins.signIn(HR_ADMIN_EMAIL, PASSWORD);

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.last().to).toBe(HR_ADMIN_EMAIL);
  });

  it('follows a corrected work address, like everything else about the login', async () => {
    await withPassword(people.headOfHr);
    const corrected = 'ama.mensah-darko@rematholdings.com';

    await employees.update(system, people.headOfHr, { workEmail: corrected });
    await logins.signIn(corrected, PASSWORD);

    expect(mailer.last().to).toBe(corrected);
  });

  it('is stored hashed, with an expiry, and never in the clear', async () => {
    // The story's second criterion, checked in the column rather than in the API.
    await withPassword(people.headOfHr);
    const code = await codeSentTo(HR_ADMIN_EMAIL);

    const row = await challengeRow(people.headOfHr);

    expect(row.hash).not.toBeNull();
    expect(row.hash).not.toContain(code);
    expect(row.hash).toMatch(/^scrypt\$/);
    expect(row.expires).toBeInstanceOf(Date);
    expect(row.expires!.getTime()).toBeGreaterThan(Date.now());
    expect(row.attempts).toBe(0);
  });

  it('is a different code every time', async () => {
    await withPassword(people.headOfHr);

    const first = await codeSentTo(HR_ADMIN_EMAIL);
    const second = await codeSentTo(HR_ADMIN_EMAIL);

    expect(first).not.toBe(second);
  });

  it('is not sent to somebody who got the password wrong', async () => {
    /* Asked last on purpose. Sending before the password is proved would make
       this method a way of posting a message into any colleague's mailbox as
       often as you like. */
    await withPassword(people.headOfHr);

    await expect(logins.signIn(HR_ADMIN_EMAIL, 'not the password')).rejects.toThrow(SignInRefused);
    expect(mailer.sent).toHaveLength(0);
  });

  it('is not sent to a leaver, whatever roles they hold', async () => {
    await withPassword(people.headOfHr);
    await employees.terminate(system, people.headOfHr, { exitDate: '2026-09-30' });

    await expect(logins.signIn(HR_ADMIN_EMAIL, PASSWORD)).rejects.toMatchObject({
      reason: 'EMPLOYMENT_ENDED',
    });
    expect(mailer.sent).toHaveLength(0);
  });

  it('leaves no challenge behind when the message cannot be sent', async () => {
    /* Written before sent, so a failure to send leaves a challenge nobody can
       answer rather than a code nobody has a record of. The failure comes out
       rather than being swallowed: "we have sent you a code" when nothing was
       sent is the worst of the three outcomes. */
    await withPassword(people.headOfHr);
    mailer.failNext();

    await expect(logins.signIn(HR_ADMIN_EMAIL, PASSWORD)).rejects.toThrow(/SMTP/);

    // The row does hold a challenge, and it is answerable by nobody, which is the
    // cheap failure of the two. It expires on its own.
    expect((await challengeRow(people.headOfHr)).hash).not.toBeNull();
  });
});

describe('answering the code', () => {
  it('opens the door', async () => {
    await withPassword(people.headOfHr);
    const code = await codeSentTo(HR_ADMIN_EMAIL);

    const { employee, account } = await logins.submitCode(HR_ADMIN_EMAIL, code);

    expect(employee.workEmail).toBe(HR_ADMIN_EMAIL);
    expect(account.lastLoginAt).not.toBeNull();
  });

  it('does not care about the whitespace around it', async () => {
    await withPassword(people.headOfHr);
    const code = await codeSentTo(HR_ADMIN_EMAIL);

    await expect(logins.submitCode(HR_ADMIN_EMAIL, `  ${code}  `)).resolves.toBeDefined();
  });

  it('works once', async () => {
    // The story's fourth criterion. The challenge is consumed by the same
    // statement that stamps the sign in.
    await withPassword(people.headOfHr);
    const code = await codeSentTo(HR_ADMIN_EMAIL);

    await logins.submitCode(HR_ADMIN_EMAIL, code);

    expect((await challengeRow(people.headOfHr)).hash).toBeNull();
    await expect(logins.submitCode(HR_ADMIN_EMAIL, code)).rejects.toMatchObject({
      reason: 'NO_CHALLENGE',
    });
  });

  it('leaves the older code dead when a second is issued', async () => {
    /* Two codes in flight for one account would mean the older one still opens
       the door, which is exactly the code an attacker fishing in a mailbox
       already has. */
    await withPassword(people.headOfHr);
    const first = await codeSentTo(HR_ADMIN_EMAIL);
    const second = await codeSentTo(HR_ADMIN_EMAIL);

    await expect(logins.submitCode(HR_ADMIN_EMAIL, first)).rejects.toMatchObject({
      reason: 'WRONG_CODE',
    });
    await expect(logins.submitCode(HR_ADMIN_EMAIL, second)).resolves.toBeDefined();
  });

  it('refuses a code that has expired, and clears it', async () => {
    await withPassword(people.headOfHr);
    const code = await codeSentTo(HR_ADMIN_EMAIL);

    // Moved back rather than waiting ten minutes. The expiry is a column, and
    // this is the one thing only the database can be asked about honestly.
    await admin.query(
      `UPDATE app_user SET mfa_code_expires_at = now() - interval '1 second'
        WHERE employee_id = $1`,
      [people.headOfHr],
    );

    await expect(logins.submitCode(HR_ADMIN_EMAIL, code)).rejects.toMatchObject({
      reason: 'EXPIRED',
    });

    // A dead challenge is cleared as it is found, so the resting state of those
    // columns is honestly "nobody is half way through signing in".
    expect((await challengeRow(people.headOfHr)).hash).toBeNull();
  });

  it('refuses when no code was ever sent', async () => {
    await withPassword(people.officer);

    await expect(logins.submitCode(OFFICER_EMAIL, '123456')).rejects.toMatchObject({
      reason: 'NO_CHALLENGE',
    });
  });

  it('refuses a personal address before looking anything up', async () => {
    await expect(logins.submitCode('somebody@gmail.com', '123456')).rejects.toThrow(
      /not a company address/i,
    );
  });
});

describe('guessing the code', () => {
  it('counts every wrong answer and says how many are left', async () => {
    await withPassword(people.headOfHr);
    await codeSentTo(HR_ADMIN_EMAIL);

    const first = await refusedCode(() => logins.submitCode(HR_ADMIN_EMAIL, '000000'));

    expect(first.reason).toBe('WRONG_CODE');
    expect(first.message).toContain(`${MAX_CODE_ATTEMPTS - 1} attempts left`);
    expect((await challengeRow(people.headOfHr)).attempts).toBe(1);
  });

  it('burns the challenge after the last attempt', async () => {
    await withPassword(people.headOfHr);
    const code = await codeSentTo(HR_ADMIN_EMAIL);

    for (let attempt = 1; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      await expect(logins.submitCode(HR_ADMIN_EMAIL, '000000')).rejects.toMatchObject({
        reason: 'WRONG_CODE',
      });
    }

    await expect(logins.submitCode(HR_ADMIN_EMAIL, '000000')).rejects.toMatchObject({
      reason: 'TOO_MANY_ATTEMPTS',
    });

    // And the real code is dead with it. Six digits is a million guesses, and a
    // limit that leaves the code alive is not a limit.
    expect((await challengeRow(people.headOfHr)).hash).toBeNull();
    await expect(logins.submitCode(HR_ADMIN_EMAIL, code)).rejects.toMatchObject({
      reason: 'NO_CHALLENGE',
    });
  });

  it('counts guesses made at the same moment separately', async () => {
    /* A read, add and write would record one attempt where four were made, which
       is how a five attempt limit quietly becomes a twenty attempt one. The
       increment is decided by the database, once, per statement. */
    await withPassword(people.headOfHr);
    await codeSentTo(HR_ADMIN_EMAIL);

    await Promise.all(
      Array.from({ length: 4 }, () =>
        logins.submitCode(HR_ADMIN_EMAIL, '000000').catch(() => undefined),
      ),
    );

    expect((await challengeRow(people.headOfHr)).attempts).toBe(4);
  });

  it('gives a fresh set of attempts with a fresh code', async () => {
    await withPassword(people.headOfHr);
    await codeSentTo(HR_ADMIN_EMAIL);
    await logins.submitCode(HR_ADMIN_EMAIL, '000000').catch(() => undefined);

    const code = await codeSentTo(HR_ADMIN_EMAIL);

    expect((await challengeRow(people.headOfHr)).attempts).toBe(0);
    await expect(logins.submitCode(HR_ADMIN_EMAIL, code)).resolves.toBeDefined();
  });
});

describe('what changes between the two steps', () => {
  it('refuses a code issued to somebody who has since left', async () => {
    /* Minutes pass between the two steps, and the second is a door of its own.
       A code issued while somebody worked here must not let them in afterwards. */
    await withPassword(people.headOfHr);
    const code = await codeSentTo(HR_ADMIN_EMAIL);

    await employees.terminate(system, people.headOfHr, { exitDate: '2026-09-30' });

    await expect(logins.submitCode(HR_ADMIN_EMAIL, code)).rejects.toMatchObject({
      reason: 'EMPLOYMENT_ENDED',
    });
  });

  it('refuses a code issued to an account that has since been closed', async () => {
    await withPassword(people.headOfHr);
    const code = await codeSentTo(HR_ADMIN_EMAIL);

    await logins.close(system, people.headOfHr);

    await expect(logins.submitCode(HR_ADMIN_EMAIL, code)).rejects.toMatchObject({
      reason: 'ACCOUNT_CLOSED',
    });
  });
});

describe('what the database holds whatever is writing', () => {
  it('refuses a code with no expiry', async () => {
    // Either alone is meaningless: a hash with no expiry is a code that works
    // for ever, which is the one property a one time code exists not to have.
    await expect(
      admin.query(
        `UPDATE app_user SET mfa_code_hash = 'scrypt$x', mfa_code_expires_at = NULL
          WHERE employee_id = ${people.officer}`,
      ),
    ).rejects.toThrow(/app_user_code_and_expiry_together/);
  });

  it('refuses an expiry with no code', async () => {
    await expect(
      admin.query(
        `UPDATE app_user SET mfa_code_hash = NULL, mfa_code_expires_at = now()
          WHERE employee_id = ${people.officer}`,
      ),
    ).rejects.toThrow(/app_user_code_and_expiry_together/);
  });

  it('refuses a blank code hash', async () => {
    await expect(
      admin.query(
        `UPDATE app_user SET mfa_code_hash = '', mfa_code_expires_at = now()
          WHERE employee_id = ${people.officer}`,
      ),
    ).rejects.toThrow(/app_user_code_hash_not_blank/);
  });

  it('refuses a negative attempt count', async () => {
    // A value that would make "attempts >= the limit" false for ever.
    await expect(
      admin.query(
        `UPDATE app_user SET mfa_code_attempts = -1 WHERE employee_id = ${people.officer}`,
      ),
    ).rejects.toThrow(/app_user_code_attempts_not_negative/);
  });

  it('starts every login with no challenge in progress', async () => {
    const row = await challengeRow(people.officer);

    expect(row.hash).toBeNull();
    expect(row.expires).toBeNull();
    expect(row.attempts).toBe(0);
  });

  it('never hands a code hash to anything above the repository', async () => {
    await withPassword(people.headOfHr);
    await codeSentTo(HR_ADMIN_EMAIL);

    const account = await logins.forEmployee(system, people.headOfHr);

    expect(JSON.stringify(account)).not.toContain('scrypt');
    expect(Object.keys(account!)).not.toContain('mfaCodeHash');
  });
});

/** The {@link CodeRefused} a call produced, having asserted that it produced one. */
async function refusedCode(call: () => Promise<unknown>): Promise<CodeRefused> {
  const error = await rejection(call);

  expect(error).toBeInstanceOf(CodeRefused);
  return error as CodeRefused;
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
