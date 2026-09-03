/** Running several repositories on one transaction. FR 08. */

import type { Kysely } from 'kysely';
import type { Database } from './index.js';
import { BalanceRepository } from '../features/balance/balance.db.js';
import { DepartmentRepository } from '../features/department/department.db.js';
import { EmployeeRepository } from '../features/employee/employee.db.js';
import { LeaveDecisionRepository } from '../features/leave-request/leave-decision.db.js';
import { LeaveEventRepository } from '../features/leave-event/leave-event.db.js';
import { LeaveRequestRepository } from '../features/leave-request/leave-request.db.js';
import { LeaveRoutingRepository } from '../features/leave-request/routing.db.js';
import { LeaveTypeRepository } from '../features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../features/leave-year/leave-year.db.js';
import { LedgerRepository } from '../features/balance/ledger.db.js';
import { WorkPatternRepository } from '../features/work-pattern/work-pattern.db.js';

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
  /** FR 48b. The stages a request's routing skipped. LMS 320. */
  routing: LeaveRoutingRepository;
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
        routing: new LeaveRoutingRepository(trx),
      }),
    );
  }
}
