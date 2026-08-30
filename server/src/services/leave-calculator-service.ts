/**
 * Asking what a period of leave would cost. FR 21, FR 22, §7.3. LMS 207.
 *
 * The thinnest service in the system, and that is the story's fifth criterion
 * rather than an accident: the calculator is pure, "with no database access beyond
 * patterns and holidays". This is the file where that sentence is either true or
 * not, so it is worth reading as a list of what it does *not* do.
 *
 * It reads two things. The employee's working pattern, and the public holidays
 * inside the period. Then it calls {@link countLeaveDays} and returns what that
 * says. There is no third query, no clock, no branch on a leave type, and no
 * arithmetic of its own — every rule about what a day costs is in
 * ../domain/leave-calculator.ts, where it can be exhaustively tested without a
 * database, which is where the real coverage of this story lives.
 *
 * ## Why the employee and the leave type are passed in
 *
 * Both arrive as records the caller has already read, exactly as
 * {@link EntitlementRuleService.entitlementOn} takes an {@link Employee}: this
 * service must never become a second place that decides who may read an employee
 * record or a leave type. Handing it an id would make it fetch one, and fetching
 * one means deciding whether the caller may have it — which is
 * ../auth/employee-policy.ts's job and is already done by the time anybody is
 * asking what a fortnight would cost.
 *
 * ## Why the holidays are read for the period rather than all of them
 *
 * A calendar that does not cover the period is invisible to the domain: a December
 * that was never loaded looks exactly like a December with no holidays in it, and
 * the difference is two days of somebody's annual leave. So the range comes from
 * the period being counted rather than from whatever a caller happened to have in
 * hand, and the one place that decides it is here.
 *
 * The other half of that guard is {@link HolidayService.yearsAwaitingACalendar},
 * which names a leave year nobody has transcribed a gazette for. This read cannot
 * tell an empty year from a working one; that one can, and it is why only 2026 is
 * seeded rather than a plausible 2027 — see ../domain/holiday.ts.
 *
 * ## What it does not do
 *
 * **No balance.** Whether somebody has the days this returns is `leave_balance` and
 * the ledger, LMS 210 and LMS 211. "What does this cost" and "can they afford it"
 * are two questions, and sick leave answers the second with yes while going
 * negative — §8.6b.
 *
 * **No request.** Nothing here creates, validates or stores anything. FR 17's
 * notice warning, FR 18's backdating window and FR 13's documentation rule are all
 * read off the leave type by the request workflow of §8, and each of them wants the
 * number this produces — which is why it is available before there is anything to
 * submit.
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
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. */
    private readonly guard: Guard,
  ) {}

  /**
   * What this period of this kind of leave costs this person.
   *
   * Throws {@link InvalidLeavePeriod} for two dates that are not a period and
   * {@link LeaveCountsNoDays} where nothing in it counts — both from the domain,
   * unchanged, because a service that reworded them would be a second copy of the
   * message NFR USA 03 asks for.
   *
   * Two policies are asked rather than one, and they are the two tables this reads.
   * Both are open to anybody signed in, so neither refuses anybody in practice
   * today — and asking them anyway is what keeps that a decision in
   * ../auth rather than an assumption here, on the day somebody narrows one.
   *
   * {@link WorkPatternNotFound} is unreachable through an employee record —
   * `employee.work_pattern_id` is NOT NULL with a foreign key behind it — and is
   * answered rather than assumed, because the alternative is counting a fortnight
   * against `undefined` and returning a number.
   */
  async count(
    actor: Actor,
    employee: Employee,
    type: LeaveType,
    period: LeavePeriod,
  ): Promise<DayCount> {
    this.guard.enforce(workPatternPolicy.read(actor, employee.workPatternId));
    this.guard.enforce(holidayPolicy.list(actor));

    /* Judged before anything is fetched, because the fetch below is bounded by
       these two dates: a `from` of `31/07/2026` reaching a `WHERE holiday_date >=`
       is a driver error where it should have been a sentence beside the input.
       {@link countLeaveDays} asks the same question again and that is deliberate —
       it is the pure entry point and has to be safe called directly. */
    const { from, to } = validateLeavePeriod(period);

    const pattern = await this.patterns.findById(employee.workPatternId);
    if (pattern === undefined) {
      throw new WorkPatternNotFound(employee.workPatternId);
    }

    /* The calendar for the period and not a day more. See the module note: a
       calendar that does not cover the days being counted is indistinguishable
       from a period with no holidays in it, and the difference is somebody's
       Christmas. */
    const holidays = await this.holidays.list({ from, to });

    return countLeaveDays(type, { from, to }, pattern, holidays);
  }
}
