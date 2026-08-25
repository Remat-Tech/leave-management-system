import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const testDatabaseUrl = inject('testDatabaseUrl');
const testDatabaseName = inject('testDatabaseName');

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
    // Stands in for leave_ledger_entry and audit_log, which Phase 2 creates.
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
