/**
 * Keeping the gazetted public holiday calendar. FR 22, §5.4. LMS 206.
 *
 * The story's "so that" is the whole specification of this file: nobody is charged
 * leave for a day the office was closed. Everything below is one of the four
 * things that makes that true.
 *
 *   **A day can be added at any time.** {@link HolidayService.add}, and a holiday
 *   gazetted in March for the following week is the ordinary case rather than the
 *   awkward one. The Minister for the Interior declares days of mourning, election
 *   days and Mondays in lieu of Saturday holidays, and none of them are known when
 *   the year starts.
 *
 *   **A day can be moved.** {@link HolidayService.correct}. Eid al-Fitr and Eid
 *   al-Adha follow the sighting of the moon; whatever date the calendar holds for
 *   them is a projection until the gazette says otherwise, and it has been a day
 *   out before.
 *
 *   **A day can be taken off.** {@link HolidayService.remove}, and it is a real
 *   delete. Nothing is filed under a holiday — a request stores the days it cost,
 *   not which days those were — so a projected day the gazette never confirmed can
 *   simply go, and a system that could only ever add days would be one where the
 *   first mistake is permanent.
 *
 *   **None of the three may reach into a settled leave year.** The boundary comes
 *   from {@link EarliestOpenDay}, the same function LMS 205 hands the entitlement
 *   rules, read on every write rather than held — because a year is closed while
 *   this process is running. `refuse_a_holiday_in_a_settled_year()` says the same
 *   thing to every other writer.
 *
 * ## What it does not do
 *
 * **No counting.** What a request costs is the leave calculator of §7.3, which
 * reads a working pattern, the leave type's `counting_basis` and this calendar.
 * {@link HolidayService.calendarFor} is what it will ask; nothing here counts a
 * day, because there are no requests to count and a counter with nothing to count
 * is a rule nobody has exercised.
 *
 * **No recalculation.** FR 25 gives a day back on an approved request when a
 * holiday is declared inside it, "only to working day leave types". That needs
 * requests, which is §8. What this story leaves for it is the audit entries: a
 * recalculation nobody can explain is a recalculation nobody accepts.
 *
 * **No filling in of next year.** {@link HolidayService.yearsAwaitingACalendar}
 * says which leave years nobody has transcribed a gazette for, and stops there. A
 * generator that produced next year's rows would be right about nine of Ghana's
 * fourteen holidays, silent about two and overridden for three — see
 * ../domain/holiday.ts. What the next year needs is somebody with the gazette
 * open, which is what FR 22 asks for.
 *
 * **No authorisation rules.** Every method takes an {@link Actor} and asks
 * ../auth/holiday-policy.ts. The one worth knowing without reading it: this is the
 * only configuration table an HR Officer may write, because it is the only one
 * that holds somebody else's decisions rather than Remat's.
 */

import type { Actor } from '../auth/actor.js';
import { holidayPolicy } from '../auth/holiday-policy.js';
import type { Guard } from '../auth/policy.js';
import type { EarliestOpenDay } from '../domain/entitlement-rule.js';
import {
  assertNotInASettledYear,
  type Holiday,
  type HolidayChanges,
  HolidayNotFound,
  type NewHoliday,
  validateHolidayChanges,
  validateNewHoliday,
  yearsWithoutHolidays,
} from '../domain/holiday.js';
import type { LeaveYear } from '../domain/leave-year.js';
import type { HolidayListOptions, HolidayRepository } from '../repositories/holiday-repository.js';
import type { LeaveYearRepository } from '../repositories/leave-year-repository.js';
import type { CalendarDate } from '../domain/time.js';

export class HolidayService {
  constructor(
    private readonly holidays: HolidayRepository,
    /* NFR SEC 02. Required rather than defaulted; see ../auth/policy.ts. */
    private readonly guard: Guard,
    /**
     * Where a closed leave year ends. {@link earliestOpenDayFrom} since LMS 205;
     * {@link NOTHING_IS_CLOSED_YET} for a caller with no leave years to read.
     *
     * The same seam the entitlement rules are built on, and reused rather than
     * reinvented on purpose: "what counts as settled" has to have exactly one
     * answer, or a figure and a calendar would disagree about which years are
     * still open.
     */
    private readonly earliestOpenDay: EarliestOpenDay,
    /**
     * The leave years, for {@link HolidayService.yearsAwaitingACalendar} alone.
     *
     * The repository rather than the service, because this is one part of the
     * system asking another what it holds rather than somebody asking a question —
     * the actor has already been through ../auth/holiday-policy.ts by the time it
     * is read, and giving it a second actor would mean minting one, which is how a
     * system acquires a caller that holds every role. The same argument
     * {@link earliestOpenDayFrom} makes about itself.
     */
    private readonly years: LeaveYearRepository,
  ) {}

