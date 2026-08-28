import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { Kysely } from 'kysely';

import { databaseFor } from '../../src/db/index.js';
import type { Database } from '../../src/db/schema.js';
import { CodeRefused } from '../../src/auth/mfa.js';
import { SignInRefused } from '../../src/auth/sign-in.js';
import { displayTimezone, formatInstant } from '../../src/domain/time.js';
import { createMailer } from '../../src/mail/mailer.js';
import { DepartmentRepository } from '../../src/repositories/department-repository.js';
import { EmployeeRepository } from '../../src/repositories/employee-repository.js';
import { RoleRepository } from '../../src/repositories/role-repository.js';
import { SignInAccountRepository } from '../../src/repositories/sign-in-account-repository.js';
import { WorkPatternRepository } from '../../src/repositories/work-pattern-repository.js';
import { EmployeeService } from '../../src/services/employee-service.js';
import { SignInService } from '../../src/services/sign-in-service.js';
import { seed } from '../../seeds/seed.mjs';
import { theSystem } from '../../src/auth/actor.js';
import { Guard } from '../../src/auth/policy.js';

/**
 * A walkthrough of signing in, for a person rather than for a build. LMS 109 and
 * LMS 110.
 *
 * It builds a disposable database of its own, so nothing you have is touched,
 * and it sends real mail through the real transport, so the codes land in
 * Mailpit and you can read them at http://localhost:8025 exactly as a member of
 * staff would read them in Outlook.
 *
 * Run it with:
 *   npm run mail                                   # in another terminal
 *   npx vitest run --config vitest.walkthrough.mts
 *
 * Needs local Postgres 17 (TEST_DATABASE_URL) and Mailpit. It is deliberately
 * outside both test configs: it prints rather than asserts, and a build should
 * not depend on a mail server being up.
 */

loadEnv();

const MAILPIT = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';
const PASSWORD = 'a passphrase nobody guesses';

const ADWOA = 'adwoa.frimpong@rematholdings.com';
const AMA = 'ama.mensah@rematholdings.com';

let adminUrl: string;
let databaseName: string;
let databaseUrl: string;

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
const system = theSystem('the sign in walkthrough');
const guard = new Guard();

let db: Kysely<Database>;
let admin: Client;
let logins: SignInService;
let employees: EmployeeService;
let people: Record<string, string>;

const mailer = createMailer();

