/** Backups and a verified restore. NFR AVL 02. */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from 'pg';

export interface TableFingerprint {
  rows: number;
  sha256: string;
}

export interface RoleSetting {
  role: string | null;
  setting: string;
}

/** What a restore must reproduce. */
export interface DatabaseState {
  tables: Record<string, TableFingerprint>;
  triggers: string[];
  appGrants: string[];
  settings: RoleSetting[];
  balancesThatDisagree: number;
}

export interface Manifest extends DatabaseState {
  takenAt: string;
  sourceDatabase: string;
  serverVersion: string;
  dumpFile: string;
  dumpSha256: string;
  dumpBytes: number;
}

export interface RestoreReport {
  database: string;
  databaseUrl: string;
  seconds: number;
  tables: number;
  rows: number;
}

export class RestoreRefused extends Error {}

export class RestoreDoesNotMatch extends Error {
  constructor(readonly differences: string[]) {
    super(`The restore does not match its backup:\n  ${differences.join('\n  ')}`);
  }
}

/** Dump and manifest from one snapshot. */
export async function backUp(options: {
  databaseUrl: string;
  directory: string;
  pgBin?: string;
}): Promise<{ manifestPath: string; manifest: Manifest }> {
  await mkdir(options.directory, { recursive: true });

  const takenAt = new Date();
  const stem = `lms-${takenAt.toISOString().replace(/[:.]/g, '-')}`;
  const dumpFile = `${stem}.dump`;
  const dumpPath = join(options.directory, dumpFile);

  const source = await connect(options.databaseUrl);
  let state: DatabaseState;
  let about: { database: string; version: string };

  try {
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const exported = await source.query<{ snapshot: string }>(
      'SELECT pg_export_snapshot() AS snapshot',
    );

    state = await stateOf(source);
    about = (
      await source.query<{ database: string; version: string }>(
        "SELECT current_database() AS database, current_setting('server_version') AS version",
      )
    ).rows[0];

    await run(
      tool('pg_dump', options.pgBin),
      [
        '--format=custom',
        '--no-owner',
        `--snapshot=${exported.rows[0].snapshot}`,
        `--file=${dumpPath}`,
      ],
      options.databaseUrl,
    );

    await source.query('COMMIT');
  } finally {
    await source.end();
  }

  const manifest: Manifest = {
    takenAt: takenAt.toISOString(),
    sourceDatabase: about.database,
    serverVersion: about.version,
    dumpFile,
    dumpSha256: await sha256Of(dumpPath),
    dumpBytes: (await stat(dumpPath)).size,
    ...state,
  };

  const manifestPath = join(options.directory, `${stem}.manifest.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { manifestPath, manifest };
}

/** Into a database that must not exist yet, then verified against the manifest. */
export async function restore(options: {
  manifestPath: string;
  adminUrl: string;
  database: string;
  pgBin?: string;
}): Promise<RestoreReport> {
  const started = performance.now();
  const { database } = options;

  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database)) {
    throw new RestoreRefused(`"${database}" is not a plain lower case database name.`);
  }

  const manifest = JSON.parse(await readFile(options.manifestPath, 'utf8')) as Manifest;
  const dumpPath = join(dirname(options.manifestPath), manifest.dumpFile);

  if ((await sha256Of(dumpPath)) !== manifest.dumpSha256) {
    throw new RestoreRefused(`${manifest.dumpFile} does not match the checksum in its manifest.`);
  }

  const admin = await connect(options.adminUrl);
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (existing.rowCount !== 0) {
      throw new RestoreRefused(`${database} already exists. Restore into a clean database.`);
    }

    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    // As the restricted-application-role migration. No password.
    await admin.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lms_app') THEN
          CREATE ROLE lms_app LOGIN;
        END IF;
      END
      $$`);
  } finally {
    await admin.end();
  }

  const targetUrl = new URL(options.adminUrl);
  targetUrl.pathname = `/${database}`;
  const databaseUrl = targetUrl.toString();

  try {
    await restoreDump(dumpPath, databaseUrl, options.pgBin);
    await replayWhatADumpLeavesOut(databaseUrl, database, manifest.settings);
  } catch (error) {
    await dropDatabase(options.adminUrl, database);
    throw error;
  }

  const differences = await compare(manifest, databaseUrl);
  if (differences.length > 0) {
    // Kept for inspection.
    throw new RestoreDoesNotMatch(differences);
  }

  const rows = Object.values(manifest.tables).reduce((sum, table) => sum + table.rows, 0);

  return {
    database,
    databaseUrl,
    seconds: Math.round((performance.now() - started) / 100) / 10,
    tables: Object.keys(manifest.tables).length,
    rows,
  };
}

