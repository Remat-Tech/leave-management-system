/**
 * Restores a backup into a new database on BACKUP_RESTORE_URL's server, then verifies it. LMS 604.
 *
 *   npm run restore -- <manifest> [database]
 */

import { config } from 'dotenv';
import { restore } from '../server/src/db/backup.js';

config();

async function main(): Promise<void> {
  const [manifestPath, database = `lms_restore_${stamp()}`] = process.argv.slice(2);
  const adminUrl = process.env.BACKUP_RESTORE_URL;

  if (manifestPath === undefined) {
    throw new Error('Usage: npm run restore -- <manifest> [database]');
  }

  if (!adminUrl) {
    throw new Error('BACKUP_RESTORE_URL is not set. See .env.example.');
  }

  const report = await restore({
    manifestPath,
    adminUrl,
    database,
    pgBin: process.env.PG_BIN || undefined,
  });

  console.log(
    `Restored and verified ${report.database}: ${report.tables} tables, ${report.rows} rows, ${report.seconds}s`,
  );
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/\D/g, '');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
