import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';

const testDatabaseUrl = await databaseForThisFile();
const testDatabaseName = new URL(testDatabaseUrl).pathname.slice(1);

let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: testDatabaseUrl });
  await db.connect();
});

afterAll(async () => {
  await db?.end();
});

describe('the disposable test database', () => {
  it('is a throwaway, not the development database', async () => {
    const { rows } = await db.query<{ current_database: string }>('select current_database()');

    expect(rows[0].current_database).toBe(testDatabaseName);
    expect(rows[0].current_database).toMatch(/^lms_test_[0-9a-f]{12}$/);
  });

  it('has had every migration applied to it', async () => {
    // Derived from the directory rather than hard coded, so adding a migration
    // does not break this test. It also makes the assertion the stronger one:
    // every migration on disk ran, not merely the ones somebody remembered.
    const onDisk = readdirSync(join(process.cwd(), 'server', 'migrations'))
      .filter((file) => file.endsWith('.sql'))
      .map((file) => file.replace(/\.sql$/, ''))
      .sort();

    const { rows } = await db.query<{ name: string }>('select name from pgmigrations order by id');

    expect(onDisk.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.name)).toEqual(onDisk);
  });
});

describe('the application role, NFR AUD 02', () => {
  it('may append to a new table but never rewrite or erase it', async () => {
    /* The default privilege itself, tested on a table nothing else touches.
       audit_log now exists and is asserted the same way in ./audit.test.ts; this
       is the more general claim, and the one that will still hold for
       leave_ledger_entry when Phase 2 creates it. The arrangement is what makes
       an append only table append only by nobody ever having granted it more —
       forget the explicit grant on an ordinary table and you get a loud
       permission error, which is the right way round. */
    await db.query('create table ledger_shaped (id bigserial primary key, days numeric(6,2))');

    const { rows } = await db.query<Record<string, boolean>>(
      `select has_table_privilege('lms_app', 'ledger_shaped', 'SELECT')   as sel,
              has_table_privilege('lms_app', 'ledger_shaped', 'INSERT')   as ins,
              has_table_privilege('lms_app', 'ledger_shaped', 'UPDATE')   as upd,
              has_table_privilege('lms_app', 'ledger_shaped', 'DELETE')   as del,
              has_table_privilege('lms_app', 'ledger_shaped', 'TRUNCATE') as trunc`,
    );

    expect(rows[0]).toEqual({ sel: true, ins: true, upd: false, del: false, trunc: false });
  });
});
