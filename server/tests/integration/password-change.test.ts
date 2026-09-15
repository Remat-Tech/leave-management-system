import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { databaseForThisFile } from '../setup/test-database.js';
import { theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';
import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { RoleRepository } from '../../src/features/role/role.db.js';
import { SignInAccountRepository } from '../../src/features/sign-in/sign-in-account.db.js';
import { SignInService } from '../../src/features/sign-in/sign-in.service.js';
import { recordingMailer } from '../support/recording-mailer.js';
import { seed } from '../../seeds/seed.mjs';

/**
 * Replacing a password somebody else set. NFR SEC 01.
 *
 * The story is a first day: HR hands over a password, and until the owner replaces it two
 * people know it. What is proved here is that the replacement is the owner's own act — the
 * current password is asked for — and that nothing else opens in the meantime.
 */

const testDatabaseUrl = await databaseForThisFile();

const hr = theSystem('an HR administrator, in a test');
const FIRST = 'a password hr chose for them';
const THEIRS = 'a password only they know';

let db: Kysely<Database>;
let admin: Client;
let logins: SignInService;
let accounts: SignInAccountRepository;
let people: Record<string, string>;

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
    new Guard(),
  );
});

afterAll(async () => {
  await admin.end();
  await db.destroy();
});

beforeEach(async () => {
  people = (await seed(admin)) as Record<string, string>;
});

/** The employee used throughout: an ordinary one, so no code stands in the way. */
function anEmployee(): string {
  return people.officer;
}

describe('a password HR set', () => {
  it('has to be changed, and says so on the account', async () => {
    await logins.setPassword(hr, anEmployee(), FIRST);

    const account = await accounts.findByEmployeeId(anEmployee());

    expect(account?.mustChangePassword).toBe(true);
  });

  it('is marked the same way when the login is created with one', async () => {
    /* The provisioning script hands a password over as it creates the login, which is the
       other way one arrives already known to somebody else. LMS 109. */
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO employee (
         employee_number, first_name, last_name, work_email, job_title,
         department_id, manager_id, work_pattern_id, start_date
       )
       SELECT 'RH-9001', 'Joiner', 'Onthefirstday', 'joiner@rematholdings.com', 'Newcomer',
              department_id, id, work_pattern_id, CURRENT_DATE
         FROM employee WHERE id = $1
       RETURNING id`,
      [people.ceo],
    );

    const account = await logins.provision(hr, rows[0].id, { password: FIRST });

    expect(account.mustChangePassword).toBe(true);
  });

  it('still signs them in, because the change is what they sign in to do', async () => {
    await logins.setPassword(hr, anEmployee(), FIRST);

    const outcome = await logins.signIn('adwoa.frimpong@rematholdings.com', FIRST);

    expect(outcome.status).toBe('SIGNED_IN');
  });
});

describe('changing it', () => {
  beforeEach(async () => {
    await logins.setPassword(hr, anEmployee(), FIRST);
  });

  /** The owner, as signing in produces them. */
  async function them() {
    const outcome = await logins.signIn('adwoa.frimpong@rematholdings.com', FIRST);

    if (outcome.status !== 'SIGNED_IN') {
      throw new Error('The fixture employee was asked for a code, which this story is not about.');
    }

    return outcome.actor;
  }

  it('clears the mark, so the rest of the system opens', async () => {
    await logins.changeMyPassword(await them(), FIRST, THEIRS);

    const account = await accounts.findByEmployeeId(anEmployee());

    expect(account?.mustChangePassword).toBe(false);
  });

  it('is the new password that works afterwards, and not the old one', async () => {
    await logins.changeMyPassword(await them(), FIRST, THEIRS);

    expect((await logins.signIn('adwoa.frimpong@rematholdings.com', THEIRS)).status).toBe(
      'SIGNED_IN',
    );

    // The old one is refused the way any wrong password is: one sentence, saying nothing.
    await expect(logins.signIn('adwoa.frimpong@rematholdings.com', FIRST)).rejects.toThrow();
  });

  it('is refused without the current password, which a stolen session does not have', async () => {
    const actor = await them();

    await expect(logins.changeMyPassword(actor, 'not their password', THEIRS)).rejects.toThrow(
      /not your current password/,
    );

    const account = await accounts.findByEmployeeId(anEmployee());
    expect(account?.mustChangePassword).toBe(true);
  });

  it('is refused for a password that is the one they already have', async () => {
    await expect(logins.changeMyPassword(await them(), FIRST, FIRST)).rejects.toThrow(
      /not already using/,
    );
  });

  it('is refused for one too short to be worth having', async () => {
    await expect(logins.changeMyPassword(await them(), FIRST, 'short')).rejects.toThrow(/at least/);
  });

  it('is nobody else’s to do, whatever they hold', async () => {
    // hr is theSystem, which holds every role there is — and still may not.
    await expect(logins.changeMyPassword(hr, FIRST, THEIRS)).rejects.toThrow();
  });
});
