import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, inject } from 'vitest';

/**
 * A database of this test file's own, copied from the template ./integration-database.ts
 * migrated once for the run.
 *
 * Called at the top of each integration file, in place of the `inject('testDatabaseUrl')`
 * that used to hand every file the same database. That sharing is what forced
 * `fileParallelism: false`, and one file at a time is most of what the suite costs: the
 * work is a few hundred milliseconds a test, almost none of it the database's.
 *
 * A copy rather than a fresh migration because it is faster — about 0.9 seconds against
 * 1.4 — and because it cannot drift: every file starts from the same migrated schema
 * and the same reference data, which is exactly what the shared database gave them.
 *
 * The copy is dropped when the file finishes, whether or not its tests passed. A worker
 * that dies before that leaves one behind, and the run's teardown sweeps those.
 */
export async function databaseForThisFile(): Promise<string> {
  const adminUrl = inject('adminDatabaseUrl');
  const template = inject('templateDatabaseName');
  const name = `lms_test_${randomBytes(6).toString('hex')}`;

  await onAdmin(adminUrl, async (admin) => {
    /* PostgreSQL takes a lock on the template for the length of the copy, so files
       starting at the same moment queue here rather than fail. Nothing connects to the
       template after the migration, which is the condition being relied on: a template
       with a live session on it cannot be copied at all. */
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    await copySettings(admin, template, name);
  });

  afterAll(async () => {
    await onAdmin(adminUrl, async (admin) => {
      // FORCE closes anything a failed test left open, which would hang the drop.
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    });
  });

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * The `ALTER DATABASE` settings, which a template copy does not bring with it.
 *
 * `CREATE DATABASE ... TEMPLATE` copies the schema and every row, but per-database
 * settings live in `pg_db_role_setting` keyed by the database's OID and are left behind.
 * The timestamps-in-UTC migration sets `TimeZone` and `DateStyle` both on the database
 * and on `lms_app`, so without this a copy would answer in the server's local timezone —
 * which is the one thing that migration exists to prevent, and it would go unnoticed
 * everywhere except the file that asserts it.
 *
 * Replayed from the template rather than restated here, so a migration that sets another
 * one is carried without this file being touched.
 */
async function copySettings(admin: Client, template: string, name: string) {
  const { rows } = await admin.query<{ rolname: string | null; setconfig: string[] | null }>(
    `SELECT roles.rolname, settings.setconfig
       FROM pg_db_role_setting settings
       JOIN pg_database ON pg_database.oid = settings.setdatabase
       LEFT JOIN pg_roles roles ON roles.oid = settings.setrole
      WHERE pg_database.datname = $1`,
    [template],
  );

  for (const { rolname, setconfig } of rows) {
    for (const setting of setconfig ?? []) {
      const at = setting.indexOf('=');
      if (at === -1) continue;

      const key = setting.slice(0, at);
      const value = setting.slice(at + 1);

      /* These come from our own migrations, but the name goes into the statement
         unquoted because a GUC name cannot be a parameter, so it is checked. */
      if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) {
        throw new Error(`Refusing to copy a setting with an unexpected name: ${key}`);
      }

      const literal = `'${value.replaceAll("'", "''")}'`;
      const target =
        rolname === null ? `DATABASE "${name}"` : `ROLE "${rolname}" IN DATABASE "${name}"`;

      await admin.query(`ALTER ${target} SET ${key} = ${literal}`);
    }
  }
}

/** One owner connection, closed however the work ends. */
async function onAdmin(adminUrl: string, work: (admin: Client) => Promise<void>) {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await work(admin);
  } finally {
    await admin.end();
  }
}
