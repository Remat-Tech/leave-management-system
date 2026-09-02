/** Database access for the nightly reconciliation. §7.4., LMS 213, §5.7. */

import { type Kysely, sql } from 'kysely';
import type { Database } from '../db/index.js';
import type { BalanceDisagreementView } from '../db/schema.js';
import type { BalanceDisagreement, FiveFigures } from '../domain/reconciliation.js';
import type { Selectable } from 'kysely';

type DisagreementRow = Selectable<BalanceDisagreementView>;

export class ReconciliationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /** Every balance the cache and the ledger do not agree about. */
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

  /** How many balances were compared. */
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

/** The five, whichever side they came from and whichever type the column was. */
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
