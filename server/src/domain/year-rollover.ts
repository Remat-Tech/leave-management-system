/** The year rollover. FR 36, FR 36a, §11., LMS 217, §8.9, FR 32g, LMS 205, LMS 212, FR 37a. */

import type { AnnualGrantRun } from './annual-grant.js';
import { summaryOf as summaryOfTheGrant } from './annual-grant.js';

/** Why days were not carried, in the words a report uses. */
export const NOT_CARRIED = [
  'ALREADY_CARRIED',
  'DOES_NOT_CARRY',
  'NO_ENTITLEMENT_RULE',
  'NOTHING_LEFT',
  'IN_ARREARS',
] as const;

export type NotCarriedBecause = (typeof NOT_CARRIED)[number];

/** One person, one leave type, and everything the carry turns on. */
export interface CarryCandidate {
  /**
   * What is left in the closing year's balance: `available`, which is what somebody could still have booked on the last day of it.
   */
  available: number;
  /** FR 36, and `leave_entitlement_rule.carries_over`. */
  carriesOver: boolean | undefined;
  /** FR 36a, and `leave_entitlement_rule.carryover_max_days`. */
  carryoverMaxDays: number | null;
}

/** Carried, and how much; or not, and why. */
export type CarryDecision =
  { days: number; cappedFrom: number | null } | { because: NotCarriedBecause };

/** Whether the decision was to carry. */
export function wasCarried(
  decision: CarryDecision,
): decision is { days: number; cappedFrom: number | null } {
  return 'days' in decision;
}

/** How much of this balance crosses into the new year. FR 36, FR 36a. */
export function decideTheCarry(candidate: CarryCandidate): CarryDecision {
  if (candidate.carriesOver === undefined) {
    return { because: 'NO_ENTITLEMENT_RULE' };
  }

  /** FR 36 and the story's third and fourth criteria, as one line reading one column. */
  if (!candidate.carriesOver) {
    return { because: 'DOES_NOT_CARRY' };
  }

  if (candidate.available < 0) {
    return { because: 'IN_ARREARS' };
  }

  if (candidate.available === 0) {
    return { because: 'NOTHING_LEFT' };
  }

  const cap = candidate.carryoverMaxDays;

  return cap !== null && candidate.available > cap
    ? { days: cap, cappedFrom: candidate.available }
    : { days: candidate.available, cappedFrom: null };
}

/** What the ledger entry says. FR 27. */
export function reasonForCarry(
  leaveTypeName: string,
  closingLabel: string,
  openingLabel: string,
  decision: { days: number; cappedFrom: number | null },
): string {
  const carried = `Unused ${leaveTypeName} from ${closingLabel} carried into ${openingLabel}`;

  return decision.cappedFrom === null
    ? carried
    : `${carried}, capped at ${decision.days} of ${decision.cappedFrom} days. FR 36a`;
}

/* ------------------------------------------------------------------- what a run did */

/** Whether this run closed the year, or found it already settled. */
export type HowItClosed = 'CLOSED_BY_THIS_RUN' | 'ALREADY_CLOSED';

/** One carry that was posted. */
export interface Carried {
  employeeId: string;
  employeeNumber: string;
  leaveTypeId: string;
  leaveTypeName: string;
  days: number;
  /** What it would have been without FR 36a's cap, or null where nothing was capped. */
  cappedFrom: number | null;
  /** The ledger entry, so a report can be traced to the movement it caused. */
  entryId: string;
}

/** One that was not, and why. */
export interface NotCarried {
  employeeId: string;
  employeeNumber: string;
  leaveTypeId: string;
  leaveTypeName: string;
  because: NotCarriedBecause;
}

/**
 * Days still held for a request nobody decided, in a year that has now closed.
 *
 * Not an outcome of the carry — those days are spoken for, so they are not unused and
 * `available` has already left them out — but the one thing this job can see that nobody
 * else will. A request left pending when its year closed can never be approved, because
 * the ledger refuses a `DEDUCTION` into a settled year, and the days are held against a
 * balance that no longer matters. Somebody has to release or adjust them, and this is
 * where they find out.
 */
export interface Unsettled {
  employeeId: string;
  employeeNumber: string;
  leaveTypeId: string;
  leaveTypeName: string;
  /** Days held in the closed year. Positive. */
  pending: number;
}

