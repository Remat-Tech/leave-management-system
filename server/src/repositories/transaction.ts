/** Running several repositories on one transaction. FR 08. */

import type { Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import { BalanceRepository } from './balance-repository.js';
import { DepartmentRepository } from './department-repository.js';
import { EmployeeRepository } from './employee-repository.js';
import { LeaveDecisionRepository } from './leave-decision-repository.js';
import { LeaveEventRepository } from './leave-event-repository.js';
import { LeaveRequestRepository } from './leave-request-repository.js';
import { LeaveTypeRepository } from './leave-type-repository.js';
import { LeaveYearRepository } from './leave-year-repository.js';
import { LedgerRepository } from './ledger-repository.js';
import { WorkPatternRepository } from './work-pattern-repository.js';

/** The repositories a service is handed, all of them on the same connection. */
export interface Repositories {
  employees: EmployeeRepository;
  departments: DepartmentRepository;
  patterns: WorkPatternRepository;
  /**
   * The three a balance movement needs. LMS 212, FR 26, §8.2., FR 32a, LMS 216, LMS 218, LMS 301, LMS 315, FR 39.
   */
  balances: BalanceRepository;
  entries: LedgerRepository;
  types: LeaveTypeRepository;
  years: LeaveYearRepository;
  events: LeaveEventRepository;
  requests: LeaveRequestRepository;
  decisions: LeaveDecisionRepository;
}

export class Transactions {
  constructor(private readonly db: Kysely<Database>) {}

  /** Runs `work` inside one transaction. */
  async allOrNothing<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) =>
      work({
        employees: new EmployeeRepository(trx),
        departments: new DepartmentRepository(trx),
        patterns: new WorkPatternRepository(trx),
        balances: new BalanceRepository(trx),
        entries: new LedgerRepository(trx),
        types: new LeaveTypeRepository(trx),
        years: new LeaveYearRepository(trx),
        events: new LeaveEventRepository(trx),
        requests: new LeaveRequestRepository(trx),
        decisions: new LeaveDecisionRepository(trx),
      }),
    );
  }
}
