/**
 * Running several repositories on one transaction.
 *
 * Every other write in this system is one statement, and none of them needed
 * this. A staff import does: FR 08 says nothing is written until the dry run is
 * confirmed, and four hundred rows written one autocommitted statement at a time
 * would leave the two hundred and thirtieth failure with two hundred and
 * twenty-nine people already in the table and no way back. All of it lands or
 * none of it does, and the only way to say that is one transaction.
 *
 * The transaction lives here rather than in the service because of the layering
 * rule in the README: only /db and /repositories know what the query layer is.
 * A service that opened its own transaction would be importing Kysely, and the
 * next one would too. What a service gets instead is
 * {@link Transactions.allOrNothing}, which hands it the ordinary repositories —
 * bound, for the length of the callback, to one connection inside one
 * transaction.
 *
 * That is what makes {@link StaffImportService} able to reuse
 * {@link EmployeeService} rather than reimplementing its rules against a bulk
 * insert. Every row of the import goes through the same checks a single joiner
 * typed into a form goes through, sees the rows the earlier lines of the same
 * file wrote, and rolls all of them back together if the last line is wrong.
 * Reimplementing those rules for the import path is the alternative, and it is
 * the alternative in which the import and the form disagree about what a valid
 * record is.
 */

import type { Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import { BalanceRepository } from './balance-repository.js';
import { DepartmentRepository } from './department-repository.js';
import { EmployeeRepository } from './employee-repository.js';
import { LeaveTypeRepository } from './leave-type-repository.js';
import { LedgerRepository } from './ledger-repository.js';
import { WorkPatternRepository } from './work-pattern-repository.js';

/**
 * The repositories a service is handed, all of them on the same connection.
 *
 * Named for what they are rather than gathered into some general registry: this
 * is the set the employee rules need, which is the set the import needs, and a
 * story that needs a different one adds it here rather than making this generic.
 */
export interface Repositories {
  employees: EmployeeRepository;
  departments: DepartmentRepository;
  patterns: WorkPatternRepository;
  /**
   * The three a balance movement needs. LMS 212.
   *
   * `BalanceService` is the second caller this seam has, and it wants the same
   * property the import does for a different reason. There it is four hundred rows
   * that have to land together; here it is four statements that have to have nobody
   * in between them — hold the balance still, read it, decide, write the movement —
   * which is FR 26 and §8.2. A transaction is what makes a lock last longer than a
   * statement, so the seam that owns transactions is where the lock has to be
   * reachable from.
   *
   * `types` is here because the one rule that varies is a column on the leave type —
   * whether the balance may be exceeded, FR 32a — and reading it outside the window
   * would be reading it a moment before the decision it feeds.
   */
  balances: BalanceRepository;
  entries: LedgerRepository;
  types: LeaveTypeRepository;
}

export class Transactions {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Runs `work` inside one transaction. Everything it writes commits together,
   * or nothing does.
   *
   * Whatever `work` returns is returned; whatever it throws rolls the
   * transaction back and comes out unchanged, so a caller catches
   * {@link InvalidEmployee} and {@link ManagerCycle} exactly as it would outside
   * one.
   *
   * Reads are worth running in here too, even though they write nothing. Inside
   * a transaction they see one consistent picture of the table, which is what a
   * dry run wants: a report where half the rows were judged against the
   * organisation as it was before a colleague's edit and half against the
   * organisation afterwards is a report of an import that would never have
   * happened.
   */
  async allOrNothing<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) =>
      work({
        employees: new EmployeeRepository(trx),
        departments: new DepartmentRepository(trx),
        patterns: new WorkPatternRepository(trx),
        balances: new BalanceRepository(trx),
        entries: new LedgerRepository(trx),
        types: new LeaveTypeRepository(trx),
      }),
    );
  }
}
