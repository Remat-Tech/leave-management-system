import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';
import type { GlobalSetupContext } from 'vitest/node';

loadEnv();

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
    testDatabaseName: string;
  }
}

/**
 * Integration tests run against a database that exists only for the length of
 * the run. It is created here, brought up to date with the same migrations that
 * production uses, and dropped again when the suite finishes.
 *
 * Using the real migrations rather than a dumped schema is deliberate: it means
 * every integration run is also a test that the migrations still apply cleanly
 * to an empty database.
 *
 * TEST_DATABASE_URL is read first, and it exists because of what this suite
 * costs over a network. Every test reloads the fixture organisation, which is
 * two dozen statements, and the suite is several thousand round trips end to
 * end. Against a Neon branch in London each of those costs about a tenth of a
 * second and the run takes eleven minutes; against a local Postgres it is a
 * fraction of a millisecond and the same work takes well under one. The
 * database is doing no more work in either case — the network is the entire
 * difference.
 *
 * It is a key of its own rather than a change to DATABASE_MIGRATION_URL so that
 * the two can differ, which is the arrangement the README asks for: local is the
 * fast loop, and Neon stays where migrations are applied and where anything that
 * has to look like production goes. Falling back keeps every existing setup and
 * continuous integration working untouched.
 *
 * Whichever it is, it must be the owner connection and the same PostgreSQL major
 * version as production, which is 17. Creating a database is not something the
 * application role may do, and a suite that passes on a version production does
 * not run has proved less than it appears to.
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

  const name = `lms_test_${randomBytes(6).toString('hex')}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // The identifier is generated above, not taken from input, but quoting it
    // costs nothing and keeps the habit.
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${name}`;
  const testDatabaseUrl = testUrl.toString();

  try {
    // A fixed command string, so there is nothing to escape and no argument
    // array passed through a shell. Windows cannot spawn npm.cmd without one.
    execSync('npm run migrate up', {
      env: { ...process.env, DATABASE_MIGRATION_URL: testDatabaseUrl },
      stdio: 'pipe',
    });
  } catch (error) {
    await dropDatabase(adminUrl, name);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Migrations failed against the test database.\n${detail}`, {
      cause: error,
    });
  }

  provide('testDatabaseUrl', testDatabaseUrl);
  provide('testDatabaseName', name);

  // Teardown. Runs even when tests fail, so a failing suite does not leave a
  // database behind on every run.
  return async () => {
    await dropDatabase(adminUrl, name);
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
