/** The database connection. NFR AUD 02. */

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

export type { Database } from './schema.js';

/** `date`. */
const DATE_OID = 1082;

/** Calendar dates come back as the string the database holds. NFR DAT 03, LMS 114. */
function keepDatesAsDates(): void {
  pg.types.setTypeParser(DATE_OID, (value: string) => value);
}

/** Every connection this application opens speaks UTC and ISO dates. NFR DAT 03, LMS 114. */
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

/** The same database, for a connection string the caller already has. */
export function databaseFor(connectionString: string): Kysely<Database> {
  keepDatesAsDates();

  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: inUtc(new pg.Pool({ connectionString })),
    }),
  });
}