function say(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** The most recent sign in code Mailpit has for an address. */
async function codeInMailbox(address: string): Promise<string> {
  const response = await fetch(
    `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address} sign in code`)}`,
  );
  const body = (await response.json()) as { messages: { Subject: string; Created: string }[] };

  const newest = body.messages.sort((a, b) => b.Created.localeCompare(a.Created))[0];
  if (newest === undefined) {
    throw new Error(`Mailpit has no sign in code for ${address}.`);
  }

  const digits = /^(\d+)\b/.exec(newest.Subject);
  if (digits === null) {
    throw new Error(`Could not find a code in the subject: ${newest.Subject}`);
  }

  return digits[1];
}

beforeAll(async () => {
  const reachable = await fetch(`${MAILPIT}/api/v1/info`).catch(() => null);
  if (!reachable?.ok) {
    throw new Error(`Mailpit is not answering at ${MAILPIT}. Start it with "npm run mail".`);
  }

  adminUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_MIGRATION_URL || '';
  if (!adminUrl) {
    throw new Error('Set TEST_DATABASE_URL (local Postgres 17) in .env.');
  }

  databaseName = `lms_walkthrough_${randomBytes(4).toString('hex')}`;

  const owner = new Client({ connectionString: adminUrl });
  await owner.connect();
  await owner.query(`CREATE DATABASE "${databaseName}"`);
  await owner.end();

  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();

  say();
  say(`Building a disposable database: ${databaseName}`);
  execSync('npm run migrate up', {
    env: { ...process.env, DATABASE_MIGRATION_URL: databaseUrl },
    stdio: 'pipe',
  });

  db = databaseFor(databaseUrl);
  admin = new Client({ connectionString: databaseUrl });
  await admin.connect();

  logins = new SignInService(
    new SignInAccountRepository(db),
    new EmployeeRepository(db),
    new RoleRepository(db),
    mailer,
    guard,
  );
  employees = new EmployeeService(
    new EmployeeRepository(db),
    new DepartmentRepository(db),
    new WorkPatternRepository(db),
    guard,
  );

  people = (await seed(admin)) as Record<string, string>;

  await logins.setPassword(system, people.officer, PASSWORD);
  await logins.setPassword(system, people.headOfHr, PASSWORD);

  say('Seeded the fixture organisation and set a password on two of them.');
  say();
});

afterAll(async () => {
  mailer.close();
  await db?.destroy();
  await admin?.end();

  const owner = new Client({ connectionString: adminUrl });
  await owner.connect();
  await owner.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await owner.end();

  say();
  say(`Dropped ${databaseName}. The mail is still in Mailpit at ${MAILPIT}.`);
  say();
});

describe('signing in', () => {
  it('1. an ordinary employee needs only a password', async () => {
    say('--- Adwoa Frimpong, Operations Officer. EMPLOYEE and nothing else. -----');

    const outcome = await logins.signIn(ADWOA, PASSWORD);

    say(`  signIn("${ADWOA}", <password>)`);
    say(`    -> ${outcome.status}`);
    say('    No code, no email. She is in.');
    say();
  });

  it('2. a personal address is refused, and told why', async () => {
    say('--- The other door: NFR SEC 01 ------------------------------------------');

    try {
      await logins.signIn('adwoa.frimpong@gmail.com', PASSWORD);
    } catch (error) {
      say('  signIn("adwoa.frimpong@gmail.com", <password>)');
      say(`    -> ${(error as Error).name}`);
      say(`    "${(error as Error).message}"`);
    }
    say();
  });

  it('3. a wrong password says nothing useful', async () => {
    try {
      await logins.signIn(ADWOA, 'not the password');
    } catch (error) {
      say('  signIn("adwoa...", "not the password")');
      say(`    -> ${(error as SignInRefused).name} (reason: ${(error as SignInRefused).reason})`);
      say(`    "${(error as Error).message}"`);
      say('    An unknown address gives this exact same sentence.');
    }
    say();
  });

  it('4. the HR Administrator is sent a code, without ever asking for one', async () => {
    say('--- Ama Mensah, Head of HR. Holds HR_ADMIN. ----------------------------');

    const policy = await logins.codePolicyFor(system, people.headOfHr);
    const account = await logins.forEmployee(system, people.headOfHr);

    say(`  Her account's own setting: mfaEnabled = ${account?.mfaEnabled}`);
    say(`  codePolicyFor -> required: ${policy.required}, mandatory: ${policy.mandatory}`);
    say('  The role decides, not the switch.');
    say();

    const outcome = await logins.signIn(AMA, PASSWORD);

    say(`  signIn("${AMA}", <password>)`);
    say(`    -> ${outcome.status}`);
    if (outcome.status === 'CODE_SENT') {
      say(`    sent to: ${outcome.companyEmail}`);
      say(`    expires: ${outcome.expiresAt.toISOString()}`);
    }
    say(`    Open ${MAILPIT} and you will see it arrive.`);
    say();
  });

  it('5. the code is a hash in the column, not a code', async () => {
    const { rows } = await admin.query<{ hash: string; expires: Date; attempts: number }>(
      `SELECT mfa_code_hash AS hash, mfa_code_expires_at AS expires, mfa_code_attempts AS attempts
         FROM app_user WHERE company_email = $1`,
      [AMA],
    );

    say('--- What the database is actually holding ------------------------------');
    say(`  mfa_code_hash       ${rows[0].hash.slice(0, 48)}...`);
    say(`  mfa_code_expires_at ${rows[0].expires.toISOString()}`);
    say(`  mfa_code_attempts   ${rows[0].attempts}`);
    say('  Nobody can read the code out of this table, including us.');
    say();

    /* NFR DAT 03, which has no screen to show itself on yet. The column is a
       timestamptz, the connection is pinned to UTC, and what a person is shown is
       the same instant said in the zone the company reads leave in. Change
       DISPLAY_TIMEZONE in .env and only the second line moves. */
    const zone = displayTimezone();

    say('--- The same instant, stored and shown. NFR DAT 03 ---------------------');
    say(`  stored (UTC)        ${rows[0].expires.toISOString()}`);
    say(`  shown (${zone})  ${formatInstant(rows[0].expires, zone)}`);
    say('  One instant. The zone is a setting; the row is not.');
    say();
  });

  it('6. a wrong code costs an attempt', async () => {
    say('--- Guessing -----------------------------------------------------------');

    for (const guess of ['000000', '111111']) {
      try {
        await logins.submitCode(AMA, guess);
      } catch (error) {
        say(`  submitCode("ama...", "${guess}")`);
        say(`    -> "${(error as CodeRefused).message}"`);
      }
    }

    const { rows } = await admin.query<{ attempts: number }>(
      'SELECT mfa_code_attempts AS attempts FROM app_user WHERE company_email = $1',
      [AMA],
    );
    say(`  mfa_code_attempts is now ${rows[0].attempts}. Five and the code is burned.`);
    say();
  });

  it('7. the real code, read from her mailbox, opens the door', async () => {
    const code = await codeInMailbox(AMA);

    say('--- The code that was actually emailed ---------------------------------');
    say(`  Mailpit has: ${code}`);

    const { employee } = await logins.submitCode(AMA, code);

    say(`  submitCode("ama...", "${code}")`);
    say(`    -> signed in as ${employee.firstName} ${employee.lastName} (${employee.jobTitle})`);
    say();

    // And again with the same code.
    try {
      await logins.submitCode(AMA, code);
    } catch (error) {
      say(`  submitCode("ama...", "${code}")   <- the same code, a second time`);
      say(`    -> ${(error as CodeRefused).reason}`);
      say(`    "${(error as Error).message}"`);
      say('    Single use. It was consumed by the sign in it opened.');
    }
    say();
  });

  it('8. access ends when employment does', async () => {
    say('--- Ama leaves ---------------------------------------------------------');

    const outcome = await logins.signIn(AMA, PASSWORD);
    say(`  signIn -> ${outcome.status}, a fresh code is in her mailbox.`);

    await employees.terminate(system, people.headOfHr, { exitDate: '2026-09-30' });
    say('  employees.terminate(system, ama, { exitDate: "2026-09-30" })');
    say('    Nothing was written to her login. Nothing needed to be.');

    const code = await codeInMailbox(AMA);
    try {
      await logins.submitCode(AMA, code);
    } catch (error) {
      say(`  submitCode("ama...", "${code}")   <- the code she was just sent`);
      say(`    -> ${(error as SignInRefused).reason}`);
      say(`    "${(error as Error).message}"`);
    }
    say();
  });
});
