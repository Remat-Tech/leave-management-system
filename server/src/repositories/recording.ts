/**
 * Naming who is writing, so the audit trigger can record it. NFR AUD 01.
 * LMS 113.
 *
 * The audit log is written by triggers — see the audit-log migration for why
 * that is the design rather than a service remembering to insert a row. A trigger
 * can see everything about a change except the one thing nobody in the database
 * knows: which person asked for it.
 *
 * So the application tells it, through a transaction-local setting. Every audited
 * write goes through {@link recording}, which opens a transaction, puts the
 * writer's name on it, and runs the write on that same connection. The trigger
 * fires inside it and reads the name back out.
 *
 * ## Why the transaction is a feature and not a cost
 *
 * `SET LOCAL` needs one, so this could look like plumbing forced by a mechanism.
 * It is the other way round. The change and the record of the change belong in
 * one transaction whatever the mechanism: an audit trail with a window in it —
 * where the row moved and the entry had not landed yet — is an audit trail that
 * is wrong exactly when somebody is investigating a crash. A transaction per
 * write is one round trip pair, and it buys the property the whole story is about.
 *
 * `SET LOCAL` rather than `SET` is the other half. The connection goes back to a
 * pool afterwards, and a session-level setting would still be on it when the next
 * request borrowed it — every unattributed write from then on would be recorded
 * as whoever last used that connection. Local ends at COMMIT, with nothing to
 * remember to reset.
 *
 * ## Composing with a transaction that is already open
 *
 * A staff import opens one transaction around four hundred rows and writes each
 * of them through {@link EmployeeService}. If this opened a transaction of its own
 * it would take a second connection out of the pool, write outside the import's
 * transaction, and block on the import's own uncommitted rows.
 *
 * So it asks. Kysely knows whether the handle it was given is a transaction, and
 * when it is, this sets the name and runs the write where it already is. The
 * setting is local to that outer transaction, so the four hundredth row is
 * attributed to the same officer as the first — and if the import rolls back, so
 * do all four hundred entries.
 */

import { type Kysely, sql } from 'kysely';
import type { Database } from '../db/index.js';
import type { Attribution } from '../domain/audit.js';

/**
 * Runs an audited write with the writer's name on it.
 *
 * `write` is handed the connection to run on, which is either a transaction this
 * opened or the one that was already open. A repository must use the handle it is
 * given here rather than its own `this.db`: the setting lives on one connection,
 * and a statement issued on another is a statement the trigger records as
 * unattributed.
 *
 * Whatever `write` throws rolls the transaction back and comes out unchanged, so
 * a caller catches {@link DuplicateEmployeeNumber} exactly as it would without
 * this.
 */
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

/**
 * The two settings the audit trigger reads.
 *
 * `set_config(..., true)` is `SET LOCAL` as a function, which is what lets the
 * values be bound parameters rather than interpolated into a statement. `SET
 * LOCAL lms.audit.actor = '...'` takes a literal and not a placeholder, so
 * building it as text would mean quoting a description by hand — which is an
 * injection waiting for the first person whose actor description contains an
 * apostrophe.
 *
 * An empty string for the id rather than a null, because `set_config` takes text
 * and the trigger turns blank back into null. The alternative is two statements
 * with a branch between them for the case that is not worth a branch.
 */
async function nameTheWriter(on: Kysely<Database>, by: Attribution): Promise<void> {
  await sql`
    SELECT set_config('lms.audit.actor', ${by.description}, true),
           set_config('lms.audit.actor_employee_id', ${by.employeeId ?? ''}, true)
  `.execute(on);
}
