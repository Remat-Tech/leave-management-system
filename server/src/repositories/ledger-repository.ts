/**
 * Database access for the balance ledger. FR 27, §5.7. LMS 210.
 *
 * Queries and row mapping, nothing else. What an entry means is ../domain/ledger.ts;
 * who may post one is ../services/ledger-service.ts.
 *
 * ## There is no update and no delete, and that is the file's shape
 *
 * Every other repository here has three verbs. This one has `post` and reads. Not
 * because the methods were left out but because there is nothing for them to call:
 * `lms_app` holds SELECT and INSERT on this table and nothing more, and
 * `refuse_update()` and `refuse_delete()` refuse the owner as well. A method here
 * would be a method that always throws, which is a worse way of saying the same
 * thing than not having one.
 *
 * {@link LedgerRepository.post} is therefore the only writer, and everything that
 * looks like a change goes through it as a new row.
 *
 * ## Refusals are translated rather than allowed to surface
 *
 * As in the holiday, leave year and entitlement rule repositories, and for the same
 * reason: checking first and writing afterwards is a race. A leave year closed
 * while somebody had a form open is the case that actually happens here — the
 * service checks and the trigger decides — and the write either side of that
 * instant has to be refused rather than accepted by whichever half of the second it
 * landed in.
 *
 * ## `days` arrives as text
 *
 * The one thing in this file worth reading before changing anything. `numeric`
 * comes back from the driver as a string so that precision is not lost, and
 * ../db/schema.ts types it that way on purpose — `'20.00' + '5.00'` is
 * `'20.005.00'`, and a type that let that compile would eventually let it ship.
 * {@link toEntry} is the one place it becomes a number.
 */

import type { Insertable, Kysely, Selectable } from 'kysely';
import type { Database } from '../db/index.js';
import type { LeaveLedgerEntryTable } from '../db/schema.js';
import type { Attribution } from '../domain/audit.js';
import {
  InvalidLedgerEntry,
  type LedgerEntry,
  type LedgerEntryType,
  type ValidatedLedgerEntry,
} from '../domain/ledger.js';
import { recording } from './recording.js';

/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';

/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';

/**
 * Postgres `restrict_violation`, which both of this table's triggers raise with a
 * constraint name of their own so that this file can recognise them the way it
 * recognises a real constraint.
 */
const RESTRICT_VIOLATION = '23001';

const SETTLED_YEARS = 'leave_ledger_entry_leaves_settled_years_alone';
const SAME_BALANCE = 'leave_ledger_entry_corrects_the_same_balance';

/**
 * Which field a refused row is reported against.
 *
 * Read from the constraint name the driver hands back rather than guessed from the
 * message, so a violation of some future constraint is re-thrown as itself rather
 * than blamed on whichever field this map happens to mention.
 */
const CHECKED_FIELDS: Record<string, string> = {
  leave_ledger_entry_type_known: 'entryType',
  leave_ledger_entry_reason_not_blank: 'reason',
  leave_ledger_entry_created_by_not_blank: 'reason',
  leave_ledger_entry_sign_matches_the_type: 'days',
  leave_ledger_entry_requests_move_whole_days: 'days',
  leave_ledger_entry_only_an_adjustment_corrects: 'entryType',
  leave_ledger_entry_corrects_another: 'correctsId',
  leave_ledger_entry_request_movements_name_a_request: 'leaveRequestId',
};

/** Which field a missing reference is reported against. */
const REFERENCED_FIELDS: Record<string, string> = {
  leave_ledger_entry_employee_id_fkey: 'employeeId',
  leave_ledger_entry_leave_type_id_fkey: 'leaveTypeId',
  leave_ledger_entry_leave_year_id_fkey: 'leaveYearId',
  leave_ledger_entry_corrects_id_fkey: 'correctsId',
  leave_ledger_entry_leave_request_id_fkey: 'leaveRequestId',
};

type LedgerRow = Selectable<LeaveLedgerEntryTable>;

/**
 * Which balance to read, and how much of it.
 *
 * `employeeId` is not optional and there is no method without it. A ledger read
 * across everybody is a report — FR 63's liability by department — and a report is
 * a query written for the figures it needs rather than a history screen with its
 * filter left off. Offering it here would make the expensive read the default one.
 */
