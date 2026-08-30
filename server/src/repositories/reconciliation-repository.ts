/**
 * Database access for the nightly reconciliation. §7.4. LMS 213.
 *
 * Two reads and nothing else, and the "nothing else" is the story's third acceptance
 * criterion made structural rather than remembered.
 *
 * ## There is no writer, and there is no way to reach one from here
 *
 * ../repositories/balance-repository.ts also has no writer, for a different reason:
 * the table refuses one. This has no writer for a reason of its own, which is that the
 * job holding it must not be able to correct what it finds.
 *
 * `rebuild_one_balance_from_the_ledger()` is one function call away. It is correct, it
 * would put every disagreeing balance right, and calling it would make the report
 * empty every night. It would also destroy the only evidence that something in this
 * system does not work. So the reconciliation is handed this rather than the balance
 * repository — not because the extra methods would be *misused*, but because a job
 * that cannot correct is a claim somebody can check in one file.
 *
 * ## The comparison is a view, so there is no arithmetic here either
 *
 * `balances_that_disagree_with_the_ledger` is what the ledger says beside what the
 * cache says, with the rows that agree left out; `what_the_ledger_says` under it is
 * §5.7's projection, the same one `rebuild_one_balance_from_the_ledger()` writes
 * from. One definition, two readers. See the nightly-balance-reconciliation
 * migration.
 *
 * What this file does is turn text into numbers, which is the same job
 * ./ledger-repository.ts and ./balance-repository.ts do and for the same reason: a
 * `numeric` comes back from the driver as a string so that precision is not lost.
 * Both sides go through {@link figures} — the cache's two counts arrive as numbers
 * already, because they are `integer` columns, and `Number()` of a number is that
 * number.
 */

import { type Kysely, sql } from 'kysely';
import type { Database } from '../db/index.js';
import type { BalanceDisagreementView } from '../db/schema.js';
import type { BalanceDisagreement, FiveFigures } from '../domain/reconciliation.js';
import type { Selectable } from 'kysely';

type DisagreementRow = Selectable<BalanceDisagreementView>;

export class ReconciliationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Every balance the cache and the ledger do not agree about.
   *
   * Ordered by employee number and then by the order leave types are shown in, which
   * is the order a person reads a list of people in rather than the order the planner
   * happens to produce. A report whose lines move between runs is one nobody can
   * compare with yesterday's.
   */
  async disagreements(): Promise<BalanceDisagreement[]> {
    const rows = await this.db
      .selectFrom('balances_that_disagree_with_the_ledger')
      .selectAll()
      .orderBy('employee_number')
      .orderBy('leave_year_label')
      .orderBy('leave_type_name')
      .execute();

    return rows.map(toDisagreement);
  }

  /**
   * How many balances were compared.
   *
   * Both sides, because the two do not hold the same set and the difference is the
   * point: a balance the ledger knows about and the cache does not is exactly the
   * fault worth finding. A count of `leave_balance` alone would report a smaller
   * number on the night something went most wrong.
   */
  async balancesChecked(): Promise<number> {
    const counted = await sql<{ balances: string }>`
      SELECT count(*) AS balances FROM (
        SELECT employee_id, leave_type_id, leave_year_id FROM leave_balance
        UNION
        SELECT employee_id, leave_type_id, leave_year_id FROM what_the_ledger_says
      ) AS every_balance
    `.execute(this.db);

    return Number(counted.rows[0].balances);
  }
}

function toDisagreement(row: DisagreementRow): BalanceDisagreement {
  return {
    employeeId: row.employee_id,
    employeeNumber: row.employee_number,
    leaveTypeId: row.leave_type_id,
    leaveTypeName: row.leave_type_name,
    leaveYearId: row.leave_year_id,
    leaveYearLabel: row.leave_year_label,
    hasCachedRow: row.has_cached_row,
    cached: figures(
      row.cached_entitled,
      row.cached_carried_over,
      row.cached_adjustment,
      row.cached_taken,
      row.cached_pending,
    ),
    ledger: figures(
      row.ledger_entitled,
      row.ledger_carried_over,
      row.ledger_adjustment,
      row.ledger_taken,
      row.ledger_pending,
    ),
  };
}

/**
 * The five, whichever side they came from and whichever type the column was.
 *
 * `numeric` arrives as a string and `integer` as a number, which is the honest shape
 * of the view — the cache holds whole days in `taken` and `pending` and the ledger sums
 * them as `numeric`. One function for both sides so that the two are compared as
 * numbers rather than one of them by accident as text.
 */
function figures(
  entitled: string | number,
  carriedOver: string | number,
  adjustment: string | number,
  taken: string | number,
  pending: string | number,
): FiveFigures {
  return {
    entitled: Number(entitled),
    carriedOver: Number(carriedOver),
    adjustment: Number(adjustment),
    taken: Number(taken),
    pending: Number(pending),
  };
}
