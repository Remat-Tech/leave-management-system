/**
 * Asking what a period of leave would cost. FR 21, FR 22, §7.3., LMS 207, LMS 210, LMS 211, §8.6, FR 17, FR 18, FR 13, §8.
 */

import type { Actor } from '../auth/actor.js';
import { holidayPolicy } from '../auth/holiday-policy.js';
import type { Guard } from '../auth/policy.js';
import { workPatternPolicy } from '../auth/work-pattern-policy.js';
import type { Employee } from '../domain/employee.js';
import {
  countLeaveDays,
  type DayCount,
  type LeavePeriod,
  validateLeavePeriod,
} from '../domain/leave-calculator.js';
import type { LeaveType } from '../domain/leave-type.js';
import { WorkPatternNotFound } from '../domain/work-pattern.js';
import type { HolidayRepository } from '../repositories/holiday-repository.js';
import type { WorkPatternRepository } from '../repositories/work-pattern-repository.js';

export class LeaveCalculatorService {
  constructor(
    private readonly patterns: WorkPatternRepository,
    private readonly holidays: HolidayRepository,
    /** NFR SEC 02. */
    private readonly guard: Guard,
  ) {}

  /** What this period of this kind of leave costs this person. NFR USA 03, LMS 303, FR 25. */
  async count(
    actor: Actor,
    employee: Employee,
    type: LeaveType,
    period: LeavePeriod,
  ): Promise<DayCount> {
    this.guard.enforce(workPatternPolicy.read(actor, employee.workPatternId));
    this.guard.enforce(holidayPolicy.list(actor));

    const { from, to } = validateLeavePeriod(period);

    const pattern = await this.patterns.findById(employee.workPatternId);
    if (pattern === undefined) {
      throw new WorkPatternNotFound(employee.workPatternId);
    }

    const holidays = await this.holidays.list({ from, to });

    return countLeaveDays(type, { from, to }, pattern, holidays);
  }
}
