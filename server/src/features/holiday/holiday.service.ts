/** Keeping the gazetted public holiday calendar. FR 22, §5.4., LMS 206, LMS 205, §7.3, FR 25, §8.. */

import type { Actor } from '../../auth/actor.js';
import { holidayPolicy } from './policy.js';
import type { Guard } from '../../auth/policy.js';
import type { EarliestOpenDay } from '../entitlement/entitlement-rule.js';
import {
  assertNotInASettledYear,
  type Holiday,
  type HolidayChanges,
  HolidayNotFound,
  type NewHoliday,
  validateHolidayChanges,
  validateNewHoliday,
  yearsWithoutHolidays,
} from './holiday.js';
import type { LeaveYear } from '../leave-year/leave-year.js';
import type { HolidayListOptions, HolidayRepository } from './holiday.db.js';
import type { LeaveYearRepository } from '../leave-year/leave-year.db.js';
import type { CalendarDate } from '../../shared/time.js';

export class HolidayService {
  constructor(
    private readonly holidays: HolidayRepository,
    /** NFR SEC 02. */
    private readonly guard: Guard,
    /** Where a closed leave year ends. LMS 205. */
    private readonly earliestOpenDay: EarliestOpenDay,
    /** The leave years, for HolidayService.yearsAwaitingACalendar alone. */
    private readonly years: LeaveYearRepository,
  ) {}

  /** Adds a day to the calendar. */
  async add(actor: Actor, input: NewHoliday): Promise<Holiday> {
    this.guard.enforce(holidayPolicy.create(actor));

    const validated = validateNewHoliday(input);

    assertNotInASettledYear(validated.date, await this.earliestOpenDay(), 'added to');

    return this.holidays.create(actor, validated);
  }

  /** Corrects a day. */
  async correct(actor: Actor, id: string, changes: HolidayChanges): Promise<Holiday> {
    this.guard.enforce(holidayPolicy.update(actor, id));

    const current = await this.require(id);
    const validated = validateHolidayChanges(changes);

    if (validated.date !== undefined && validated.date !== current.date) {
      const boundary = await this.earliestOpenDay();

      assertNotInASettledYear(current.date, boundary, 'moved for');
      assertNotInASettledYear(validated.date, boundary, 'moved to');
    }

    const updated = await this.holidays.update(actor, current, validated);
    if (updated === undefined) {
      // Removed between the read and the write, which is possible: another
      // officer may take a day off while this one has the form open.
      throw new HolidayNotFound(id);
    }

    return updated;
  }

  /** Takes a day off the calendar. */
  async remove(actor: Actor, id: string): Promise<void> {
    this.guard.enforce(holidayPolicy.remove(actor, id));

    const current = await this.require(id);

    assertNotInASettledYear(current.date, await this.earliestOpenDay(), 'cleared for');

    const removed = await this.holidays.remove(actor, current);
    if (!removed) {
      throw new HolidayNotFound(id);
    }
  }

  async byId(actor: Actor, id: string): Promise<Holiday> {
    this.guard.enforce(holidayPolicy.read(actor, id));

    return this.require(id);
  }

  /** The holiday on a day, or undefined where the office was open. */
  async on(actor: Actor, day: CalendarDate): Promise<Holiday | undefined> {
    this.guard.enforce(holidayPolicy.read(actor));

    return this.holidays.findOn(day);
  }

  /** The calendar, or a stretch of it, in the order the days fall. */
  async list(actor: Actor, options: HolidayListOptions = {}): Promise<Holiday[]> {
    this.guard.enforce(holidayPolicy.list(actor));

    return this.holidays.list(options);
  }

  /** The holidays inside one leave year. */
  async calendarFor(actor: Actor, year: LeaveYear): Promise<Holiday[]> {
    return this.list(actor, { from: year.startDate, to: year.endDate });
  }

  /** The leave years nobody has entered a calendar for. */
  async yearsAwaitingACalendar(actor: Actor): Promise<LeaveYear[]> {
    this.guard.enforce(holidayPolicy.list(actor));

    return yearsWithoutHolidays(await this.years.list(), await this.holidays.list());
  }

  private async require(id: string): Promise<Holiday> {
    const holiday = await this.holidays.findById(id);
    if (holiday === undefined) {
      throw new HolidayNotFound(id);
    }
    return holiday;
  }
}
