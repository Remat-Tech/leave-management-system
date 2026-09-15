/**
 * The first load: departments, then everybody, onto a database nobody can sign in to yet.
 *
 * A production database is migrated and never seeded, so it starts with no departments and no
 * employees — and nothing can be created through the application, because every door takes an
 * HR actor and there is nobody to be one. This is the way in, and it runs as the system.
 *
 *   npx tsx scripts/load-organisation.ts departments.csv employees.csv
 *   npx tsx scripts/load-organisation.ts departments.csv employees.csv --confirm
 *
 * **Departments are created on both runs**, because the staff file cannot be read without
 * them: a row naming a department that does not exist is rejected, so a dry run against an
 * empty database would reject every row and say nothing useful. Creating one is additive and
 * saying the same name twice does nothing, which is what makes that safe.
 *
 * **Nobody is written without --confirm.** The staff file goes through
 * `StaffImportService.dryRun`, which is FR 08's report; the same command with --confirm
 * applies exactly the plan that was shown, and is refused if the file changed in between.
 *
 * It refuses to run against a database that already has employees. After the first load,
 * everything here is HR's job through the screens.
 */

import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { config } from 'dotenv';
import { theSystem } from '../server/src/auth/actor.js';
import { Guard } from '../server/src/auth/policy.js';
import { databaseFor } from '../server/src/db/index.js';
import { Transactions } from '../server/src/db/transaction.js';
import { DepartmentRepository } from '../server/src/features/department/department.db.js';
import { DepartmentService } from '../server/src/features/department/department.service.js';
import { StaffImportService } from '../server/src/features/staff-import/staff-import.service.js';

config();

const actor = theSystem('the first load of the organisation');

async function main(): Promise<void> {
  const [departmentsFile, employeesFile] = process.argv.slice(2);
  const confirm = process.argv.includes('--confirm');

  if (!departmentsFile || !employeesFile) {
    throw new Error(
      'Usage: npx tsx scripts/load-organisation.ts <departments.csv> <employees.csv> [--confirm]',
    );
  }

  const url = process.env.DATABASE_MIGRATION_URL;

  if (url === undefined) {
    throw new Error('DATABASE_MIGRATION_URL is not set. This runs as the owner. See .env.example.');
  }

  /* Which database this is about to write to, said out loud. The usual mistake is a shell
     that never had DATABASE_MIGRATION_URL set, which quietly falls back to .env — and .env is
     somebody's development branch. */
  const target = new URL(url);
  process.stdout.write(`database: ${target.hostname}${target.pathname} as ${target.username}\n\n`);

  await refuseIfPeopleAreAlreadyHere(url);

  const db = databaseFor(url);
  const guard = new Guard();

  try {
    await loadDepartments(
      new DepartmentService(new DepartmentRepository(db), guard),
      departmentsFile,
    );
    await loadStaff(db, guard, employeesFile, confirm);
  } finally {
    await db.destroy();
  }

  if (!confirm) {
    process.stdout.write('\nNobody was imported. Run it again with --confirm to apply.\n');
  }
}

/**
 * The guard on running this twice.
 *
 * Also what makes the no-op below honest: nothing can need re-routing on a database with no
 * leave in it, and a second run would be re-routing real requests with a stub.
 */
async function refuseIfPeopleAreAlreadyHere(url: string): Promise<void> {
  const owner = new Client({ connectionString: url });
  await owner.connect();

  try {
    const { rows } = await owner.query<{ count: string }>('SELECT count(*) AS count FROM employee');

    if (rows[0].count !== '0') {
      throw new Error(
        `This database already has ${rows[0].count} employees. Add people through the ` +
          'application: this is only for the first load.',
      );
    }
  } finally {
    await owner.end();
  }
}

/** Name per line. The app's departments are flat, so a parent column is read and ignored. */
async function loadDepartments(departments: DepartmentService, file: string): Promise<void> {
  const wanted = (await readFile(file, 'utf8'))
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(',')[0]?.trim())
    .filter((name): name is string => Boolean(name));

  const existing = new Set(
    (await departments.list(actor)).map((department) => department.name.toLowerCase()),
  );

  for (const name of wanted) {
    if (existing.has(name.toLowerCase())) {
      process.stdout.write(`department, already there: ${name}\n`);
      continue;
    }

    await departments.create(actor, { name });

    process.stdout.write(`department, created: ${name}\n`);
  }
}

/** FR 08's dry run, and then the same plan applied. */
async function loadStaff(
  db: ReturnType<typeof databaseFor>,
  guard: Guard,
  file: string,
  confirm: boolean,
): Promise<void> {
  const source = await readFile(file, 'utf8');

  const imports = new StaffImportService(new Transactions(db), guard, {
    /* Nothing to follow and nothing to cancel: there is no leave on a database with no
       employees, which is what refuseIfPeopleAreAlreadyHere() above guarantees. */
    followTheReportingLine: () => Promise.resolve(undefined),
    cancelWhatIsPending: () => Promise.resolve(undefined),
  });

  const plan = await imports.dryRun(actor, source);

  process.stdout.write(
    `\nstaff: ${String(plan.creates.length)} to create, ${String(plan.changes.length)} to change, ` +
      `${String(plan.unchanged.length)} unchanged, ${String(plan.rejected.length)} rejected\n`,
  );

  for (const create of plan.creates) {
    process.stdout.write(`  create  ${create.employeeNumber}  ${create.fullName}\n`);
  }

  for (const row of plan.rejected) {
    process.stdout.write(
      `  REJECT  line ${String(row.line)}  ${row.employeeNumber ?? '(no number)'}  ` +
        `${row.field ?? 'row'}: ${row.reason}\n`,
    );
  }

  if (!confirm) {
    return;
  }

  if (plan.rejected.length > 0) {
    throw new Error('Nothing was imported: fix the rejected rows above and run it again.');
  }

  const outcome = await imports.confirm(actor, source, plan.fingerprint);

  process.stdout.write(`\nimported: ${String(outcome.created.length)} employees created\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
