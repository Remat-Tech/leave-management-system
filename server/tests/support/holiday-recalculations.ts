/** The recalculation door `buildApp` takes, built the one way. FR 25, §8.8, LMS 508. */

import type { Kysely } from 'kysely';
import type { Database } from '../../src/db/index.js';
import type { Guard } from '../../src/auth/policy.js';
import type { BalanceService } from '../../src/features/balance/balance.service.js';
import { EmployeeRepository } from '../../src/features/employee/employee.db.js';
import { HolidayRepository } from '../../src/features/holiday/holiday.db.js';
import { HolidayRecalculationRepository } from '../../src/features/holiday/recalculation.db.js';
import { HolidayRecalculationService } from '../../src/features/holiday/recalculation.service.js';
import { LeaveRequestRepository } from '../../src/features/leave-request/leave-request.db.js';
import { LeaveTypeRepository } from '../../src/features/leave-type/leave-type.db.js';
import { LeaveYearRepository } from '../../src/features/leave-year/leave-year.db.js';
import { earliestOpenDayFrom } from '../../src/features/leave-year/leave-year.service.js';
import { NotificationRepository } from '../../src/features/notification/notification.db.js';
import { NotificationService } from '../../src/features/notification/notification.service.js';
import { WorkPatternRepository } from '../../src/features/work-pattern/work-pattern.db.js';
import { recordingMailer } from './recording-mailer.js';

export function holidayRecalculationService(
  db: Kysely<Database>,
  guard: Guard,
  /** The one door a balance moves through, so a test asserts against the same cache. */
  balances: BalanceService,
): HolidayRecalculationService {
  return new HolidayRecalculationService(
    new HolidayRepository(db),
    new HolidayRecalculationRepository(db),
    new LeaveRequestRepository(db),
    new EmployeeRepository(db),
    new LeaveTypeRepository(db),
    new WorkPatternRepository(db),
    balances,
    new NotificationService(new NotificationRepository(db), recordingMailer(), guard),
    guard,
    earliestOpenDayFrom(new LeaveYearRepository(db)),
  );
}
