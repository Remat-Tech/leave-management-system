/**
 * Database access for the cached balance. §5.7. LMS 211.
 *
 * Queries and row mapping, nothing else. What a balance means is
 * ../domain/balance.ts; who may read one is ../services/balance-service.ts.
 *
 * ## There is no writer at all, and that is the file's shape
 *
 * ../repositories/ledger-repository.ts has `post` and reads, and says why it has no
 * update and no delete. This one has reads. Not because the writers were left out
 * but because there is nothing for them to call: `lms_app` holds SELECT on
 * `leave_balance` and had its INSERT revoked, `refuse_a_balance_written_by_hand()`
 * refuses the owner as well, and ../db/schema.ts types every column `never` for
 * insert and update so that a write does not compile either.
 *
 * A balance moves when a ledger entry is posted, in that entry's transaction, by
 * `rebuild_one_balance_from_the_ledger()`. That is the whole of the second
 * acceptance criterion, and the reason it lives in the database rather than here is
 * that six of the eight entry types have no writer yet — a trigger cannot be
 * forgotten by a story that has not been written.
 *
 * ## An absent row is a balance of nought, not a missing record
 *
 * {@link BalanceRepository.forOne} never returns `undefined`. A row appears the
 * first time something moves a balance, so a key with no row is somebody whose
 * grant has not run yet, and "nought days, nothing has moved" is the true answer
 * rather than an absence for every caller to translate. See `noMovementsYet` in
 * ../domain/balance.ts, which is what makes "has this ever moved" still askable.
 *
 * ## The three figures arrive as text
 *
 * `numeric` comes back from the driver as a string so that precision is not lost,
 * and ../db/schema.ts types `entitled`, `carried_over` and `adjustment` that way on
 * purpose. `taken` and `pending` are `integer` and arrive as numbers, which is the
 * same distinction the columns are declared with: what somebody is owed may carry a
 * fraction, what they have taken may not. {@link toBalance} is the one place either
 * becomes a number this file's callers can add.
 */

import type { Kysely, Selectable } from 'kysely';
import type { Database } from '../db/index.js';
import type { LeaveBalanceTable } from '../db/schema.js';
import { type BalanceKey, type LeaveBalance, noMovementsYet } from '../domain/balance.js';

type BalanceRow = Selectable<LeaveBalanceTable>;

export class BalanceRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * One balance. Employee, leave type and leave year, which is all three of the
   * columns `leave_balance_one_per_year` holds unique, so this reads at most one
   * row.
   *
   * Returns a balance of nought where nothing has moved yet rather than
   * `undefined`; see the note at the top of this file.
   */
  async forOne(key: BalanceKey): Promise<LeaveBalance> {
    const row = await this.db
      .selectFrom('leave_balance')
      .selectAll()
      .where('employee_id', '=', key.employeeId)
      .where('leave_type_id', '=', key.leaveTypeId)
      .where('leave_year_id', '=', key.leaveYearId)
      .executeTakeFirst();

    return row === undefined ? noMovementsYet(key) : toBalance(row);
  }

  /**
   * Every balance this person has, oldest leave year first and in the order leave
   * types are shown in.
   *
   * `display_order` is §7.4's own ordering and the reason that column exists: the
   * order a balance screen lists annual, sick and compassionate leave in is a
   * decision somebody made rather than an alphabetical accident. The leave year
   * comes first because carried days mean an earlier year is still worth reading,
   * and it is ordered by the day the year starts rather than by its id — a company
   * that moves to an April start inserts a year whose id is newer than the year it
   * precedes.
   *
   * **Only balances something has moved.** A leave type this person has never had a
   * movement in has no row and does not appear here. Which types a screen should
   * offer anyway is a different question with real rules in it — `entitlement_basis`
   * for the ones that arrive with an event, `gender_restriction` for FR 05 — and it
   * belongs to the story that builds the screen rather than to a query that would
   * have to guess. {@link BalanceRepository.forOne} is what that screen asks once it
   * knows which types it is showing.
   */
  async forEmployee(employeeId: string, leaveYearId?: string): Promise<LeaveBalance[]> {
    let query = this.db
      .selectFrom('leave_balance')
      .innerJoin('leave_type', 'leave_type.id', 'leave_balance.leave_type_id')
      .innerJoin('leave_year', 'leave_year.id', 'leave_balance.leave_year_id')
      .selectAll('leave_balance')
      .where('leave_balance.employee_id', '=', employeeId);

    if (leaveYearId !== undefined) {
      query = query.where('leave_balance.leave_year_id', '=', leaveYearId);
    }

    const rows = await query
      .orderBy('leave_year.start_date')
      .orderBy('leave_type.display_order')
      .orderBy('leave_type.id')
      .execute();

    return rows.map(toBalance);
  }

  /**
   * Everybody's balances in one leave year, for the rollover and for FR 63's
   * liability report.
   *
   * `leave_balance_by_year` is exactly this read. It is here rather than left to the
   * story that reports, because the alternative to one method with a leave year on
   * it is a method with no filter at all — and the expensive read would become the
   * default one, which is the argument ../repositories/ledger-repository.ts makes
   * about `LedgerReadOptions.employeeId`.
   */
  async forYear(leaveYearId: string, leaveTypeId?: string): Promise<LeaveBalance[]> {
    let query = this.db
      .selectFrom('leave_balance')
      .selectAll()
      .where('leave_year_id', '=', leaveYearId);

    if (leaveTypeId !== undefined) {
      query = query.where('leave_type_id', '=', leaveTypeId);
    }

    return (await query.orderBy('leave_type_id').orderBy('employee_id').execute()).map(toBalance);
  }
}

/**
 * A row as the domain sees it.
 *
 * The one place the three accrued figures stop being text. `Number('10.08')` is the
 * nearest double to ten and eight hundredths, which prints and compares as it
 * should; what it is not safe for is a long chain of additions, which is why
 * ../domain/balance.ts rounds back to the columns' own precision after every sum it
 * performs, and why the five figures themselves are added up by Postgres.
 */
function toBalance(row: BalanceRow): LeaveBalance {
  return {
    employeeId: row.employee_id,
    leaveTypeId: row.leave_type_id,
    leaveYearId: row.leave_year_id,
    entitled: Number(row.entitled),
    carriedOver: Number(row.carried_over),
    adjustment: Number(row.adjustment),
    taken: row.taken,
    pending: row.pending,
    updatedAt: row.updated_at,
  };
}
