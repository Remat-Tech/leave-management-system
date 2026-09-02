import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';
import type { ProvidedContext } from 'vitest';

loadEnv();

/**
 * What `globalSetup` is handed, named structurally.
 *
 * Vitest 4 no longer exports `GlobalSetupContext`, and importing it was a type error
 * this file carried. Only `provide` is used, and declaring that is both enough and
 * stable across the versions that have moved the type around.
 */
interface GlobalSetupContext {
  provide: <K extends keyof ProvidedContext>(key: K, value: ProvidedContext[K]) => void;
}

declare module 'vitest' {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
    templateDatabaseName: string;
  }
}

/**
 * Migrates one template database for the whole run. Each test file then copies it.
 *
 * Using the real migrations rather than a dumped schema is deliberate: it means every
 * integration run is also a test that the migrations still apply cleanly to an empty
 * database.
 *
 * ## Why a template rather than one shared database
 *
 * Every file used to share a single database, which meant `fileParallelism: false` —
 * thirty one files strictly one after another. Measured on this schema, a migration
 * costs about 1.4 seconds and `CREATE DATABASE ... TEMPLATE` about 0.9, so giving each
 * file a database of its own is cheaper than the serialisation it removes: the files
 * then run across every core instead of one.
 *
 * The copy is made in ./test-database.ts, once per file, and dropped when that file
 * finishes. Nothing connects to the template after this function returns, which is what
 * lets it be copied — PostgreSQL refuses to use a database as a template while any
 * session is connected to it.
 *
 * TEST_DATABASE_URL is read first, and it exists because of what this suite costs over
 * a network. Every test reloads the fixture organisation, which is about 170ms of
 * statements, and the suite is several thousand round trips end to end. Against a Neon
 * branch in London each of those costs about a tenth of a second; against a local
 * PostgreSQL it is a fraction of a millisecond. The database is doing no more work in
 * either case — the network is the entire difference.
 *
 * It is a key of its own rather than a change to DATABASE_MIGRATION_URL so that the two
 * can differ, which is the arrangement the README asks for: local is the fast loop, and
 * Neon stays where migrations are applied and where anything that has to look like
 * production goes.
 *
 * Whichever it is, it must be the owner connection and the same PostgreSQL major version
 * as production, which is 17. Creating a database is not something the application role
 * may do, and a suite that passes on a version production does not run has proved less
 * than it appears to.
 */
export default async function setup({ provide }: GlobalSetupContext) {
  const adminUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_MIGRATION_URL;
  if (!adminUrl) {
    throw new Error(
      'Neither TEST_DATABASE_URL nor DATABASE_MIGRATION_URL is set. Integration ' +
        'tests need an owner connection so they can create and drop a database. ' +
        'See .env.example.',
    );
  }

  const template = `lms_template_${randomBytes(6).toString('hex')}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // The identifier is generated above, not taken from input, but quoting it
    // costs nothing and keeps the habit.
    await admin.query(`CREATE DATABASE "${template}"`);
  } finally {
    await admin.end();
  }

  const templateUrl = new URL(adminUrl);
  templateUrl.pathname = `/${template}`;

  try {
    // A fixed command string, so there is nothing to escape and no argument
    // array passed through a shell. Windows cannot spawn npm.cmd without one.
    execSync('npm run migrate up', {
      env: { ...process.env, DATABASE_MIGRATION_URL: templateUrl.toString() },
      stdio: 'pipe',
    });
  } catch (error) {
    await dropDatabase(adminUrl, template);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Migrations failed against the test database.\n${detail}`, {
      cause: error,
    });
  }

  provide('adminDatabaseUrl', adminUrl);
  provide('templateDatabaseName', template);

  // Teardown. Runs even when tests fail, so a failing suite does not leave a
  // database behind on every run.
  return async () => {
    await dropCopies(adminUrl);
    await dropDatabase(adminUrl, template);
  };
}

async function dropDatabase(adminUrl: string, name: string) {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // FORCE closes any connection a failed test left open, which would
    // otherwise make the drop hang and leak the database.
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/**
 * Any per-file copy whose own teardown did not run.
 *
 * A worker killed mid-file — a crash, or Ctrl-C — leaves its database behind, and the
 * next run would accumulate another. They all carry the same prefix, so the sweep is
 * exact and touches nothing else on the server.
 */
async function dropCopies(adminUrl: string) {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'lms_test_%'",
    );
    for (const { datname } of rows) {
      await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}