/** Every difference between a database and a manifest. Empty means verified. */
export async function compare(manifest: Manifest, databaseUrl: string): Promise<string[]> {
  const client = await connect(databaseUrl);
  let actual: DatabaseState;
  try {
    actual = await stateOf(client);
  } finally {
    await client.end();
  }

  const differences: string[] = [];

  const names = new Set([...Object.keys(manifest.tables), ...Object.keys(actual.tables)]);
  for (const name of [...names].sort()) {
    const expected = manifest.tables[name];
    const found = actual.tables[name];

    if (expected === undefined) differences.push(`table ${name}: not in the backup`);
    else if (found === undefined) differences.push(`table ${name}: missing`);
    else if (expected.rows !== found.rows)
      differences.push(`table ${name}: ${found.rows} rows, backup had ${expected.rows}`);
    else if (expected.sha256 !== found.sha256)
      differences.push(`table ${name}: same row count, different contents`);
  }

  differences.push(...listDifference('trigger', manifest.triggers, actual.triggers));
  differences.push(...listDifference('lms_app grant', manifest.appGrants, actual.appGrants));
  differences.push(
    ...listDifference(
      'setting',
      manifest.settings.map(settingText),
      actual.settings.map(settingText),
    ),
  );

  if (manifest.balancesThatDisagree !== actual.balancesThatDisagree) {
    differences.push(
      `balances disagreeing with the ledger: ${actual.balancesThatDisagree}, backup had ${manifest.balancesThatDisagree}`,
    );
  }

  return differences;
}

/* ------------------------------------------------------------------- state */

async function stateOf(client: Client): Promise<DatabaseState> {
  // Row text depends on these.
  await client.query(`
    SET TimeZone = 'UTC';
    SET DateStyle = 'ISO, YMD';
    SET IntervalStyle = 'postgres';
    SET extra_float_digits = 1;
    SET bytea_output = 'hex'`);

  const names = await client.query<{ name: string }>(`
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     ORDER BY c.relname`);

  const tables: Record<string, TableFingerprint> = {};
  for (const { name } of names.rows) {
    // COLLATE "C": the restore server's default collation may differ.
    const { rows } = await client.query<TableFingerprint>(`
      SELECT count(*)::int AS rows,
             encode(sha256(convert_to(
               coalesce(string_agg(t::text, E'\\n' ORDER BY t::text COLLATE "C"), ''),
               'UTF8')), 'hex') AS sha256
        FROM public."${name.replaceAll('"', '""')}" AS t`);
    tables[name] = rows[0];
  }

  const triggers = await client.query<{ value: string }>(`
    SELECT c.relname || '.' || t.tgname || ' ' || t.tgenabled::text AS value
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
     ORDER BY 1`);

  // By privilege held, not by grantor, which differs after --no-owner.
  const appGrants = await client.query<{ value: string }>(`
    SELECT c.relname || ' ' || p.privilege AS value
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(privilege)
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
       AND has_table_privilege('lms_app', c.oid, p.privilege)
    UNION ALL
    SELECT 'function ' || f.oid::regprocedure::text
      FROM pg_proc f
      JOIN pg_namespace n ON n.oid = f.pronamespace
     WHERE n.nspname = 'public' AND has_function_privilege('lms_app', f.oid, 'EXECUTE')
    UNION ALL
    SELECT 'default ' || d.defaclobjtype::text || ' ' || a.privilege_type
      FROM pg_default_acl d
     CROSS JOIN aclexplode(d.defaclacl) AS a
     WHERE d.defaclnamespace = 'public'::regnamespace AND a.grantee = 'lms_app'::regrole
    UNION ALL
    SELECT 'database CONNECT'
     WHERE has_database_privilege('lms_app', current_database(), 'CONNECT')
     ORDER BY 1`);

  const settings = await client.query<RoleSetting>(`
    SELECT r.rolname AS role, unnest(s.setconfig) AS setting
      FROM pg_db_role_setting s
      JOIN pg_database d ON d.oid = s.setdatabase
      LEFT JOIN pg_roles r ON r.oid = s.setrole
     WHERE d.datname = current_database() AND (s.setrole = 0 OR r.rolname = 'lms_app')
     ORDER BY 1 NULLS FIRST, 2`);

  const disagreeing = await client.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM balances_that_disagree_with_the_ledger',
  );

  return {
    tables,
    triggers: triggers.rows.map((row) => row.value),
    appGrants: appGrants.rows.map((row) => row.value),
    settings: settings.rows,
    balancesThatDisagree: disagreeing.rows[0].count,
  };
}

