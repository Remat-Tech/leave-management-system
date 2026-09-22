/**
 * Backs up the database at DATABASE_MIGRATION_URL.
 *
 *   npm run backup -- [directory]
 */

import { config } from 'dotenv';
import { backUp } from '../server/src/db/backup.js';

config();

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_MIGRATION_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_MIGRATION_URL is not set. See .env.example.');
  }

  const { manifestPath, manifest } = await backUp({
    databaseUrl,
    directory: process.argv[2] ?? 'backups',
    pgBin: process.env.PG_BIN || undefined,
  });

  const rows = Object.values(manifest.tables).reduce((sum, table) => sum + table.rows, 0);

  console.log(manifestPath);
  console.log(
    `${Object.keys(manifest.tables).length} tables, ${rows} rows, ${manifest.dumpBytes} bytes`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
