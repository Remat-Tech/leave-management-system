/** Carried days expiring at the deadline the entitlement rule names. FR 36a. */

import { type LeaveBalance, unusedCarriedOver } from '../balance/balance.js';
import type { CalendarDate } from '../../shared/time.js';

/** Why carried days were not expired, in the words a report uses. */
export const NOT_EXPIRED = ['NEVER_EXPIRES', 'NOT_YET', 'NOTHING_LEFT'] as const;

export type NotExpiredBecause = (typeof NOT_EXPIRED)[number];

/** One balance with carried days in it, and everything the expiry turns on. */
export interface ExpiryCandidate {
  /** The year the days were carried into. */
  yearStartDate: CalendarDate;
  /** Off the rule in force on the first day of that year; null or undefined where nothing expires. */
  carryoverExpiryMonth: number | null | undefined;
  asAt: CalendarDate;
  balance: LeaveBalance;
}

export type ExpiryDecision =
  | { days: number; deadline: CalendarDate }
  | { because: NotExpiredBecause; deadline: CalendarDate | null };

export function wasExpired(
  decision: ExpiryDecision,
): decision is { days: number; deadline: CalendarDate } {
  return 'days' in decision;
}

/** The last day of the named month, the first time it ends inside the year. */
export function carryoverDeadline(yearStartDate: CalendarDate, month: number): CalendarDate {
  const startYear = Number(yearStartDate.slice(0, 4));
  const endOf = (year: number) => new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const deadline = endOf(startYear);

  return deadline < yearStartDate ? endOf(startYear + 1) : deadline;
}

/** How many carried days expire. Only once the deadline has passed. */
export function decideTheExpiry(candidate: ExpiryCandidate): ExpiryDecision {
  const month = candidate.carryoverExpiryMonth;

  if (month === null || month === undefined) {
    return { because: 'NEVER_EXPIRES', deadline: null };
  }

  const deadline = carryoverDeadline(candidate.yearStartDate, month);

  if (candidate.asAt <= deadline) {
    return { because: 'NOT_YET', deadline };
  }

  const days = unusedCarriedOver(candidate.balance);

  return days > 0 ? { days, deadline } : { because: 'NOTHING_LEFT', deadline };
}

/** What the ledger entry says. FR 27. */
export function reasonForExpiry(
  leaveTypeName: string,
  leaveYearLabel: string,
  deadline: CalendarDate,
): string {
  return `${leaveTypeName} carried into ${leaveYearLabel} and not used by ${deadline} expired. FR 36a`;
}

/* ------------------------------------------------------------------- what a run did */

export interface Expired {
  employeeId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  leaveYearLabel: string;
  deadline: CalendarDate;
  days: number;
  entryId: string;
}

export interface NotExpired {
  employeeId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  leaveYearLabel: string;
  because: NotExpiredBecause;
}

export interface CarryoverExpiryRun {
  asAt: CalendarDate;
  ranAt: Date;
  expired: readonly Expired[];
  notExpired: readonly NotExpired[];
}

export function daysExpired(run: CarryoverExpiryRun): number {
  return round(run.expired.reduce((total, one) => round(total + one.days), 0));
}

export function notExpiredCounts(run: CarryoverExpiryRun): Record<NotExpiredBecause, number> {
  const counts = Object.fromEntries(NOT_EXPIRED.map((reason) => [reason, 0])) as Record<
    NotExpiredBecause,
    number
  >;

  for (const one of run.notExpired) {
    counts[one.because] += 1;
  }

  return counts;
}

/** The run, as a few lines somebody can read. */
export function summaryOf(run: CarryoverExpiryRun): string {
  return [
    `Carried days expiry as at ${run.asAt}, run at ${run.ranAt.toISOString()}.`,
    '',
    `${run.expired.length} balances had carried days expire, ${daysExpired(run)} days in total.`,
  ].join('\n');
}

function round(days: number): number {
  return Math.round(days * 100) / 100;
}