  /**
   * Adds a day to the calendar. The story's "added mid year", and its main verb.
   *
   * Throws {@link InvalidHoliday} for a date that is not one or a name that is
   * blank, {@link DuplicateHoliday} where the day already has a holiday on it, and
   * {@link HolidayInASettledYear} for a day inside a closed leave year.
   *
   * The duplicate is checked by the database rather than read first here, because
   * checking and then writing is a race: two officers transcribing the same
   * gazette in the same minute both find the sixth of March free. The settled year
   * is checked here *and* by a trigger, and neither copy is redundant — this one
   * can name the earliest day still open, which is what somebody at a form needs,
   * and the trigger is what holds when the year is closed between the two.
   */
  async add(actor: Actor, input: NewHoliday): Promise<Holiday> {
    this.guard.enforce(holidayPolicy.create(actor));

    const validated = validateNewHoliday(input);

    assertNotInASettledYear(validated.date, await this.earliestOpenDay(), 'added to');

    return this.holidays.create(actor, validated);
  }

  /**
   * Corrects a day. The story's "edit", and the moon is why it exists.
   *
   * Both the name and the date may change, which is the difference from every
   * other configuration record in this system: those hold decisions whose history
   * matters, and this holds a transcription that is either of the right day or of
   * the wrong one.
   *
   * A move is judged at both ends. Dragging a holiday out of a settled year and
   * dropping one into a settled year are two different wrongs, and a check on the
   * new date alone would permit the first — which is the more likely of the two,
   * because it looks like tidying up.
   */
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

  /**
   * Takes a day off the calendar. A real delete, and the story's "remove".
   *
   * The one write here that puts a working day back into everybody's leave, which
   * is why it has a policy decision of its own and why the audit entry matters:
   * after this the row is gone, and the log is the only record that it was ever
   * there.
   *
   * Refused for a day inside a closed leave year, for the same reason adding one
   * is. Every request over that day was counted against the calendar as it stood,
   * and a closed year is never recalculated.
   */
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

  /**
   * The holiday on a day, or undefined where the office was open.
   *
   * Undefined is the answer rather than a failure, and it is the common one: most
   * days are working days. This is the read a day count makes one day at a time,
   * and a throw here would mean catching an exception for every ordinary Tuesday.
   */
  async on(actor: Actor, day: CalendarDate): Promise<Holiday | undefined> {
    this.guard.enforce(holidayPolicy.read(actor));

    return this.holidays.findOn(day);
  }

  /**
   * The calendar, or a stretch of it, in the order the days fall.
   *
   * Pass `from` and `to` for a month, a leave year, or the days a request spans.
   * Both bounds inclusive, because a request's last day is a day somebody is away.
   */
  async list(actor: Actor, options: HolidayListOptions = {}): Promise<Holiday[]> {
    this.guard.enforce(holidayPolicy.list(actor));

    return this.holidays.list(options);
  }

  /**
   * The holidays inside one leave year. What a screen for maintaining a year's
   * calendar shows, and the story's "per year".
   *
   * A range read over the year's own days rather than a column on the row, because
   * a holiday has no leave year of its own: which year it falls in is the same
   * containment question every other day answers, and a stored answer would be
   * wrong the morning somebody moved the company to an April start.
   */
  async calendarFor(actor: Actor, year: LeaveYear): Promise<Holiday[]> {
    return this.list(actor, { from: year.startDate, to: year.endDate });
  }

  /**
   * The leave years nobody has entered a calendar for.
   *
   * The guard on the decision the migration makes to seed 2026 alone. Two of
   * Ghana's fourteen holidays cannot be known for a future year, so a seeded 2027
   * would be a calendar that is twelve thirteenths right — believed silently,
   * wrong twice — where an empty one is a screen with nothing on it and a question
   * somebody asks.
   *
   * This is what turns "nothing on it" into a warning somebody sees in November
   * rather than a complaint somebody makes in January. It reads both tables and
   * compares them in ../domain/holiday.ts, so the rule is a pure function and the
   * service is only where the two lists come from.
   */
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
