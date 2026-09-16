/** Pro rating an entitlement for part of a year. FR 29, FR 29a, §8.6, LMS 215, LMS 013. */

import { calendarDaysBetween, type CalendarDate } from '../../shared/time.js';

/** The leave year being pro rated within. */
export interface LeaveYearDates {
  startsOn: CalendarDate;
  endsOn: CalendarDate;
}

/** Somebody's employment, as far as it is known today. */
export interface Employment {
  startedOn: CalendarDate;
  /** Their last day, or null while they are still here. */
  leftOn: CalendarDate | null;
}

/** The part of a leave year somebody was employed for. */
export interface EmployedPortion {
  from: CalendarDate;
  to: CalendarDate;
}

/** What a rule is asked. */
export interface ProRataInput {
  /** What a whole year of this leave type is worth to this person. */
  fullYearDays: number;
  year: LeaveYearDates;
  portion: EmployedPortion;
}

/** One way of working out what part of a year is worth. */
export interface ProRataRule {
  readonly name: string;
  /** One line, for a report and for the person asking why they have 10.08 days. */
  readonly says: string;
  daysOf(input: ProRataInput): number;
}

/** §8.6d, and the worked example it gives: a joiner on 1 July is owed 20 × 184/365 = 10.08 days. */
export const BY_CALENDAR_DAYS: ProRataRule = {
  name: 'calendar-days',
  says: 'a share of the year in proportion to the calendar days employed',

  daysOf({ fullYearDays, year, portion }: ProRataInput): number {
    const inTheYear = calendarDaysBetween(year.startsOn, year.endsOn);

    if (inTheYear === 0) {
      return 0;
    }

    return round((fullYearDays * calendarDaysBetween(portion.from, portion.to)) / inTheYear);
  },
};

/** A candidate, and **not the rule in force**. LMS 013. */
export const BY_COMPLETED_TWELFTHS: ProRataRule = {
  name: 'completed-twelfths',
  says: 'a twelfth of the year for each complete twelfth of it employed',

  daysOf({ fullYearDays, year, portion }: ProRataInput): number {
    const inTheYear = calendarDaysBetween(year.startsOn, year.endsOn);

    if (inTheYear === 0) {
      return 0;
    }

    const twelfths = Math.floor(calendarDaysBetween(portion.from, portion.to) / (inTheYear / 12));

    return round((fullYearDays * Math.min(twelfths, 12)) / 12);
  },
};

/**
 * Every rule there is, so that a name read back off an old ledger entry can be turned into the sentence that explains it.
 */
/**
 * §8.6d's share by calendar day, rounded to the nearest whole day. LMS 013, decided 2026-09-16.
 *
 * Whole days because a balance of 8.27 reads as a mistake to the person holding it. Calendar days
 * rather than completed months because months are harsher on exactly the people nobody means to
 * be harsh on: somebody starting on the 5th of January loses the whole of it, and only a multiple
 * of three months comes out whole anyway.
 *
 * Nearest rather than always up, so the rounding is a wash across the company rather than a
 * small standing gift.
 */
export const BY_CALENDAR_DAYS_TO_THE_DAY: ProRataRule = {
  name: 'calendar-days-to-the-day',
  says: 'a share of the year in proportion to the calendar days employed, to the nearest whole day',

  daysOf(input: ProRataInput): number {
    return Math.round(BY_CALENDAR_DAYS.daysOf(input));
  },
};

export const PRO_RATA_RULES: readonly ProRataRule[] = [
  BY_CALENDAR_DAYS,
  BY_COMPLETED_TWELFTHS,
  BY_CALENDAR_DAYS_TO_THE_DAY,
];

/** The one a leaver's accrual is settled by: to the hundredth, as payroll settles. §8.6, LMS 013. */
export const THE_RULE_IN_FORCE: ProRataRule = BY_CALENDAR_DAYS;

/**
 * The one a joiner's grant is sized by: whole days, so nobody's balance reads 8.27. LMS 013.
 *
 * Apart from the settlement rule on purpose. A balance is something a person reads and plans
 * around; a settlement is money, and rounding what somebody is paid on leaving is a payroll
 * decision nobody has taken.
 */
export const THE_GRANT_RULE: ProRataRule = BY_CALENDAR_DAYS_TO_THE_DAY;

/** The rule of that name, or undefined. */
export function ruleNamed(name: string): ProRataRule | undefined {
  return PRO_RATA_RULES.find((rule) => rule.name === name);
}

/** The part of the leave year somebody was employed for, or nothing. */
export function employedPortionOf(
  year: LeaveYearDates,
  employment: Employment,
): EmployedPortion | undefined {
  const from = later(year.startsOn, employment.startedOn);
  const to = earlier(year.endsOn, employment.leftOn ?? year.endsOn);

  return from > to ? undefined : { from, to };
}

/** Whether somebody was employed for every day of the year. */
export function coversTheWholeYear(year: LeaveYearDates, portion: EmployedPortion): boolean {
  return portion.from <= year.startsOn && portion.to >= year.endsOn;
}

/** What somebody is owed for the part of the year they were employed. */
export function proRataDaysFor(input: ProRataInput, rule: ProRataRule = THE_RULE_IN_FORCE): number {
  return rule.daysOf(input);
}

/** The later of two days, as text. */
function later(one: CalendarDate, other: CalendarDate): CalendarDate {
  return one > other ? one : other;
}

function earlier(one: CalendarDate, other: CalendarDate): CalendarDate {
  return one < other ? one : other;
}

/** Two decimal places, which is what the ledger's `days` column holds. FR 24, §8.6. */
function round(days: number): number {
  return Math.round(days * 100) / 100;
}
