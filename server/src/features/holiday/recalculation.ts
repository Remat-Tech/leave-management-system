/**
 * A public holiday declared inside leave somebody already had agreed. FR 25, §8.8, LMS 508.
 */

import { countLeaveDays, type LeavePeriod } from '../leave-calculator/leave-calculator.js';
import type { Holiday } from './holiday.js';
import { countsWorkingDays, type LeaveType } from '../leave-type/leave-type.js';
import type { LeaveRequest } from '../leave-request/leave-request.js';
import { type CalendarDate, formatDay } from '../../shared/time.js';
import type { WorkPattern } from '../work-pattern/work-pattern.js';

/** The shape a credit has by the time it reaches the repository. */
export interface ValidatedRecalculation {
  leaveRequestId: string;
  holidayId: string;
  holidayDate: CalendarDate;
  days: number;
  /** FR 27. The sentence the ledger entry carries. */
  reason: string;
  ledgerEntryId: string;
}

/** One as it comes back out, with who ran it. FR 52. */
export interface Recalculation extends ValidatedRecalculation {
  id: string;
  recordedBy: string;
  recordedByEmployeeId: string | null;
  recordedAt: Date;
}

/** Why a day inside somebody's leave credits them nothing. FR 25, §7.3. */
export const NOT_CREDITED_REASONS = [
  'ALREADY_CREDITED',
  'COUNTS_CALENDAR_DAYS',
  'NOT_A_DAY_THEY_WORK',
] as const;

export type NotCredited = (typeof NOT_CREDITED_REASONS)[number];

/** What a holiday does to one piece of agreed leave. */
export interface WhatItCredits {
  /** The difference, and nought where the day cost nothing anyway. */
  days: number;
  /** Why nothing is credited, or null where something is. */
  because: NotCredited | null;
}

/* ------------------------------------------------------------- what is valid */

/**
 * What a holiday credits one piece of agreed leave, and why it credits nothing. FR 25, §7.3.
 *
 * The story's third criterion is the first line of the body: the figure is the *difference*
 * between what the calculator says the leave costs with the day on the calendar and what it
 * said without it, over the request's own period and on the basis it was priced under.
 * Nothing here counts anything itself, which is what stops a second idea of what a fortnight
 * costs appearing beside `countLeaveDays`.
 *
 * The story's second criterion falls out of that rather than being imposed on it. A
 * `CALENDAR_DAYS` type does not consult the calendar, so both counts are the same and the
 * difference is nought — maternity leave is not shortened by Christmas. The same is true of
 * a holiday landing on somebody's rest day: the pattern is asked before the calendar, so
 * the day was free already.
 *
 * Which of the two it was is still worth saying, so `because` names it. "Nothing changed"
 * is not an answer HR can check the gazette against; "Boxing Day is a Saturday for Ama" is.
 */
export function whatAHolidayCredits(input: {
  request: LeaveRequest;
  type: LeaveType;
  pattern: WorkPattern;
  holiday: Holiday;
  /** The calendar over the request's dates as it now stands, the new day included. */
  calendar: readonly Holiday[];
  /** FR 25. Whether this holiday has already credited this leave. */
  alreadyCredited: boolean;
}): WhatItCredits {
  const { request, type, pattern, holiday, calendar, alreadyCredited } = input;

  if (alreadyCredited) {
    return { days: 0, because: 'ALREADY_CREDITED' };
  }

  /** FR 11, LMS 303. The basis the request was priced under, not the type's as it stands. */
  const basis = { ...type, countingBasis: request.countingBasis };
  const period: LeavePeriod = { from: request.from, to: request.to };

  const now = countLeaveDays(basis, period, pattern, calendar);
  const before = countLeaveDays(
    basis,
    period,
    pattern,
    calendar.filter((one) => one.id !== holiday.id),
  );

  const days = before.days - now.days;

  if (days <= 0) {
    return {
      days: 0,
      because: countsWorkingDays(basis) ? 'NOT_A_DAY_THEY_WORK' : 'COUNTS_CALENDAR_DAYS',
    };
  }

  return { days, because: null };
}

/* ----------------------------------------------------------------- the words */

/**
 * The sentence the `RECALCULATION` carries. FR 27, FR 25.
 *
 * Names the gazetted day rather than the act, because the question somebody asks of this
 * line a year later is "why did I get a day back in March", and "Independence Day" answers
 * it where "recalculated" does not.
 */
export function reasonForRecalculation(input: {
  typeName: string;
  holiday: Holiday;
  days: number;
}): string {
  const { typeName, holiday, days } = input;

  return (
    `${days} ${days === 1 ? 'day' : 'days'} of ${typeName} credited back, ` +
    `${holiday.date} declared ${holiday.name} after this leave was approved`
  );
}

/** Why a day inside somebody's leave gave them nothing back, said to HR. NFR USA 03. */
export function notCreditedInWords(because: NotCredited, typeName: string): string {
  switch (because) {
    case 'ALREADY_CREDITED':
      return (
        'This day has already been credited back to this leave. A second credit would ' +
        'give back a day that was only ever charged once.'
      );
    case 'COUNTS_CALENDAR_DAYS':
      return (
        `${typeName} is counted in calendar days, so it never skipped a public holiday ` +
        'and a new one changes nothing about what it cost. FR 21, §7.3.'
      );
    default:
      return (
        'The holiday falls on a day this person does not work, so it cost them ' +
        'nothing in the first place. FR 23, §7.3.'
      );
  }
}

/** One credit, in the words the person whose leave it is reads. NFR USA 03. */
export function recalculationInWords(credited: Recalculation, holidayName: string): string {
  return (
    `${credited.days} ${credited.days === 1 ? 'day' : 'days'} of this leave — ` +
    `${formatDay(credited.holidayDate)}, ${holidayName} — is back in your balance. The ` +
    'country was not working, so you are not charged leave for it.'
  );
}
