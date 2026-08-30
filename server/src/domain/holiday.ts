/**
 * The gazetted public holiday calendar. FR 22, §5.4. LMS 206.
 *
 * The story's "so that" is the whole specification: nobody is charged leave for a
 * day the office was closed. That is one row per closed day, and everything here
 * is either what makes such a row valid or how a stretch of days is read against
 * the set of them.
 *
 * ## This table holds somebody else's decisions, and everything follows from that
 *
 * ./leave-type.ts, ./entitlement-rule.ts and ./leave-year.ts hold what Remat
 * Holdings decided. This holds what the Republic decided — the Public Holidays Act
 * 2001 as amended in 2019, and whatever the Minister for the Interior gazettes
 * during the year — and HR is transcribing rather than deciding. Three of the
 * story's requirements are that difference showing up:
 *
 *   **Holidays are added mid year.** A day of national mourning, an election day,
 *   a Monday declared in lieu of a Saturday Boxing Day. Not an exception handled
 *   gracefully; the ordinary way the calendar for a year finishes being written.
 *
 *   **Holidays are edited.** Eid al-Fitr and Eid al-Adha follow the sighting of
 *   the moon and are fixed by the Minister when it is sighted. Whatever date the
 *   calendar was seeded with is a projection, and moving it is the correction that
 *   actually happens.
 *
 *   **Holidays are removed.** A projected day the gazette did not confirm. A
 *   holiday is not a heading anything is filed under — nothing points a foreign key
 *   at one, because a request stores the days it cost rather than which days those
 *   were — so a real delete is honest here in a way it is not for a leave type or a
 *   leave year.
 *
 * ## Two rules, and one of them is about arithmetic nobody has written yet
 *
 * **One holiday to a day.** {@link DuplicateHoliday}, and `holiday_one_per_day` in
 * the database. "Was the office closed on this day" has one answer, and a day with
 * two rows on it would be subtracted twice by any counter that joined on it — a
 * request coming back a day cheaper than it was, on the one day of the year where
 * two feasts coincided. The gazette handles a coincidence by naming the day for
 * both, which is a name and not a second row.
 *
 * **A settled year keeps its days.** {@link assertNotInASettledYear}, and
 * `refuse_a_holiday_in_a_settled_year()` beside it. Adding a day to a closed leave
 * year changes what every working-day request over it cost, after those figures
 * were made final; removing one does the same in the other direction. The
 * boundary comes in as an argument the way {@link worksOn} takes a weekday and
 * {@link assertDoesNotReachIntoAClosedYear} takes this same date — the domain
 * knows the rule, the caller brings the fact.
 *
 * ## What is deliberately not here
 *
 * **No counting.** What a day off costs is the leave calculator of §7.3, which
 * reads a working pattern, a leave type's `counting_basis` and this calendar.
 * {@link isHoliday} is the primitive it will ask, and it is the only one this story
 * ships: a counter written now would be a rule with no requests to exercise it.
 *
 * **No recurrence.** There is no "every year" flag and no generator for next
 * year's rows, and the two Eids are why — a generator would be right about nine of
 * the fourteen, silent about two and overridden for three. What the next year needs
 * is somebody with the gazette open, which is what FR 22 asks for.
 *
 * **No days in lieu.** Moving a Saturday holiday to the Monday after is the
 * Minister's to declare and not always declared. A rule here would be this file
 * inventing law, and a day off the payroll believed in and the country did not.
 */

import { type CalendarDate, isCalendarDate } from './time.js';
import { coversDay, type LeaveYear } from './leave-year.js';

/** What the caller supplies to add one. */
export interface NewHoliday {
  /** What the gazette calls it. 'Christmas Day', 'Eid al-Fitr'. */
  name: string;
  /** The day the office was closed. */
  date: CalendarDate;
}

/**
 * The fields of an existing one that may change.
 *
 * Both of them, and that is the difference from every other configuration record
 * in this system. A leave type may not change its code, an entitlement rule in
 * effect may not change at all, and a closed leave year may only be relabelled —
 * because each of those is a decision somebody made and the history of the
 * decision matters. A holiday is a transcription, and a transcription that turns
 * out to be of the wrong day is simply wrong.
 */
export type HolidayChanges = Partial<NewHoliday>;

/** A record as it comes back out. */
export interface Holiday {
  id: string;
  name: string;
  date: CalendarDate;
  createdAt: Date;
  updatedAt: Date;
}

