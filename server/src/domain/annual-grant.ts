/**
 * The annual grant of entitlement. FR 30. LMS 214.
 *
 * The story is the first sentence an employee reads in January: this is what you have
 * for the year. Everything in this system so far can record days moving and can add
 * them up; nothing has yet put any there. This is where the balances stop being nought.
 *
 * ## One decision, made the same way for everybody
 *
 * {@link decideTheGrant} is the whole of the rule, and it is a pure function so that
 * the answer for four hundred people is four hundred applications of one sentence
 * rather than a loop with four conditions grown into it.
 *
 * It says yes or it says why not, and the four reasons it can give are all outcomes
 * somebody might otherwise mistake for the job having missed them:
 *
 *   **They joined after the year began.** They are owed a proportion rather than the
 *   whole figure, which is §8.6d and FR 29 and is not this story. Reported rather than
 *   silently passed over, because "the grant ran and Ama has nothing" needs to be a
 *   sentence somebody can read the reason for.
 *
 *   **Nobody has said what this type is worth to them.** Unpaid leave has no
 *   entitlement rule at all, deliberately — FR 32h is agreed occasion by occasion — so
 *   this is the ordinary case rather than a fault. A rule of *nought* days is a
 *   different thing and is granted as nought... which is to say, refused, because a
 *   ledger entry of no days is not a movement. Both are reported, separately, because
 *   "HR said this is worth nothing" and "HR has not said" are different conversations.
 *
 *   **The type is not open to them.** FR 05's gender restriction, read off the type.
 *
 *   **It has already been granted.** The one reason this file does not decide; see
 *   below.
 *
 * ## What is deliberately not decided here
 *
 * **Whether a grant has already been posted.** That is the question the year's grant
 * turns on and it is not asked here, because a pure function asking it would be asking
 * it a moment before the write — which is the window LMS 212 built a lock to close.
 * `BalanceService.grantTheYear` asks it inside that lock, and this file's caller learns
 * the answer by being refused. See `daysToGrant` in ./balance.ts.
 *
 * **Which types get a yearly grant at all.** `hasRunningBalance` in ./leave-type.ts,
 * FR 32g: a quota type's entitlement arrives with the year, an event type's arrives
 * with the event. The job filters on it before a candidate is ever built, so this file
 * never sees a maternity leave type and has no opinion about one.
 */

import type { CalendarDate } from './time.js';

/**
 * Why somebody was not granted, in the words a report uses.
 *
 * Closed, and each is a different thing to do about it: wait for the pro rata story,
 * ask HR to write a rule, correct a record, or nothing at all.
 */
export const NOT_GRANTED = [
  'ALREADY_GRANTED',
  'JOINED_AFTER_THE_YEAR_BEGAN',
  'NO_ENTITLEMENT_RULE',
  'WORTH_NOTHING',
  'NOT_ELIGIBLE',
] as const;

export type NotGrantedBecause = (typeof NOT_GRANTED)[number];

/** One person, one leave type, and everything the decision turns on. */
export interface GrantCandidate {
  /** The day they joined. FR 29's pro rata question is entirely about this one. */
  startedOn: CalendarDate;
  /** The first day of the leave year being granted. */
  yearBeganOn: CalendarDate;
  /**
   * What the entitlement rule says this type is worth to them, or undefined where no
   * rule reaches them.
   *
   * Resolved by ./entitlement-rule.ts as at the first day of the year, which is the
   * day the grant is for. Asking on any other day would be granting a figure that was
   * not in force when the year began.
   */
  entitlementDays: number | undefined;
  /** FR 05. Whether the type is open to this person at all. */
  eligible: boolean;
}

/** Granted, and how much; or not, and why. */
export type GrantDecision = { days: number } | { because: NotGrantedBecause };

/** Whether the decision was to grant. */
export function wasGranted(decision: GrantDecision): decision is { days: number } {
  return 'days' in decision;
}

/**
 * What this person is granted of this leave type for this year. FR 30.
 *
 * The order of the four refusals is the order they are worth knowing about, and only
 * the first is load bearing: somebody who joined in July is not owed the whole figure
 * whatever the rule says, so that has to be asked before the figure is looked at. The
 * other three are independent and could be in any order.
 *
 * **The full year, and only the full year.** "Full year granted at the start of each
 * leave year" is the story's own criterion, and the proportion FR 29 gives a mid year
 * joiner is a different story with a formula in it. Granting them the whole figure now
 * and correcting it later would mean somebody planning a year around days they were
 * never owed, which is the failure this story exists to prevent rather than an
 * approximation of success.
 */