/** What one run of the rollover did. */
export interface YearRolloverRun {
  fromLeaveYearId: string;
  fromLeaveYearLabel: string;
  intoLeaveYearId: string;
  intoLeaveYearLabel: string;
  ranAt: Date;
  closed: HowItClosed;
  carried: readonly Carried[];
  notCarried: readonly NotCarried[];
  unsettled: readonly Unsettled[];
  /** The third act, delegated whole to the annual grant rather than reimplemented. */
  grant: AnnualGrantRun;
}

/** How many days the run moved across the boundary. */
export function daysCarried(run: YearRolloverRun): number {
  return round(run.carried.reduce((total, carry) => round(total + carry.days), 0));
}

/** How many days were lost to FR 36a's cap, which is nought on this company's figures. */
export function daysCapped(run: YearRolloverRun): number {
  return round(
    run.carried.reduce(
      (total, carry) =>
        carry.cappedFrom === null ? total : round(total + (carry.cappedFrom - carry.days)),
      0,
    ),
  );
}

/** How many balances were passed over for each reason. */
export function notCarriedCounts(run: YearRolloverRun): Record<NotCarriedBecause, number> {
  const counts = Object.fromEntries(NOT_CARRIED.map((reason) => [reason, 0])) as Record<
    NotCarriedBecause,
    number
  >;

  for (const one of run.notCarried) {
    counts[one.because] += 1;
  }

  return counts;
}

/**
 * Whether anything in this run needs a person to look at it.
 *
 * Two things do: a balance in arrears, which is a debt that did not cross the boundary,
 * and a request left pending in a year that has closed. Everything else in a rollover is
 * what was always going to happen.
 */
export function needsAttention(run: YearRolloverRun): boolean {
  return run.unsettled.length > 0 || notCarriedCounts(run).IN_ARREARS > 0;
}

/**
 * The run, as a few lines somebody can read.
 *
 * Not an email, for the reason the annual grant's summary is not one: a rollover on the
 * first of January is not a surprise, and the two things in it that are surprising are
 * named at the top rather than mailed separately. What this is for is the line a
 * scheduler logs and the thing an HR Administrator reads after running it by hand.
 *
 * The grant's own summary is nested rather than restated. It is the same run object the
 * annual job returns, and a second rendering of it here would be a second thing to keep
 * in step.
 */
export function summaryOf(run: YearRolloverRun): string {
  const counts = notCarriedCounts(run);
  const capped = daysCapped(run);

  return [
    `Year rollover: ${run.fromLeaveYearLabel} into ${run.intoLeaveYearLabel}, ` +
      `run at ${run.ranAt.toISOString()}.`,
    '',
    run.closed === 'CLOSED_BY_THIS_RUN'
      ? `${run.fromLeaveYearLabel} was closed by this run.`
      : `${run.fromLeaveYearLabel} was already closed, and was left exactly as it was.`,
    '',
    `${run.carried.length} balances carried forward, ${daysCarried(run)} days in total` +
      (capped > 0 ? `, with ${capped} days lost to a carry over cap. FR 36a.` : '.'),
    ...(run.notCarried.length === 0
      ? []
      : [
          '',
          `${run.notCarried.length} carried nothing:`,
          ...NOT_CARRIED.filter((reason) => counts[reason] > 0).map(
            (reason) => `  ${counts[reason]} ${sentenceFor(reason)}`,
          ),
        ]),
    ...(run.unsettled.length === 0
      ? []
      : [
          '',
          `${run.unsettled.length} still have days held for a request that was never ` +
            `decided, in a year that is now closed. Those days cannot be approved and ` +
            `did not carry; release or adjust them.`,
        ]),
    '',
    summaryOfTheGrant(run.grant),
  ].join('\n');
}

/** Each reason, said in a way that carries what to do about it. */
function sentenceFor(because: NotCarriedBecause): string {
  switch (because) {
    case 'ALREADY_CARRIED':
      return 'had already been carried, and were left exactly as they were.';
    case 'DOES_NOT_CARRY':
      return 'are a leave type whose unused days do not carry over. FR 36.';
    case 'NO_ENTITLEMENT_RULE':
      return 'have no entitlement rule saying whether the type carries over.';
    case 'NOTHING_LEFT':
      return 'had nothing left to carry.';
    case 'IN_ARREARS':
      return (
        'are overdrawn, so nothing was carried and nothing was written off. ' + 'Look at these.'
      );
  }
}

/** Two decimal places, which is what the ledger's column holds. See ./balance.ts. */
function round(days: number): number {
  return Math.round(days * 100) / 100;
}