export interface LedgerReadOptions {
  employeeId: string;
  leaveTypeId?: string;
  leaveYearId?: string;
  /** Only these kinds of movement. For separating certified sick days, FR 32b. */
  entryTypes?: readonly LedgerEntryType[];
}

export class LedgerRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Writes one entry. The only writer this table has.
   *
   * `created_by`, `created_by_employee_id` and `created_at` are not sent, and could
   * not be honoured if they were: `stamp_the_writer_on_a_ledger_entry()` overwrites
   * all three from the settings {@link recording} puts on the transaction. That is
   * the same seam the audit log reads, so an entry posted inside an audited write is
   * attributed to whoever was doing the writing.
   */
  async post(by: Attribution, entry: ValidatedLedgerEntry): Promise<LedgerEntry> {
    return this.catchRefusals(async () => {
      const row = await recording(this.db, by, (on) =>
        on
          .insertInto('leave_ledger_entry')
          .values(rowFor(entry))
          .returningAll()
          .executeTakeFirstOrThrow(),
      );

      return toEntry(row);
    });
  }

  /**
   * Several entries, in one transaction, attributed to one writer.
   *
   * A year rollover posts a `CARRY_FORWARD` and a `GRANT` together, and §8.6c's
   * reclassification posts a pair that only makes sense as a pair — half of either
   * landing is a balance that explains itself wrongly rather than not at all. So the
   * transaction is the unit, and {@link recording} composes with one that is already
   * open, which is what lets a caller wrap this in a wider piece of work.
   *
   * No service calls it yet, and it is here anyway rather than left to whichever
   * job needs it first. The reason is what a caller does without it: two `post()`
   * calls are two transactions, so half a rollover can land and a reclassification
   * can credit one balance and fail to debit the other. That is a property of the
   * ledger rather than of any one job, and a caller discovering it the hard way
   * discovers it as a balance nobody can explain. ../tests/integration/ledger.test.ts
   * is what exercises it.
   */
  async postAll(by: Attribution, entries: readonly ValidatedLedgerEntry[]): Promise<LedgerEntry[]> {
    if (entries.length === 0) {
      return [];
    }

    return this.catchRefusals(async () =>
      recording(this.db, by, async (on) => {
        const written: LedgerEntry[] = [];

        /* One statement at a time rather than a multi-row insert, because a
           correction may name an entry written earlier in the same call and the
           foreign key has to be able to find it. */
        for (const entry of entries) {
          written.push(
            toEntry(
              await on
                .insertInto('leave_ledger_entry')
                .values(rowFor(entry))
                .returningAll()
                .executeTakeFirstOrThrow(),
            ),
          );
        }

        return written;
      }),
    );
  }

  async findById(id: string): Promise<LedgerEntry | undefined> {
    const row = await this.db
      .selectFrom('leave_ledger_entry')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? undefined : toEntry(row);
  }

  /**
   * One balance's movements, oldest first.
   *
   * Ordered by `created_at` then `id`, which is `leave_ledger_entry_balance`'s own
   * order. The tie break is not decoration: a rollover writes two entries in one
   * transaction and `now()` is identical on both, so a sort on the timestamp alone
   * would order them differently on different reads — and an account that reorders
   * itself is one nobody can check twice.
   */
  async entriesFor(options: LedgerReadOptions): Promise<LedgerEntry[]> {
    let query = this.db
      .selectFrom('leave_ledger_entry')
      .selectAll()
      .where('employee_id', '=', options.employeeId);

    if (options.leaveTypeId !== undefined) {
      query = query.where('leave_type_id', '=', options.leaveTypeId);
    }
    if (options.leaveYearId !== undefined) {
      query = query.where('leave_year_id', '=', options.leaveYearId);
    }
    if (options.entryTypes !== undefined && options.entryTypes.length > 0) {
      query = query.where('entry_type', 'in', [...options.entryTypes]);
    }

    return (await query.orderBy('created_at').orderBy('id').execute()).map(toEntry);
  }

  /**
   * The entries put right by this one, and the ones that put it right.
   *
   * Both directions in one read, because "is this figure the one that counts" is
   * the question somebody looking at a wrong-looking row actually has, and it is
   * unanswerable from either end alone.
   */
  async correctionsAround(id: string): Promise<LedgerEntry[]> {
    const rows = await this.db
      .selectFrom('leave_ledger_entry')
      .selectAll()
      .where((eb) => eb.or([eb('corrects_id', '=', id), eb('id', '=', id)]))
      .orderBy('created_at')
      .orderBy('id')
      .execute();

    return rows.map(toEntry);
  }

  /**
   * Turns whatever the database refused a write for into the domain error for that
   * refusal.
   *
   * Every one of these is also checked in ../domain/ledger.ts, and reaching one here
   * means either a writer that did not come through the service or a race the
   * service cannot win — a leave year closed between the check and the write. The
   * database's own message is carried through in that case, because it names the
   * year and the day it was closed on, which is the half the person needs.
   */
  private async catchRefusals<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      const violation = violationOf(error);
      const said = error instanceof Error ? error.message : '';

      if (violation?.code === RESTRICT_VIOLATION) {
        if (violation.constraint === SETTLED_YEARS) {
          throw new InvalidLedgerEntry('leaveYearId', said);
        }
        if (violation.constraint === SAME_BALANCE) {
          throw new InvalidLedgerEntry('correctsId', said);
        }
      }

      if (violation?.code === CHECK_VIOLATION) {
        const field = CHECKED_FIELDS[violation.constraint];

        if (field !== undefined) {
          throw new InvalidLedgerEntry(field, said || `The entry breaks ${violation.constraint}.`);
        }
      }

      if (violation?.code === FOREIGN_KEY_VIOLATION) {
        const field = REFERENCED_FIELDS[violation.constraint];

        if (field !== undefined) {
          throw new InvalidLedgerEntry(
            field,
            'A ledger entry names an employee, a leave type and a leave year that all ' +
              'exist, because a movement filed under something that is not there is a ' +
              'movement no balance can be rebuilt from.',
          );
        }
      }

      throw error;
    }
  }
}

