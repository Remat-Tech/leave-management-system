/**
 * How many days a period of leave costs. FR 21, FR 22, §7.3. LMS 207.
 *
 * The story is an employee whose leave is counted by the rule that belongs to the
 * kind of leave it is: a fortnight of annual leave skips the weekend inside it, and
 * a hundred and twenty days of maternity leave does not, "since they are expressed
 * as a continuous period of absence rather than an allowance of workdays".
 *
 * Three tables have been built for this one function to read, and this is where
 * they meet: the working pattern of FR 23, the public holiday calendar of FR 22,
 * and the `counting_basis` of the leave type. Nothing before now put them together,
 * and ./work-pattern.ts said so in as many words — "Turning a date range into a
 * number of days also needs public holidays and the counting basis of the leave
 * type, neither of which exists yet." Both exist now.
 *
 * ## One function with one branch, not two functions
 *
 * That is design principle 5 of the Technical Design Document, and it is the whole
 * shape of {@link countLeaveDays}. There is a single walk over the days of the
 * period, and inside it a single question — does this day cost a day — answered by
 * {@link costsADay}. A `countWorkingDays()` beside a `countCalendarDays()` would be
 * two implementations of "which days are in this period" that could drift, and the
 * drift would show up as a maternity leave a day longer than the annual leave over
 * the same fortnight.
 *
 * **The branch is on the basis and never on the code.** {@link countsWorkingDays}
 * in ./leave-type.ts is what is asked, and `leave_type.code` is not read here, is
 * not imported here, and must never be: "If either is written as an `if` on a type
 * code, every future leave type becomes a code change." A type added by HR next
 * year with `CALENDAR_DAYS` on it counts correctly the moment the row exists,
 * without anybody touching this file — which is the test of whether FR 31 has
 * actually been achieved rather than merely described.
 *
 * ## Pure, and what that costs the caller
 *
 * Nothing here reads a database, a clock or an environment. The pattern and the
 * calendar arrive as arguments, exactly as {@link worksOn} takes a weekday and
 * {@link assertDoesNotReachIntoAClosedYear} takes a boundary: the domain knows the
 * rule, the caller brings the facts. ../services/leave-calculator-service.ts is the
 * caller that fetches them, and it fetches those two things and nothing else.
 *
 * The cost is that the caller has to hand over a calendar that actually covers the
 * period. A holiday list missing December is not an error this function can see —
 * it looks exactly like a December with no holidays in it — which is why the
 * service reads the holidays *for the period* rather than being handed whatever
 * somebody had loaded, and why {@link yearsWithoutHolidays} exists to catch the
 * year nobody has transcribed a gazette for.
 *
 * ## Nothing at all is counted, and nothing at all is returned
 *
 * A Saturday to Sunday request against a Monday to Friday pattern costs zero days of
 * annual leave, and zero is what comes back. **It used to be a refusal thrown from
 * here, and LMS 303 moved that refusal to ../domain/leave-request.ts** —
 * `assertItCostsSomething()`, raised by the submission validator on the answer this
 * function gave.
 *
 * The move is the difference between a fact and a judgement. That the period costs
 * nothing is arithmetic, and it is arithmetic FR 25 has a legitimate use for: a
 * recalculation asks what a period costs *now* and compares, and a function that
 * threw rather than answering would make "it costs nothing now" the one comparison
 * that could not be made. Whether a request may be *submitted* for it is a rule about
 * requests, and the file that owns requests is where it can sit beside the two other
 * refusals it belongs with — a period the wrong way round, and one that runs past a
 * year end.
 *
 * What is left here is total: every period this is handed comes back as a number,
 * and `free` says which days inside it were not charged and why. That is what the
 * refusal needs to name the days, and it is why the refusal takes a {@link DayCount}
 * rather than recounting.
 *
 * Zero can only happen to a working-day type. Every day of a period counts for a
 * calendar-day one, and a period always holds at least one day, so a maternity leave
 * costing nothing is not a state this function can produce.
 *
 * ## What is deliberately not here
 *
 * **No balance.** Whether somebody *has* the days this returns is
 * `leave_balance` and the ledger, LMS 210 and LMS 211. This says what the leave
 * costs, not whether it can be afforded, and keeping those apart is what lets sick
 * leave go negative on purpose — §8.6b.
 *
 * **No half days.** FR 24: whole days only. A morning off is settled with a manager
 * and is deliberately not in this system, so every number here is an integer and
 * there is no rounding rule to get wrong.
 *
 * **No recalculation.** FR 25 gives a day back on an already approved request when
 * a holiday is declared inside it. That is this function run again over the same
 * period with the new calendar, and comparing — but the comparing, and deciding
 * what to do about it, belongs to the request workflow of §8. What this file
 * contributes is that running it again is cheap and gives the same answer for the
 * same inputs.
 *
 * **No policy.** There is no {@link Actor} here and there is none in a `/domain`
 * file anywhere. Who may ask what a period would cost is
 * ../services/leave-calculator-service.ts.
 */

import { type Holiday, holidayOn } from './holiday.js';
import { countsWorkingDays, type LeaveType } from './leave-type.js';
import {
  type CalendarDate,
  calendarDaysBetween,
  eachDay,
  isCalendarDate,
  isoWeekdayOf,
} from './time.js';
import { type WorkPattern, worksOn } from './work-pattern.js';

/**
 * The days somebody is away, inclusive at both ends.
 *
 * Both ends inside the period, because that is how a person writes it: away from
 * the twenty first to the thirty first means both of those days. A half open range
 * would make every request a day shorter than the one somebody typed, and would do
 * it quietly.
 */
