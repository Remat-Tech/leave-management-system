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
 */
export default async function setup({ provide }: GlobalSetupContext) {
  const adminUrl = process.env.DATABASE_MIGRATION_URL;
  if (!adminUrl) {
    throw new Error(
      'DATABASE_MIGRATION_URL is not set. Integration tests need the owner ' +
        'connection so they can create and drop a database. See .env.example.',
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