function listDifference(label: string, expected: string[], actual: string[]): string[] {
  const found = new Set(actual);
  const wanted = new Set(expected);
  return [
    ...expected.filter((value) => !found.has(value)).map((value) => `${label} missing: ${value}`),
    ...actual
      .filter((value) => !wanted.has(value))
      .map((value) => `${label} not in the backup: ${value}`),
  ];
}

function settingText({ role, setting }: RoleSetting): string {
  return `${role ?? '(database)'} ${setting}`;
}

/* ----------------------------------------------------------------- restore */

async function restoreDump(dumpPath: string, databaseUrl: string, pgBin?: string) {
  const pgRestore = tool('pg_restore', pgBin);

  // DEFAULT ACL names the source owner role, which a clean server may not have.
  const list = await run(pgRestore, ['--list', dumpPath]);
  const listPath = join(tmpdir(), `lms-restore-${randomBytes(6).toString('hex')}.list`);
  await writeFile(
    listPath,
    list
      .split('\n')
      .filter((line) => !line.includes(' DEFAULT ACL '))
      .join('\n'),
  );

  try {
    await run(
      pgRestore,
      ['--no-owner', '--exit-on-error', '--single-transaction', `--use-list=${listPath}`, dumpPath],
      databaseUrl,
    );
  } finally {
    await rm(listPath, { force: true });
  }
}

/** Database and role level state pg_dump does not carry. */
async function replayWhatADumpLeavesOut(
  databaseUrl: string,
  database: string,
  settings: RoleSetting[],
) {
  const client = await connect(databaseUrl);
  try {
    await client.query(`GRANT CONNECT ON DATABASE "${database}" TO lms_app`);
    // As the restricted-application-role migration, for the restoring owner.
    await client.query(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO lms_app',
    );
    await client.query(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO lms_app',
    );

    for (const { role, setting } of settings) {
      const at = setting.indexOf('=');
      const key = setting.slice(0, at);
      if (at === -1 || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) {
        throw new RestoreRefused(`Refusing to replay the setting "${setting}".`);
      }

      const value = `'${setting.slice(at + 1).replaceAll("'", "''")}'`;
      const target =
        role === null ? `DATABASE "${database}"` : `ROLE "${role}" IN DATABASE "${database}"`;
      await client.query(`ALTER ${target} SET ${key} = ${value}`);
    }
  } finally {
    await client.end();
  }
}

async function dropDatabase(adminUrl: string, database: string) {
  const admin = await connect(adminUrl);
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/* ------------------------------------------------------------------ plumbing */

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/** PG_BIN, else PATH. Must be the server's major version. */
function tool(name: string, pgBin?: string): string {
  return pgBin ? join(pgBin, name) : name;
}

/** Password through the environment, not argv. */
function run(command: string, args: string[], databaseUrl?: string): Promise<string> {
  const env = { ...process.env };
  const fullArgs = [...args];

  if (databaseUrl !== undefined) {
    const url = new URL(databaseUrl);
    env.PGPASSWORD = decodeURIComponent(url.password);
    url.password = '';
    fullArgs.push(`--dbname=${url.toString()}`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, fullArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) =>
      reject(new Error(`Could not run ${command}. Set PG_BIN. ${error.message}`, { cause: error })),
    );
    child.on('close', (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${command} exited with ${code}.\n${stderr.trim()}`)),
    );
  });
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}
