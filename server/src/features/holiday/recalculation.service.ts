/**
 * Crediting back a public holiday declared inside leave people already had. FR 25, §8.8. LMS 508.
 */

import type { Actor } from '../../auth/actor.js';
import { holidayPolicy } from './policy.js';
import type { Guard } from '../../auth/policy.js';
import type { BalanceService, LeaveRecalculated } from '../balance/balance.service.js';
import type { EarliestOpenDay } from '../entitlement/entitlement-rule.js';
import type { Employee } from '../employee/employee.js';
import { EmployeeNotFound } from '../employee/employee.js';
import { assertNotInASettledYear, type Holiday, HolidayNotFound } from './holiday.js';
import {
  type NotCredited,
  notCreditedInWords,
  reasonForRecalculation,
  whatAHolidayCredits,
} from './recalculation.js';
import type { LeaveRequest } from '../leave-request/leave-request.js';
import { LeaveTypeNotFound } from '../leave-type/leave-type.js';
import { WorkPatternNotFound } from '../work-pattern/work-pattern.js';
import type { EmployeeRepository } from '../employee/employee.db.js';
import type { HolidayRepository } from './holiday.db.js';
import type { HolidayRecalculationRepository } from './recalculation.db.js';
import type { LeaveRequestRepository } from '../leave-request/leave-request.db.js';
import type { LeaveTypeRepository } from '../leave-type/leave-type.db.js';
import type { WorkPatternRepository } from '../work-pattern/work-pattern.db.js';
import type { NotificationService } from '../notification/notification.service.js';

/** One piece of agreed leave the day falls inside, and what it is worth to that person. */
export interface AffectedLeave {
  request: LeaveRequest;
  employee: Employee;
  typeName: string;
  /** The difference, and nought where the day cost nothing anyway. FR 25. */
  days: number;
  /** Why nothing is credited, or null where something is. */
  because: NotCredited | null;
  /** NFR USA 03. The sentence for the reason, or null where there is a credit. */
  inWords: string | null;
}

/** What pressing the button would do, before it is pressed. FR 25, NFR USA 03. */
export interface RecalculationPreview {
  holiday: Holiday;
  /** Everybody whose agreed leave covers the day, credited or not. */
  affected: AffectedLeave[];
  /** The days that would be credited, and to how many people. */
  days: number;
  people: number;
}

/** One person's leave that the run put right, with what they were told. */
export interface LeaveCredited extends LeaveRecalculated {
  employee: Employee;
  typeName: string;
}

/** One that could not be, and why. */
export interface LeaveNotCredited {
  leaveRequestId: string;
  employeeId: string;
  because: string;
}

/** What the run did. FR 25, §8.8. */
export interface RecalculationRun {
  holiday: Holiday;
  credited: LeaveCredited[];
  /** Leave the day fell inside that was left alone, and the sentence saying why. */
  untouched: AffectedLeave[];
  /** Requests that were meant to be credited and were not. */
  failed: LeaveNotCredited[];
  days: number;
}

export class HolidayRecalculationService {
  constructor(
    private readonly holidays: HolidayRepository,
    private readonly recalculations: HolidayRecalculationRepository,
    private readonly requests: LeaveRequestRepository,
    private readonly employees: EmployeeRepository,
    private readonly types: LeaveTypeRepository,
    private readonly patterns: WorkPatternRepository,
    /** The one door a balance moves through. §5.7. */
    private readonly balances: BalanceService,
    /** FR 59. */
    private readonly notifications: NotificationService,
    /** NFR SEC 02. */
    private readonly guard: Guard,
    /** Where a closed leave year ends. LMS 205. */
    private readonly earliestOpenDay: EarliestOpenDay,
  ) {}

  /**
   * What crediting this day back would do, without doing any of it. FR 25, NFR USA 03.
   *
   * The story's first criterion is that HR triggers this, and a trigger nobody can see the
   * consequences of first is a button people do not press. Everything the run would credit
   * is here, and so is everything it would leave alone with the reason beside it — which is
   * where the second criterion is read: a maternity leave over the same day appears, says
   * it is counted in calendar days, and is charged exactly what it was.
   */
  async whatWouldChange(actor: Actor, holidayId: string): Promise<RecalculationPreview> {
    this.guard.enforce(holidayPolicy.recalculate(actor));

    const holiday = await this.require(holidayId);
    const affected = await this.affectedBy(holiday);
    const credited = affected.filter((leave) => leave.days > 0);

    return {
      holiday,
      affected,
      days: credited.reduce((total, leave) => total + leave.days, 0),
      people: new Set(credited.map((leave) => leave.employee.id)).size,
    };
  }