/** The shape a validated record has by the time it reaches the repository. */
export interface ValidatedHoliday {
  name: string;
  date: CalendarDate;
}

/**
 * A holiday that was refused, and the field that caused it.
 *
 * The same shape as {@link InvalidLeaveYear} and for the same reason, NFR USA 03:
 * the message has to reach the form beside the input it is about.
 */
export class InvalidHoliday extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidHoliday';
    this.field = field;
  }
}

export class HolidayNotFound extends Error {
  readonly holidayId: string;

  constructor(id: string) {
    super(`No holiday with id ${id}.`);
    this.name = 'HolidayNotFound';
    this.holidayId = id;
  }
}

/**
 * A second holiday on a day that already has one.
 *
 * Names the one that is there, because "that day is taken" is not actionable and
 * "the sixth of March is already Independence Day" is: the answer is usually to
 * rename the row rather than to add another, which is what the gazette itself does
 * when two feasts coincide.
 */
export class DuplicateHoliday extends Error {
  readonly date: CalendarDate;

  constructor(date: CalendarDate, existing?: string) {
    super(
      `${date} is already a public holiday${existing === undefined ? '' : `, ${existing}`}. ` +
        `A day is closed once however many things fall on it, and a second row for ` +
        `it would be counted as a second day off. Rename the one that is there.`,
    );
    this.name = 'DuplicateHoliday';
    this.date = date;
  }
}

/**
 * A holiday added to, taken out of, or moved into a leave year that has been
 * closed.
 *
 * The counterpart of {@link ReachesIntoAClosedYear}, arriving at the same rule from
 * the calendar instead of from an entitlement figure. The message says which day
 * is the earliest that may still be touched, because that is the fact somebody at a
 * form can act on.
 */
export class HolidayInASettledYear extends Error {
  readonly date: CalendarDate;
  readonly earliestOpenDay: CalendarDate;

  constructor(date: CalendarDate, earliestOpenDay: CalendarDate, attempted: string) {
    super(
      `The calendar cannot be ${attempted} for ${date}: leave years are closed up to ` +
        `${earliestOpenDay}, and every request over a day in one was counted against ` +
        `the calendar as it stood. A closed year is never recalculated. The earliest ` +
        `day the calendar can still be changed for is ${earliestOpenDay}. FR 22.`,
    );
    this.name = 'HolidayInASettledYear';
    this.date = date;
    this.earliestOpenDay = earliestOpenDay;
  }
}

/* ------------------------------------------------------------- what is valid */

/** Checks and tidies a new record. */
export function validateNewHoliday(input: NewHoliday): ValidatedHoliday {
  return {
    name: requireName(input.name),
    date: requireDay(input.date),
  };
}

/**
 * Checks and tidies a change to an existing one.
 *
 * No current record is needed, unlike a leave year's changes, because there is no
 * rule here that spans two fields: a name is a name and a day is a day. The rules
 * that do span something — the day already being taken, and the year around it
 * being settled — are about the rest of the table and the rest of the schema, and
 * are asked by {@link assertNotInASettledYear} and by the database.
 */
export function validateHolidayChanges(changes: HolidayChanges): Partial<ValidatedHoliday> {
  const validated: Partial<ValidatedHoliday> = {};

  if ('name' in changes) {
    validated.name = requireName(changes.name);
  }
  if ('date' in changes) {
    validated.date = requireDay(changes.date);
  }

  return validated;
}

/**
 * Refuses a change to the calendar for a day inside a closed leave year. FR 22.
 *
 * The boundary is passed in because it belongs to a table this file does not know
 * about; see {@link EarliestOpenDay} in ./entitlement-rule.ts, which is the one
 * definition of it. Null means nothing has been closed, which is not the same as
 * "no check" — it is the check, answered, and it is the answer on go live.
 *
 * `attempted` is the word that goes in the message — 'changed', 'cleared' — so the
 * refusal names what was being done rather than describing every possibility. The
 * same shape {@link LeaveYearAlreadyClosed} uses.
 *
 * Both sides of a move have to be asked separately, and the service does: dragging
 * a holiday out of a settled year and dropping one into one are two different
 * wrongs, and a check on the new date alone would permit the first.
 */
export function assertNotInASettledYear(
  date: CalendarDate,
  earliestOpenDay: CalendarDate | null,
  attempted = 'changed',
): void {
  if (earliestOpenDay !== null && date < earliestOpenDay) {
    throw new HolidayInASettledYear(date, earliestOpenDay, attempted);
  }
}

