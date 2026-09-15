/**
 * Gives people a login, a password and, where asked, a role.
 *
 * There is no screen for this yet and no route behind one, so a database that has just been
 * loaded has employees and nobody who can sign in. This is the way in, run as the system.
 *
 *   npx tsx scripts/provision-logins.ts                        # everybody without a login
 *   npx tsx scripts/provision-logins.ts --only RH-0009
 *   npx tsx scripts/provision-logins.ts --grant RH-0009:HR_ADMIN --grant RH-0009:SYS_ADMIN
 *
 * **Each password is printed once and never again**, because it is stored as a scrypt hash the
 * moment it is set. Hand them over in person or through something that is not email.
 *
 * **Each is also temporary**: a password somebody else chose is marked on the account, and the
 * owner is asked to replace it before anything else opens. NFR SEC 01. A forgotten password is
 * this script run again for that one person, since there is still no self service reset.
 */

import { randomBytes } from 'node:crypto';
import { config } from 'dotenv';
import { theSystem } from '../server/src/auth/actor.js';
import { Guard } from '../server/src/auth/policy.js';
import { databaseFor } from '../server/src/db/index.js';
import { EmployeeRepository } from '../server/src/features/employee/employee.db.js';
import { RoleRepository } from '../server/src/features/role/role.db.js';
import { RoleService } from '../server/src/features/role/role.service.js';
import { SignInAccountRepository } from '../server/src/features/sign-in/sign-in-account.db.js';
import { SignInService } from '../server/src/features/sign-in/sign-in.service.js';

config();

const actor = theSystem('provisioning the first logins');

async function main(): Promise<void> {
  const only = valueOf('--only');
  const grants = valuesOf('--grant').map(readGrant);

  const url = process.env.DATABASE_MIGRATION_URL;

  if (url === undefined) {
    throw new Error('DATABASE_MIGRATION_URL is not set. This runs as the owner. See .env.example.');
  }

  const target = new URL(url);
  process.stdout.write(`database: ${target.hostname}${target.pathname} as ${target.username}\n\n`);

  const db = databaseFor(url);
  const guard = new Guard();

  const employees = new EmployeeRepository(db);
  const accounts = new SignInAccountRepository(db);

  const logins = new SignInService(
    accounts,
    employees,
    new RoleRepository(db),
    /* Nothing used here sends mail. A sign in code does, and that is the running application. */
    { send: async () => undefined } as never,
    guard,
  );

  const roles = new RoleService(new RoleRepository(db), accounts, employees, guard);

  try {
    const everybody = await employees.list();
    const wanted =
      only === undefined ? everybody : everybody.filter((one) => one.employeeNumber === only);

    if (wanted.length === 0) {
      throw new Error(only === undefined ? 'There are no employees.' : `No employee is ${only}.`);
    }

    for (const employee of wanted) {
      const existing = await accounts.findByEmployeeId(employee.id);

      if (existing !== undefined) {
        process.stdout.write(
          `${employee.employeeNumber}  ${employee.workEmail}  (already had a login)\n`,
        );
        continue;
      }

      /* Long and random rather than memorable: it is typed once and changed by HR, and a
         password somebody can guess from the company name is the whole door. */
      const password = randomBytes(12).toString('base64url');

      await logins.provision(actor, employee.id, { password });

      process.stdout.write(`${employee.employeeNumber}  ${employee.workEmail}  ${password}\n`);
    }

    for (const grant of grants) {
      const employee = everybody.find((one) => one.employeeNumber === grant.employeeNumber);

      if (employee === undefined) {
        throw new Error(
          `No employee is ${grant.employeeNumber}, so ${grant.role} was not granted.`,
        );
      }

      const held = await roles.grant(actor, employee.id, grant.role);

      process.stdout.write(`\n${grant.employeeNumber} now holds ${held.join(', ')}\n`);
    }
  } finally {
    await db.destroy();
  }

  process.stdout.write(
    '\nPasswords are shown once, and each is temporary: the owner is asked to choose their own ' +
      'before anything else opens. Anyone holding an HR or System Administrator role is asked ' +
      'for an emailed code as well, so their mail has to work before they can get in.\n',
  );
}

function valueOf(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);

  return at === -1 ? undefined : process.argv[at + 1];
}

function valuesOf(flag: string): string[] {
  return process.argv.flatMap((argument, at) =>
    argument === flag && process.argv[at + 1] !== undefined ? [process.argv[at + 1]] : [],
  );
}

function readGrant(value: string): { employeeNumber: string; role: string } {
  const [employeeNumber, role] = value.split(':');

  if (!employeeNumber || !role) {
    throw new Error(
      `--grant takes <employee number>:<role>, for example RH-0009:HR_ADMIN. Got "${value}".`,
    );
  }

  return { employeeNumber, role };
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
