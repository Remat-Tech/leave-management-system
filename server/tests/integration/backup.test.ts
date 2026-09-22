import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { databaseForThisFile } from '../setup/test-database.js';
import { backUp, compare, type Manifest, restore, RestoreRefused } from '../../src/db/backup.js';
import { seed } from '../../seeds/seed.mjs';

/** Backup and a verified restore. NFR AVL 02. Needs PG_BIN. */

const sourceUrl = await databaseForThisFile();
const adminUrl = inject('adminDatabaseUrl');
const pgBin = process.env.PG_BIN || undefined;

let directory: string;
let manifestPath: string;
let manifest: Manifest;
let restoredUrl: string;
let ids: { employee: string; leaveType: string; leaveYear: string };
const created: string[] = [];

/** lms_test_ prefix, so the run's teardown sweeps a leftover. */
function newDatabaseName(): string {
  const name = `lms_test_restore_${randomBytes(4).toString('hex')}`;
  created.push(name);
  return name;
}

async function onDatabase<T>(url: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function postGrant(client: Client, reason: string) {
  return client.query(
    `INSERT INTO leave_ledger_entry (employee_id, leave_type_id, leave_year_id, entry_type, days, reason)
     VALUES ($1, $2, $3, 'GRANT', '20.00', $4)`,
    [ids.employee, ids.leaveType, ids.leaveYear, reason],
  );
}

beforeAll(async () => {
  await onDatabase(sourceUrl, async (source) => {
    await seed(source);

    const { rows } = await source.query<typeof ids>(`
      SELECT (SELECT id FROM employee ORDER BY employee_number LIMIT 1) AS employee,
             (SELECT id FROM leave_type WHERE code = 'ANNUAL') AS "leaveType",
             (SELECT id FROM leave_year WHERE label = '2026') AS "leaveYear"`);
    ids = rows[0];

    await postGrant(source, 'before the backup');
  });

  directory = await mkdtemp(join(tmpdir(), 'lms-backup-'));
  ({ manifestPath, manifest } = await backUp({ databaseUrl: sourceUrl, directory, pgBin }));

  const report = await restore({ manifestPath, adminUrl, database: newDatabaseName(), pgBin });
  restoredUrl = report.databaseUrl;
}, 120_000);

afterAll(async () => {
  await onDatabase(adminUrl, async (admin) => {
    for (const name of created) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  });
  await rm(directory, { recursive: true, force: true });
});

describe('the backup', () => {
  it('records the ledger, the balances and the settings it was taken with', () => {
    expect(manifest.tables.leave_ledger_entry.rows).toBe(1);
    expect(manifest.tables.leave_balance.rows).toBe(1);
    expect(manifest.tables.pgmigrations.rows).toBeGreaterThan(0);
    expect(manifest.balancesThatDisagree).toBe(0);
    expect(manifest.settings).toContainEqual({ role: 'lms_app', setting: 'TimeZone=UTC' });
    expect(manifest.appGrants).not.toContain('leave_ledger_entry UPDATE');
  });

  it('is the moment it was taken, not what came after', async () => {
    await onDatabase(sourceUrl, (source) => postGrant(source, 'after the backup'));

    expect(await compare(manifest, restoredUrl)).toEqual([]);
    expect(await compare(manifest, sourceUrl)).toContain(
      'table leave_ledger_entry: 2 rows, backup had 1',
    );
  });
});

describe('a restore into a clean database', () => {
  it('matches the backup table by table', async () => {
    expect(await compare(manifest, restoredUrl)).toEqual([]);
  });

  it('keeps the ledger append only', async () => {
    await onDatabase(restoredUrl, async (owner) => {
      await expect(
        owner.query("UPDATE leave_ledger_entry SET reason = 'rewritten'"),
      ).rejects.toThrow();

      const { rows } = await owner.query<{ update: boolean; insert: boolean }>(`
        SELECT has_table_privilege('lms_app', 'leave_ledger_entry', 'UPDATE') AS update,
               has_table_privilege('lms_app', 'leave_ledger_entry', 'INSERT') AS insert`);
      expect(rows[0]).toEqual({ update: false, insert: true });
    });
  });

  it('has nothing left for migrations to do', async () => {
    const last = (url: string) =>
      onDatabase(url, async (client) => {
        const { rows } = await client.query<{ name: string }>(
          'SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1',
        );
        return rows[0].name;
      });

    expect(await last(restoredUrl)).toBe(await last(sourceUrl));
  });

  it('is noticed when it differs from the backup', async () => {
    const report = await restore({ manifestPath, adminUrl, database: newDatabaseName(), pgBin });

    await onDatabase(report.databaseUrl, async (owner) => {
      await postGrant(owner, 'not in the backup');
      await owner.query('DROP TRIGGER leave_ledger_entry_is_never_changed ON leave_ledger_entry');
    });

    const differences = await compare(manifest, report.databaseUrl);
    expect(differences).toContain('table leave_ledger_entry: 2 rows, backup had 1');
    expect(differences).toContain('table leave_balance: same row count, different contents');
    expect(
      differences.some((line) =>
        line.startsWith('trigger missing: leave_ledger_entry.leave_ledger_entry_is_never_changed'),
      ),
    ).toBe(true);
  });
});

describe('a restore refuses', () => {
  it('a dump that does not match its manifest', async () => {
    const copy = await mkdtemp(join(tmpdir(), 'lms-backup-corrupt-'));
    try {
      const dump = join(copy, manifest.dumpFile);
      await copyFile(join(directory, manifest.dumpFile), dump);
      await copyFile(manifestPath, join(copy, basename(manifestPath)));

      const bytes = await readFile(dump);
      bytes[bytes.length - 1] ^= 0xff;
      await writeFile(dump, bytes);

      const database = newDatabaseName();
      await expect(
        restore({ manifestPath: join(copy, basename(manifestPath)), adminUrl, database, pgBin }),
      ).rejects.toBeInstanceOf(RestoreRefused);

      await onDatabase(adminUrl, async (admin) => {
        const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
          database,
        ]);
        expect(rowCount).toBe(0);
      });
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('a database that already exists', async () => {
    const existing = new URL(restoredUrl).pathname.slice(1);

    await expect(
      restore({ manifestPath, adminUrl, database: existing, pgBin }),
    ).rejects.toBeInstanceOf(RestoreRefused);
    expect(await compare(manifest, restoredUrl)).toEqual([]);
  });
});