  /**
   * Credits the day back to everybody it was charged to. FR 25, §8.8, FR 59. LMS 508.
   *
   * **One transaction per person, not one for the run.** A hundred and forty people's
   * balances are a hundred and forty independent corrections, and a single failure among
   * them — a leave year closed underneath the run, a balance somebody is holding — is not a
   * reason for the other hundred and thirty nine to stay wrong. What each one is reported
   * as is in `failed`, so nothing fails quietly.
   *
   * **Safe to press twice.** `leave_request_recalculation_credits_a_holiday_once` is what
   * makes it so rather than the read below, which only keeps the second press from
   * producing a hundred and forty refusals.
   *
   * A leave year that has been closed is refused for the whole run rather than per person:
   * every request in it was counted against the calendar as it stood, and §8.9 does not
   * bend for one day. The same refusal the calendar itself gives when a day is typed into a
   * settled year, and the same sentence.
   */
  async recalculate(actor: Actor, holidayId: string): Promise<RecalculationRun> {
    this.guard.enforce(holidayPolicy.recalculate(actor));

    const holiday = await this.require(holidayId);

    assertNotInASettledYear(holiday.date, await this.earliestOpenDay(), 'recalculated for');

    const affected = await this.affectedBy(holiday);

    const credited: LeaveCredited[] = [];
    const failed: LeaveNotCredited[] = [];

    for (const leave of affected.filter((one) => one.days > 0)) {
      try {
        credited.push(await this.credit(actor, holiday, leave));
      } catch (error) {
        failed.push({
          leaveRequestId: leave.request.id,
          employeeId: leave.employee.id,
          because: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      holiday,
      credited,
      untouched: affected.filter((one) => one.days === 0),
      failed,
      days: credited.reduce((total, one) => total + one.recalculation.days, 0),
    };
  }

  /** One person's credit, and the message telling them about it. FR 59. */
  private async credit(
    actor: Actor,
    holiday: Holiday,
    leave: AffectedLeave,
  ): Promise<LeaveCredited> {
    const done = await this.balances.recalculateForHoliday(actor, {
      request: leave.request,
      holiday,
      days: leave.days,
      reason: reasonForRecalculation({
        typeName: leave.typeName,
        holiday,
        days: leave.days,
      }),
    });

    /** FR 25's fourth criterion. Composed after the commit, as every notice here is. */
    await this.notifications.tell({
      event: 'LEAVE_RECALCULATED',
      employee: leave.employee,
      request: done.request,
      typeName: leave.typeName,
      /** FR 52. Crediting a holiday back is not a decision at a desk. */
      decidedBy: null,
      comment: null,
      availableAfter: done.balance.available,
      daysBack: done.recalculation.days,
      declared: { name: holiday.name, date: holiday.date },
    });

    return { ...done, employee: leave.employee, typeName: leave.typeName };
  }

  /**
   * Every piece of agreed leave the day falls inside, with what it is worth to each person.
   *
   * The calendar is read once for the whole run and narrowed per request, rather than once
   * per person: a hundred and forty requests over one day are a hundred and forty reads of
   * the same fortnight, and the answer cannot differ between them.
   */
  private async affectedBy(holiday: Holiday): Promise<AffectedLeave[]> {
    const requests = await this.requests.agreedLeaveCovering(holiday.date);

    if (requests.length === 0) {
      return [];
    }

    const calendar = await this.holidays.list({
      from: earliest(requests),
      to: latest(requests),
    });

    const alreadyCredited = new Set(
      (await this.recalculations.forHoliday(holiday.id)).map((one) => one.leaveRequestId),
    );

    const affected: AffectedLeave[] = [];

    for (const request of requests) {
      const employee = await this.employeeFor(request.employeeId);
      const type = await this.typeFor(request.leaveTypeId);
      const pattern = await this.patternFor(employee.workPatternId);

      const credits = whatAHolidayCredits({
        request,
        type,
        pattern,
        holiday,
        calendar: calendar.filter((day) => request.from <= day.date && day.date <= request.to),
        alreadyCredited: alreadyCredited.has(request.id),
      });

      affected.push({
        request,
        employee,
        typeName: type.name,
        days: credits.days,
        because: credits.because,
        inWords: credits.because === null ? null : notCreditedInWords(credits.because, type.name),
      });
    }

    return affected;
  }

  private async require(id: string): Promise<Holiday> {
    const holiday = await this.holidays.findById(id);

    if (holiday === undefined) {
      throw new HolidayNotFound(id);
    }

    return holiday;
  }

  private async employeeFor(id: string): Promise<Employee> {
    const employee = await this.employees.findById(id);

    if (employee === undefined) {
      throw new EmployeeNotFound(id);
    }

    return employee;
  }

  private async typeFor(id: string) {
    const type = await this.types.findById(id);

    if (type === undefined) {
      throw new LeaveTypeNotFound(id);
    }

    return type;
  }

  private async patternFor(id: string) {
    const pattern = await this.patterns.findById(id);

    if (pattern === undefined) {
      throw new WorkPatternNotFound(id);
    }

    return pattern;
  }
}

function earliest(requests: readonly LeaveRequest[]): string {
  return requests.reduce((first, one) => (one.from < first ? one.from : first), requests[0].from);
}

function latest(requests: readonly LeaveRequest[]): string {
  return requests.reduce((last, one) => (one.to > last ? one.to : last), requests[0].to);
}
