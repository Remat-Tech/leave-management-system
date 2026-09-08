/**
 * Sets a password on a seeded account, so a developer can sign in. Not for production.
 *
 * The seed gives everybody a login and nobody a password — `app_user.password_hash` is null
 * and `signIn` refuses with NO_PASSWORD — because a fixture organisation with a known password
 * in it is a fixture organisation somebody deploys. This puts one on a single named account,
 * one run at a time.
 *
 *   npx tsx scripts/dev-login.ts kofi.boateng@rematholdings.com 'a password'
 *
 * It goes through `SignInService.setPassword` rather than writing the column, so the hash is
 * whatever the application makes of it and the account's own rules are enforced.
 */

import { Client } from 'pg';
import { config } from 'dotenv';
import { theSystem } from '../server/src/auth/actor.js';
import { Guard } from '../server/src/auth/policy.js';
import { databaseFor } from '../server/src/db/index.js';
import { EmployeeRepository } from '../server/src/features/employee/employee.db.js';
import { RoleRepository } from '../server/src/features/role/role.db.js';
import { SignInAccountRepository } from '../server/src/features/sign-in/sign-in-account.db.js';
import { SignInService } from '../server/src/features/sign-in/sign-in.service.js';

config();

async function main(): Promise<void> {
  const [email, password] = process.argv.slice(2);

  if (email === undefined || password === undefined) {
    throw new Error("Usage: npx tsx scripts/dev-login.ts <work email> '<password>'");
  }

  const url = process.env.DATABASE_MIGRATION_URL;

  if (url === undefined) {
    throw new Error('DATABASE_MIGRATION_URL is not set. See .env.example.');
  }

  const owner = new Client({ connectionString: url });
  await owner.connect();

  const { rows } = await owner.query<{ id: string; name: string }>(
    "SELECT id::text, first_name || ' ' || last_name AS name FROM employee WHERE work_email = $1",
    [email],
  );

  const employee = rows[0];
  await owner.end();

  if (employee === undefined) {
    throw new Error(`No employee has the work email ${email}. Has the seed been run?`);
  }

  const db = databaseFor(url);

  const logins = new SignInService(
    new SignInAccountRepository(db),
    new EmployeeRepository(db),
    new RoleRepository(db),
    /* Nothing in setPassword sends mail, so the mailer is never reached. */
    { send: async () => undefined } as never,
    new Guard(),
  );

  try {
    await logins.setPassword(theSystem('a developer setting up a sign in'), employee.id, password);
    process.stdout.write(`${employee.name} can now sign in as ${email}.\n`);
  } finally {
    await db.destroy();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
