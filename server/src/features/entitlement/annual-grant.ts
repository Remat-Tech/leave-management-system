/** The annual grant of entitlement. FR 30, LMS 214, §8.6, FR 29, FR 32h, FR 05, LMS 212, FR 32g. */

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

/** Why somebody was not granted, in the words a report uses. */
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
  /** Their employment, as far as it is known today. FR 29, FR 29a. */
  employment: Employment;
  /**
   * What the entitlement rule says this type is worth to them for a whole year, or undefined where no rule reaches them.
   */
  entitlementDays: number | undefined;
  /** FR 29, and `leave_entitlement_rule.prorate_on_join`. */
  proRateAPartYear: boolean;
  /** FR 05. */
  eligible: boolean;
}

/** Granted, and how much; or not, and why. */
export type GrantDecision =
  | { days: number; proRatedBy: ProRataRule | null; portion: EmployedPortion }
  | { because: NotGrantedBecause };

/** Whether the decision was to grant. */
export function wasGranted(
  decision: GrantDecision,
): decision is { days: number; proRatedBy: ProRataRule | null; portion: EmployedPortion } {
  return 'days' in decision;
}

/** What this person is granted of this leave type for this year. FR 30, FR 29. */
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

  if (candidate.entitlementDays <= 0) {
    return { because: 'WORTH_NOTHING' };
  }

  if (!candidate.proRateAPartYear || coversTheWholeYear(candidate.year, portion)) {
    return { days: candidate.entitlementDays, proRatedBy: null, portion };
  }

  const days = proRataDaysFor(
    { fullYearDays: candidate.entitlementDays, year: candidate.year, portion },
    rule,
  );

  return days <= 0 ? { because: 'WORTH_NOTHING' } : { days, proRatedBy: rule, portion };
}

/** What the ledger entry says, and the third acceptance criterion. FR 27. */
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