/* --------------------------------------------------------------- the readings */

/**
 * Whether the office was closed on that day.
 *
 * The primitive the leave calculator of §7.3 will ask once per day of a request,
 * and deliberately the only counting-adjacent function this story ships. It takes
 * the calendar as an argument rather than reading one, exactly as {@link worksOn}
 * takes a weekday: the day count is the caller's arithmetic, and this is the fact
 * it needs.
 *
 * A string comparison, which is the whole reason a {@link CalendarDate} is ten
 * characters — no parsing, no zone and no library between the question and the
 * answer.
 */
export function isHoliday(holidays: readonly Holiday[], day: CalendarDate): boolean {
  return holidays.some((holiday) => holiday.date === day);
}

/**
 * The holiday on that day, or undefined.
 *
 * What a screen shows beside a day, and what a leave request's explanation of why
 * nine days cost seven is built from: "the twenty fifth and twenty sixth of
 * December" is an answer and "two public holidays" is not.
 *
 * That there is at most one to find is `holiday_one_per_day` rather than this
 * function's doing, which is why there is no ordering to pick a winner.
 */
export function holidayOn(holidays: readonly Holiday[], day: CalendarDate): Holiday | undefined {
  return holidays.find((holiday) => holiday.date === day);
}

/**
 * Every holiday between two days, inclusive at both ends, in the order they fall.
 *
 * Inclusive because that is how a leave request is written — the first day off and
 * the last day off, both of them days somebody is away — and a half open range
 * here would quietly drop a Christmas Day that a request ended on.
 */
export function holidaysBetween(
  holidays: readonly Holiday[],
  from: CalendarDate,
  to: CalendarDate,
): Holiday[] {
  return holidays.filter((holiday) => from <= holiday.date && holiday.date <= to).sort(byDate);
}

/**
 * The leave years nobody has entered a calendar for yet.
 *
 * The guard on the one decision this story makes that could hurt somebody quietly.
 * Only 2026 is seeded, because two of Ghana's fourteen holidays cannot be known
 * for a future year and a calendar that is twelve thirteenths right is worse than
 * one that is visibly empty — a wrong row is believed, an empty year is a screen
 * with nothing on it.
 *
 * This is what makes it visible. A leave year with no holidays in it is not a year
 * with no holidays; it is a year nobody has transcribed the gazette for, and
 * everybody in it will be charged a day for Christmas until somebody does. HR sees
 * that before December rather than in January.
 *
 * The years are returned rather than a boolean, because "2027 and 2028 have no
 * calendar" is what a warning has to say and a `true` is not.
 */
export function yearsWithoutHolidays(
  years: readonly LeaveYear[],
  holidays: readonly Holiday[],
): LeaveYear[] {
  return years.filter((year) => !holidays.some((holiday) => coversDay(year, holiday.date)));
}

/** Holidays in the order they fall, which is the order every calendar shows them. */
export function byDate(left: Holiday, right: Holiday): number {
  return left.date < right.date ? -1 : left.date > right.date ? 1 : 0;
}

/* ---------------------------------------------------------------- the fields */

/**
 * What the day is called on the calendar somebody reads it from.
 *
 * Trimmed rather than refused when it arrives padded, as a department name is.
 * Deliberately no rule about what it may say: it is whatever the gazette called
 * it, and a system that refused 'Eid al-Fitr and Independence Day' because it held
 * two names would be refusing the sentence the gazette actually printed.
 */
function requireName(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidHoliday(
      'name',
      'A public holiday needs a name. It is what the gazette calls the day, and what ' +
        "somebody reads beside it on a calendar — Christmas Day, Farmers' Day.",
    );
  }

  const name = value.trim();

  if (name.length > 80) {
    throw new InvalidHoliday(
      'name',
      'A public holiday name is longer than the 80 characters the record holds.',
    );
  }

  return name;
}

function requireDay(value: unknown): CalendarDate {
  if (!isCalendarDate(value)) {
    throw new InvalidHoliday(
      'date',
      'A public holiday is a date in the form YYYY-MM-DD. The office is closed on a ' +
        'day, so it is written as one — 06/03/2026 and 03/06/2026 are the same ten ' +
        'characters meaning two different days, and one of them is Independence Day.',
    );
  }

  return value;
}