/**
 * The SQLSTATE and constraint name of a refusal, when the error carries both.
 *
 * The same shape as the other repositories', and separate from them for the same
 * reason they are separate from each other: no repository imports another, and a
 * shared copy of six lines would be the first thing to grow a parameter.
 */
function violationOf(error: unknown): { code: string; constraint: string } | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const { code, constraint } = error as { code?: unknown; constraint?: unknown };

  return typeof code === 'string' && typeof constraint === 'string'
    ? { code, constraint }
    : undefined;
}

/**
 * A validated entry as the columns it is written to.
 *
 * `days` goes down as a string, which is how the driver wants a `numeric` and is
 * the safe direction as well: a float bound to a `numeric` parameter is a value the
 * driver has already turned into the nearest double, and `toFixed(2)` sends the
 * figure that was validated rather than whatever survived that trip.
 *
 * The three stamped columns are absent. Sending them would achieve nothing —
 * `stamp_the_writer_on_a_ledger_entry()` overwrites all three — and their absence
 * here is what makes that unmistakable at the call site.
 */
function rowFor(entry: ValidatedLedgerEntry): Insertable<LeaveLedgerEntryTable> {
  return {
    employee_id: entry.employeeId,
    leave_type_id: entry.leaveTypeId,
    leave_year_id: entry.leaveYearId,
    entry_type: entry.entryType,
    days: entry.days.toFixed(2),
    reason: entry.reason,
    corrects_id: entry.correctsId,
    leave_request_id: entry.leaveRequestId,
  };
}

/**
 * A row as the domain sees it.
 *
 * The one place `days` stops being text. `Number('10.08')` is the nearest double to
 * ten and eight hundredths, which prints as `10.08` and compares as it should; what
 * it is not safe for is a long chain of additions, which is why nothing in
 * ../domain/ledger.ts adds a run of them without rounding back to the column's own
 * precision, and why a balance is summed by Postgres rather than in JavaScript.
 */
function toEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    employeeId: row.employee_id,
    leaveTypeId: row.leave_type_id,
    leaveYearId: row.leave_year_id,
    entryType: row.entry_type as LedgerEntryType,
    days: Number(row.days),
    reason: row.reason,
    correctsId: row.corrects_id,
    leaveRequestId: row.leave_request_id,
    createdBy: row.created_by,
    createdByEmployeeId: row.created_by_employee_id,
    createdAt: row.created_at,
  };
}
