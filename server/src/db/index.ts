/**
 * The database connection.
 *
 * One pool per process, built here, handed to repositories. Nothing above the
 * repository layer imports Kysely or pg, so the query layer is a choice this
 * folder makes rather than one spread through the application.
 *
 * The connection is DATABASE_URL, which is the restricted `lms_app` role.
 * DATABASE_MIGRATION_URL is the owner and belongs to migrations, the seed and
 * the test harness. The application never uses it: an application connected as
 * the owner can rewrite its own audit trail, which is the one thing an audit
 * trail exists to prevent. NFR AUD 02.
 */

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

export type { Database } from './schema.js';

/** `date`. */
const DATE_OID = 1082;

/**
 * Calendar dates come back as the string the database holds.
 *
 * By default the driver parses a `date` into a JavaScript `Date`, which is an
 * instant: `2026-07-31` becomes midnight UTC, and every later read of it happens
 * in whatever timezone the process is set to. That is precisely the mixing up
 * the README calls the most common source of off by one day bugs in leave
 * systems, and it is not hypothetical here — the exit date on a leaver's record
 * and the start and end of every leave request are all `date` columns.
 *
 * So dates stay text and are compared as text, which for `YYYY-MM-DD` is the
 * same comparison. `timestamptz` is left alone: those are instants and a `Date`
 * is the right thing for them.
 *
 * Registered on the pg module rather than the pool, because that is the only
 * place the driver offers, and done here so that importing this module is what
 * arranges it. LMS 114 owns the wider rule; this is the part of it this story
 * cannot ship without.
 */
function keepDatesAsDates(): void {
  pg.types.setTypeParser(DATE_OID, (value: string) => value);
}

export function createDatabase(env: NodeJS.ProcessEnv = process.env): Kysely<Database> {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. See .env.example.');
  }

  return databaseFor(connectionString);
}

/**
 * The same database, for a connection string the caller already has.
 *
 * Integration tests use this: each run builds a database of its own and knows
 * its URL, and has no DATABASE_URL to read.
 */
export function databaseFor(connectionString: string): Kysely<Database> {
  keepDatesAsDates();

  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString }),
    }),
  });
}