export interface LeavePeriod {
  from: CalendarDate;
  to: CalendarDate;
}

/** Why a day inside the period cost nothing. */
export const FREE_REASONS = ['NOT_A_WORKING_DAY', 'PUBLIC_HOLIDAY'] as const;

export type FreeReason = (typeof FREE_REASONS)[number];

/**
 * One day inside the period that cost nothing, and why.
 *
 * This is what turns a number into a sentence somebody accepts. "Nine days off cost
 * you seven" is an assertion; "the twenty fifth is Christmas Day and the twenty
 * sixth is Boxing Day" is an explanation, and NFR USA 03 asks for the second.
 */
export interface FreeDay {
  date: CalendarDate;
  because: FreeReason;
  /** The holiday's name, where that is the reason. Null for a day not worked. */
  name: string | null;
}

/**
 * What a period of leave costs, and the days inside it that were free.
 *
 * `free` rather than a whole day-by-day breakdown, because the days that cost
 * something are the ones the number already accounts for and listing them again
 * would be the period restated. What a person wants named is the exceptions, and
 * for a fortnight there are rarely more than four of them.
 */
export interface DayCount {
  /**
   * Whole days this leave costs. FR 24.
   *
   * Zero where nothing in the period is charged, which is an answer rather than a
   * failure — see the module note. A request for such a period is refused by
   * `assertItCostsSomething()` in ./leave-request.ts, which reads this and `free`.
   */
  days: number;
  /** Every day the period spans, counted or not. */
  calendarDays: number;
  /** The days inside the period that cost nothing, in the order they fall. */
  free: FreeDay[];
}

/**
 * A period that is not a period.
 *
 * The same shape as {@link InvalidLeaveType} and for the same reason, NFR USA 03:
 * the message has to reach the form beside the input it is about, and this form has
 * two inputs whose rule spans both.
 */
export class InvalidLeavePeriod extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidLeavePeriod';
    this.field = field;
  }
}

/* --------------------------------------------------------------- the counting */

/**
 * What a period of leave of this kind costs. The story.
 *
 * One walk and one branch. {@link costsADay} is asked once per day, and it is the
 * only place either the pattern or the calendar is consulted — so a calendar-day
 * type never touches either, which is FR 22's "the working pattern is not consulted
 * at all" said as code rather than as a comment.
 *
 * Throws {@link InvalidLeavePeriod} for two dates that are not a period, which is a
 * precondition rather than a judgement: there is no walk over a range that runs
 * backwards, and no number to give back for one. Every period that *is* a period
 * comes back as a count, zero included — see the module note for who refuses that
 * and why it is not refused here.
 */
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

/**
 * Whether this one day costs a day of this kind of leave.
 *
 * The primitive, exported beside the aggregate because FR 25 wants exactly it: a
 * public holiday declared inside an approved request gives a day back only if that
 * day was costing the person something, and for somebody who does not work
 * Wednesdays a Wednesday holiday changes nothing. Asking that of one day should not
 * mean recounting a fortnight.
 */
export function costsADay(
  type: LeaveType,
  day: CalendarDate,
  pattern: WorkPattern,
  holidays: readonly Holiday[],
): boolean {
  return freeDayFor(type, day, pattern, holidays) === null;
}

/**
 * Why a day is free, or null where it costs a day. The one branch.
 *
 * A calendar-day type returns null for every day without reading either argument,
 * which is the whole of FR 21's second half: maternity leave is a continuous period
 * of absence, so a weekend inside it is part of the hundred and twenty days and a
 * public holiday inside it is too.
 *
 * The pattern is asked before the calendar, and the order is the answer rather than
 * an optimisation. A Boxing Day that falls on a Saturday is reported as a day not
 * worked, because for somebody on a Monday to Friday week it was never going to
 * cost anything and the gazette had nothing to do with it — which is also what
 * makes FR 25's recalculation come out right: a holiday declared on a day somebody
 * does not work gives back nothing, and saying "Boxing Day" there would suggest
 * otherwise.
 */
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

/* ---------------------------------------------------------------- the period */

/**
 * The longest period this will count, in calendar days.
 *
 * Two years, and it is a guard against a typed year rather than a policy about
 * leave — the same distinction {@link requireWindow} in ./leave-type.ts draws when
 * it refuses a notice window of 365 days with "check the unit". The longest absence
 * this system knows about is a hundred and twenty days of maternity leave and its
 * unpaid extension; a period of three thousand days is somebody who typed 3026 in a
 * year field, and walking it would be a hang rather than an answer.
 *
 * Deliberately generous, because refusing a real request would be the worse
 * failure. Nothing here decides how long leave may be — that is the balance, and it
 * is somebody else's rule.
 */
const LONGEST_PERIOD_DAYS = 731;

/**
 * Two dates that make a period, or a refusal naming the one that does not.
 *
 * A period that runs backwards is refused rather than counted as nothing, and the
 * two are worth telling apart: a period covering no day is a mistake in the dates,
 * and a period covering days that all happen to be free is a mistake about the kind
 * of leave. Collapsing them into one message would send half the people who hit it
 * to correct the wrong field.
 *
 * A single day is a period. Somebody taking Friday off has written the same date
 * twice, which is neither a typo nor an edge case — it is the most common request
 * there is.
 *
 * Exported as well as used by {@link countLeaveDays}, because a caller has to be
 * able to ask this *before* it fetches anything. The service reads the holiday
 * calendar for the period, and a `from` of `31/07/2026` reaching a `WHERE
 * holiday_date >=` is a driver error where it should have been a sentence beside
 * the input — so the dates are judged first and the read happens on dates that are
 * dates. Calling it twice costs two string comparisons and buys one error message.
 */
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
