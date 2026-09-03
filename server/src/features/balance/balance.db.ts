/** Database access for the cached balance. §5.7., LMS 211, FR 26, §8.2. */

import { type Kysely, type Selectable, sql } from 'kysely';
import type { Database } from '../../db/index.js';
import type { LeaveBalanceTable } from '../../db/schema.js';
import { type BalanceKey, type LeaveBalance, noMovementsYet } from './balance.js';

type BalanceRow = Selectable<LeaveBalanceTable>;

export class BalanceRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** One balance. */
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

  /** One balance, held still until the transaction ends. §8.2, FR 26, LMS 212. */
  async holdStill(key: BalanceKey): Promise<LeaveBalance> {
    const held = await sql<BalanceRow>`
      SELECT * FROM hold_one_balance_while_it_is_checked(
        ${key.employeeId}, ${key.leaveTypeId}, ${key.leaveYearId})
    `.execute(this.db);

    const row = held.rows[0];

    return row === undefined ? noMovementsYet(key) : toBalance(row);
  }

  /**
   * Several named balances in one statement. LMS 404.
   *
   * {@link BalanceRepository.forOne} for a list of keys, so a screen showing many people's
   * figures at once — the approver queue — asks once rather than once per row. A key nothing
   * has moved has no row and does not come back; the caller reads that as `noMovementsYet`, as
   * `forOne` does for a single key.
   */
  async forKeys(keys: readonly BalanceKey[]): Promise<LeaveBalance[]> {
    if (keys.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom('leave_balance')
      .selectAll()
      .where((eb) =>
        eb.or(
          keys.map((key) =>
            eb.and([
              eb('employee_id', '=', key.employeeId),
              eb('leave_type_id', '=', key.leaveTypeId),
              eb('leave_year_id', '=', key.leaveYearId),
            ]),
          ),
        ),
      )
      .execute();

    return rows.map(toBalance);
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
   * default one, which is the argument ../features/balance/ledger.db.ts makes
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
 * ../features/balance/balance.ts rounds back to the columns' own precision after every sum it
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
