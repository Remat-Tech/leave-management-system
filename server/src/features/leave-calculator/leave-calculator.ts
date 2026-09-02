/**
 * How many days a period of leave costs. FR 21, FR 22, §7.3., LMS 207, FR 23, FR 31, LMS 303, FR 25, LMS 210, LMS 211, §8.6, FR 24, §8..
 */

import { type Holiday, holidayOn } from '../holiday/holiday.js';
import { countsWorkingDays, type LeaveType } from '../leave-type/leave-type.js';
import {
  type CalendarDate,
  calendarDaysBetween,
  eachDay,
  isCalendarDate,
  isoWeekdayOf,
} from '../../shared/time.js';
import { type WorkPattern, worksOn } from '../work-pattern/work-pattern.js';

/** The days somebody is away, inclusive at both ends. */
export interface LeavePeriod {
  from: CalendarDate;
  to: CalendarDate;
}

/** Why a day inside the period cost nothing. */
export const FREE_REASONS = ['NOT_A_WORKING_DAY', 'PUBLIC_HOLIDAY'] as const;

export type FreeReason = (typeof FREE_REASONS)[number];

/** One day inside the period that cost nothing, and why. NFR USA 03. */
export interface FreeDay {
  date: CalendarDate;
  because: FreeReason;
  /** The holiday's name, where that is the reason. */
  name: string | null;
}

/** What a period of leave costs, and the days inside it that were free. */
export interface DayCount {
  /** Whole days this leave costs. FR 24. */
  days: number;
  /** Every day the period spans, counted or not. */
  calendarDays: number;
  /** The days inside the period that cost nothing, in the order they fall. */
  free: FreeDay[];
}

/** A period that is not a period. NFR USA 03. */
export class InvalidLeavePeriod extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidLeavePeriod';
    this.field = field;
  }
}

/** What a period of leave of this kind costs. FR 22. */
export function countLeaveDays(
  type: LeaveType,
  period: LeavePeriod,
  pattern: WorkPattern,
  holidays: readonly Holiday[],
): DayCount {
  const { from, to } = validateLeavePeriod(period);

  const free: FreeDay[] = [];
  let days = 0;

  for (const day of eachDay(from, to)) {
    const reason = freeDayFor(type, day, pattern, holidays);

    if (reason === null) {
      days += 1;
    } else {
      free.push(reason);
    }
  }

  return { days, calendarDays: calendarDaysBetween(from, to), free };
}

/** Whether this one day costs a day of this kind of leave. FR 25. */
export function costsADay(
  type: LeaveType,
  day: CalendarDate,
  pattern: WorkPattern,
  holidays: readonly Holiday[],
): boolean {
  return freeDayFor(type, day, pattern, holidays) === null;
}

/** Why a day is free, or null where it costs a day. FR 21, FR 25. */
function freeDayFor(
  type: LeaveType,
  day: CalendarDate,
  pattern: WorkPattern,
  holidays: readonly Holiday[],
): FreeDay | null {
  if (!countsWorkingDays(type)) {
    return null;
  }

  if (!worksOn(pattern, isoWeekdayOf(day))) {
    return { date: day, because: 'NOT_A_WORKING_DAY', name: null };
  }

  const holiday = holidayOn(holidays, day);
  if (holiday !== undefined) {
    return { date: day, because: 'PUBLIC_HOLIDAY', name: holiday.name };
  }

  return null;
}

/** The longest period this will count, in calendar days. FR 20a, LMS 309, FR 16, FR 26. */
const LONGEST_PERIOD_DAYS = 731;

/** Two dates that make a period, or a refusal naming the one that does not. FR 20a, LMS 309. */
export function validateLeavePeriod(period: LeavePeriod): LeavePeriod {
  const from = requireDay('from', period.from);
  const to = requireDay('to', period.to);

  if (to < from) {
    throw new InvalidLeavePeriod(
      'to',
      `Leave cannot end on ${to}, before it starts on ${from}. Both days are inside ` +
        'the period, so a single day off is the same date twice.',
    );
  }

  if (calendarDaysBetween(from, to) > LONGEST_PERIOD_DAYS) {
    throw new InvalidLeavePeriod(
      'to',
      `${from} to ${to} is over two years of leave. Check the year — the longest ` +
        'absence this system knows about is four months of maternity leave and the ' +
        'unpaid extension after it.',
    );
  }

  return { from, to };
}

function requireDay(field: string, value: unknown): CalendarDate {
  if (!isCalendarDate(value)) {
    throw new InvalidLeavePeriod(
      field,
      `The ${field === 'from' ? 'first' : 'last'} day of a period of leave is a date in ` +
        'the form YYYY-MM-DD. Leave is taken on days, so it is written as one — ' +
        '31/07/2026 and 07/31/2026 are the same eleven characters meaning two ' +
        'different days.',
    );
  }

  return value;
}
