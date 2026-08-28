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
 * arranges it.
 *
 * This is half of a bargain and {@link inUtc} is the other half. Handing the
 * characters back untouched is only safe while the characters are `YYYY-MM-DD`,
 * and which characters the server sends is a session setting. NFR DAT 03,
 * LMS 114.
 */
function keepDatesAsDates(): void {
  pg.types.setTypeParser(DATE_OID, (value: string) => value);
}

/**
 * Every connection this application opens speaks UTC and ISO dates.
 * NFR DAT 03. LMS 114.
 *
 * Two settings, and neither is about how anything is stored. A `timestamptz` is
 * held as UTC whatever the session says and a `date` has no zone to hold. What
 * these decide is what the session does to a value on the way past:
 *
 *   `TimeZone` is the zone a `timestamptz` is *rendered* in, and the zone
 *   `current_date` means. The rendering is not cosmetic here, because the audit
 *   log keeps it: `record_in_audit_log()` snapshots a changed row with
 *   `to_jsonb()`, and the same change made from two hosts in two zones would be
 *   stored as two different strings and read as a difference by
 *   {@link changedFields}.
 *
 *   `DateStyle` is the form a `date` is rendered in. `ISO, YMD` is what makes
 *   {@link keepDatesAsDates} true rather than usually true: a host set to
 *   `German, DMY` sends `01.09.2026`, the parser passes it through untouched,
 *   and every date comparison in `/domain` — all of which are string
 *   comparisons — quietly begins comparing the day of the month first.
 *
 * The timestamps-in-utc migration sets the same two on the role and on the
 * database, which is the layer that covers psql and the seed. This one covers
 * the application on a database where that migration has not run, or where the
 * host would not permit the `ALTER DATABASE`, and it costs one statement per
 * physical connection.
 *
 * On the pool's `connect` rather than around every query: node-postgres emits it
 * once per new client, before that client is handed to whoever asked for it, and
 * queues queries per client in order — so this runs first and nothing after it
 * on that connection sees anything else.
 *
 * The only way the statement fails is a connection that is already broken, and
 * the answer is still to close it rather than let it back into the pool. A
 * client that is up and silently on the wrong zone is the one outcome worth
 * ruling out, because everything it went on to write would look right.
 */
function inUtc(pool: pg.Pool): pg.Pool {
  pool.on('connect', (client) => {
    client.query("SET TIME ZONE 'UTC'; SET DateStyle = 'ISO, YMD'").catch((error: unknown) => {
      console.error('Could not put a database connection into UTC. NFR DAT 03.', error);
      void client.end().catch(() => {});
    });
  });

  return pool;
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
      pool: inUtc(new pg.Pool({ connectionString })),
    }),
  });
}
