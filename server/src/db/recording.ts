/** Naming who is writing, so the audit trigger can record it. NFR AUD 01, LMS 113. */

import { type Kysely, sql } from 'kysely';
import type { Database } from './index.js';
import type { Attribution } from '../features/audit/audit.js';

/** Runs an audited write with the writer's name on it. */
export async function recording<T>(
  db: Kysely<Database>,
  by: Attribution,
  write: (on: Kysely<Database>) => Promise<T>,
): Promise<T> {
  if (db.isTransaction) {
    await nameTheWriter(db, by);
    return write(db);
  }

  return db.transaction().execute(async (trx) => {
    await nameTheWriter(trx, by);
    return write(trx);
  });
}

/** The two settings the audit trigger reads. */
async function nameTheWriter(on: Kysely<Database>, by: Attribution): Promise<void> {
  await sql`
    SELECT set_config('lms.audit.actor', ${by.description}, true),
           set_config('lms.audit.actor_employee_id', ${by.employeeId ?? ''}, true)
  `.execute(on);
}
