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

import {
  coversTheWholeYear,
  type EmployedPortion,
  type Employment,
  employedPortionOf,
  type LeaveYearDates,
  proRataDaysFor,
  type ProRataRule,
  THE_RULE_IN_FORCE,
} from './pro-rata.js';

/**
 * Why somebody was not granted, in the words a report uses.
 *
 * Closed, and each is a different thing to do about it: wait for the pro rata story,
 * ask HR to write a rule, correct a record, or nothing at all.
 */
export const NOT_GRANTED = [
  'ALREADY_GRANTED',
  'NOT_EMPLOYED_IN_THE_YEAR',
  'NO_ENTITLEMENT_RULE',
  'WORTH_NOTHING',
  'NOT_ELIGIBLE',
] as const;

export type NotGrantedBecause = (typeof NOT_GRANTED)[number];

/** One person, one leave type, and everything the decision turns on. */
export interface GrantCandidate {
  /** The leave year being granted. */
  year: LeaveYearDates;
  /** Their employment, as far as it is known today. FR 29 and FR 29a are both this. */
  employment: Employment;
  /**
   * What the entitlement rule says this type is worth to them for a whole year, or
   * undefined where no rule reaches them.
   *
   * Resolved by ./entitlement-rule.ts as at the first day of the year, which is the
   * day the grant is for. Asking on any other day would be granting a figure that was
   * not in force when the year began.
   */
  entitlementDays: number | undefined;
  /**
   * FR 29, and `leave_entitlement_rule.prorate_on_join`. Whether a part year is worth
   * a part of the figure.
   *
   * Annual leave is pro rated and the three days of sick leave are not: a joiner in
   * December gets all three, because a sick day is not something anybody accrues. That
   * is a column HR sets per figure, and it is passed in for the reason every leave type
   * rule in this system is a column — a `WHEN code = 'ANNUAL'` anywhere is the bug the
   * table exists to prevent.
   */
  proRateAPartYear: boolean;
  /** FR 05. Whether the type is open to this person at all. */
  eligible: boolean;
}

/**
 * Granted, and how much; or not, and why.
 *
 * A granted decision carries the rule that produced it, or null where the whole year
 * was granted and no rule was consulted. That is the story's third criterion on its way
 * to the ledger: the name reaches the entry's reason, so a figure worked out under one
 * formula stays distinguishable from a figure worked out under the next.
 */
export type GrantDecision =
  | { days: number; proRatedBy: ProRataRule | null; portion: EmployedPortion }
  | { because: NotGrantedBecause };

/** Whether the decision was to grant. */
export function wasGranted(
  decision: GrantDecision,
): decision is { days: number; proRatedBy: ProRataRule | null; portion: EmployedPortion } {
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
export function decideTheGrant(
  candidate: GrantCandidate,
  rule: ProRataRule = THE_RULE_IN_FORCE,
): GrantDecision {
  const portion = employedPortionOf(candidate.year, candidate.employment);

  if (portion === undefined) {
    return { because: 'NOT_EMPLOYED_IN_THE_YEAR' };
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

  /* A whole year, or a type nobody pro rates: the figure as written, and no rule name
     on the entry because no rule was asked. */
  if (!candidate.proRateAPartYear || coversTheWholeYear(candidate.year, portion)) {
    return { days: candidate.entitlementDays, proRatedBy: null, portion };
  }

  const days = proRataDaysFor(
    { fullYearDays: candidate.entitlementDays, year: candidate.year, portion },
    rule,
  );

  /* A proportion so small it rounds to nothing — somebody who joined on the last day of
     a year with three days of sick leave in it. There is no movement to post, and
     saying the figure was worth nothing is the truthful answer: the rule was asked and
     it said nought. */
  return days <= 0 ? { because: 'WORTH_NOTHING' } : { days, proRatedBy: rule, portion };
}

/**
 * What the ledger entry says, and the third acceptance criterion.
 *
 * FR 27 gives every movement a reason, and it is the sentence the person whose balance
 * it is actually reads. A pro rated grant's has to carry three things: that it *is* pro
 * rated, which part of the year it covers, and the name of the rule that produced it.
 *
 * The rule name is in the reason rather than in a column of its own, and that is a
 * decision rather than an omission. The person asking "why have I got 10.08 days" is
 * owed the answer in words they can see; a `pro_rata_rule` column holding
 * `'calendar-days'` answers a query instead. It is greppable either way — the name is a
 * stable handle for exactly that — and the day a report genuinely needs to group by it,
 * a column is a migration away and the reasons already say which rows to fill it from.
 */
export function reasonFor(
  leaveTypeName: string,
  leaveYearLabel: string,
  decision: { proRatedBy: ProRataRule | null; portion: EmployedPortion },
): string {
  const entitlement = `${leaveTypeName} entitlement for ${leaveYearLabel}`;

  return decision.proRatedBy === null
    ? entitlement
    : `${entitlement}, pro rated for ${decision.portion.from} to ${decision.portion.to} ` +
        `by the ${decision.proRatedBy.name} rule`;
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
    case 'NOT_EMPLOYED_IN_THE_YEAR':
      return 'were not employed at any point in this leave year.';
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