export function decideTheGrant(candidate: GrantCandidate): GrantDecision {
  if (candidate.startedOn > candidate.yearBeganOn) {
    return { because: 'JOINED_AFTER_THE_YEAR_BEGAN' };
  }

  if (!candidate.eligible) {
    return { because: 'NOT_ELIGIBLE' };
  }

  if (candidate.entitlementDays === undefined) {
    return { because: 'NO_ENTITLEMENT_RULE' };
  }

  /* A rule of nought days is HR saying this is worth nothing to this person, and a
     ledger entry of no days is not a movement — it would be a line in somebody's
     history that explains nothing. Told apart from having no rule at all, because one
     is a decision and the other is an absence. */
  if (candidate.entitlementDays <= 0) {
    return { because: 'WORTH_NOTHING' };
  }

  return { days: candidate.entitlementDays };
}

/* ------------------------------------------------------------------- what a run did */

/** One grant that was posted. */
export interface Granted {
  employeeId: string;
  employeeNumber: string;
  leaveTypeId: string;
  leaveTypeName: string;
  days: number;
  /** The ledger entry, so a report can be traced to the movement it caused. */
  entryId: string;
}

/** One that was not, and why. */
export interface NotGranted {
  employeeId: string;
  employeeNumber: string;
  leaveTypeId: string;
  leaveTypeName: string;
  because: NotGrantedBecause;
}

/** What one run of the annual grant did. */
export interface AnnualGrantRun {
  leaveYearId: string;
  leaveYearLabel: string;
  grantedAt: Date;
  granted: readonly Granted[];
  notGranted: readonly NotGranted[];
}

/** How many days the run put into people's balances. */
export function daysGranted(run: AnnualGrantRun): number {
  return round(run.granted.reduce((total, grant) => round(total + grant.days), 0));
}

/** How many were passed over for each reason. */
export function passedOver(run: AnnualGrantRun): Record<NotGrantedBecause, number> {
  const counts = Object.fromEntries(NOT_GRANTED.map((reason) => [reason, 0])) as Record<
    NotGrantedBecause,
    number
  >;

  for (const one of run.notGranted) {
    counts[one.because] += 1;
  }

  return counts;
}

/**
 * The run, as a few lines somebody can read.
 *
 * Not an email. Nothing about a grant is a surprise — it is January and this was
 * always going to happen — so there is nobody to alert, which is the difference between
 * this job and the reconciliation beside it. What this is for is the line a scheduler
 * logs and the thing an HR Administrator reads after running it by hand.
 *
 * It names what was *not* granted first when there is anything, because that is the
 * only part anybody has to do something about.
 */
export function summaryOf(run: AnnualGrantRun): string {
  const counts = passedOver(run);

  return [
    `Annual entitlement for ${run.leaveYearLabel}, granted at ${run.grantedAt.toISOString()}.`,
    '',
    `${run.granted.length} grants posted, ${daysGranted(run)} days in total.`,
    ...(run.notGranted.length === 0
      ? []
      : [
          '',
          `${run.notGranted.length} were not granted:`,
          ...NOT_GRANTED.filter((reason) => counts[reason] > 0).map(
            (reason) => `  ${counts[reason]} ${sentenceFor(reason)}`,
          ),
        ]),
  ].join('\n');
}

/** Each reason, said in a way that carries what to do about it. */
function sentenceFor(because: NotGrantedBecause): string {
  switch (because) {
    case 'ALREADY_GRANTED':
      return 'had already been granted, and were left exactly as they were.';
    case 'JOINED_AFTER_THE_YEAR_BEGAN':
      return 'joined after the year began, and are owed a proportion rather than the whole figure. FR 29.';
    case 'NO_ENTITLEMENT_RULE':
      return 'have no entitlement rule saying what the type is worth to them.';
    case 'WORTH_NOTHING':
      return 'have a rule saying the type is worth nothing to them.';
    case 'NOT_ELIGIBLE':
      return 'are not eligible for the type. FR 05.';
  }
}

/** Two decimal places, which is what the ledger's column holds. See ./balance.ts. */
function round(days: number): number {
  return Math.round(days * 100) / 100;
}
