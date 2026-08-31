/**
 * The year rollover. FR 36, FR 36a, §11. LMS 217.
 *
 * The story is the first of January, and what an employee finds when they open the
 * system: the days they did not get to take are still there. Everything else in Phase 2
 * put figures into a balance or read them out; this is the one story about a figure
 * surviving a boundary, and the boundary is the only place in this system where days
 * can be lost without anybody deciding to lose them.
 *
 * ## Three acts, in an order that is the argument
 *
 * The job — ../jobs/year-rollover.ts — closes the year that has ended, carries what is
 * left of it forward, and grants the year that has begun. That order is the story's own
 * first criterion and it is not a sequence of convenience:
 *
 *   **Closing comes first because you can only carry what is settled.** A figure read
 *   out of an open year is a figure something can still move — an approval landing on
 *   the second of January against December's balance — and a carry computed from it
 *   would be right at the moment it was read and wrong by the time it was written.
 *   Closing is what makes the old year's arithmetic final; §8.9 leaves exactly one door
 *   open afterwards, a deliberate `ADJUSTMENT` with somebody's name on it, and that is a
 *   correction rather than a drift.
 *
 *   **Carrying comes before granting** so that a balance screen never shows a new year
 *   with its entitlement in it and last year's days still missing. Both land in the same
 *   balance and the order does not change the total; it changes what somebody sees if
 *   they look while the job is running, and on the first working day of January somebody
 *   will.
 *
 * ## What carries, and what decides it
 *
 * {@link decideTheCarry} is the whole rule, and it reads three facts: how much is left,
 * whether this type carries at all, and whether there is a cap. None of them is a leave
 * type code, and that is the point — see design principle 5.
 *
 *   **Sick leave does not carry**, which is the story's third criterion and is
 *   `leave_entitlement_rule.carries_over` set to false on the statutory sick figure. No
 *   line of this file knows what sick leave is.
 *
 *   **Event based types do not carry**, the fourth criterion, and they never reach here:
 *   the job filters on `hasRunningBalance` before a candidate is built, exactly as the
 *   annual grant does. FR 32g — a maternity entitlement arrives with the confinement and
 *   has nothing to do with the first of January, so "carrying it over" is not a question
 *   with an answer.
 *
 *   **Carry over is uncapped and does not expire**, the second criterion, and it is two
 *   unset columns rather than a rule written here. `carryoverMaxDays` and
 *   `carryoverExpiryMonth` are both null on every statutory figure, which is FR 36a said
 *   as data. {@link decideTheCarry} honours a cap where HR has set one, because a column
 *   nothing reads is a column that quietly stops being true — but nothing sets one
 *   today, and the uncapped path is the one the company runs on.
 *
 * ## What is left behind in the closed year, on purpose
 *
 * Nothing is subtracted from the year that closed. Its balance goes on saying twenty
 * granted, seventeen taken, three left, forever — and the three appear again in the new
 * year as `carriedOver`.
 *
 * That looks like double counting and is not. They are two accounts of two years, and
 * three days exist once, in the year they may now be booked against; a bank statement
 * closes a month at a figure and opens the next at the same figure without anybody
 * calling it two lots of money. What would genuinely be wrong is an `EXPIRY` posted back
 * into the old year to zero it, and it would be wrong for the reason the whole of
 * LMS 205 is about: that is recalculating a settled year, which is the one thing closing
 * one forbids. It is also, by then, impossible — the ledger's settled-year trigger
 * refuses every entry type but an `ADJUSTMENT`, which is another way of saying that
 * doing this in the right order leaves no way to do it wrongly afterwards.
 *
 * What must not happen is a caller adding `available` across leave years. That has never
 * been a sound thing to do — last year's annual leave and this year's are different
 * balances by `leave_balance_one_per_year` — and it is the reason `BalanceService` reads
 * one year at a time.
 *
 * ## What is deliberately not here
 *
 * **Whether the days have already been carried.** The same argument `decideTheGrant`
 * makes about `ALREADY_GRANTED`: a pure function asking it would be asking a moment
 * before the write, which is the window LMS 212 built a lock to close.
 * `BalanceService.carryForward` asks it inside that lock and this file's caller learns
 * the answer by being refused. See `daysToCarry` in ./balance.ts.
 *
 * **Expiring carried days.** FR 36a's `carryoverExpiryMonth` is a second job on a second
 * schedule — it posts `EXPIRY` entries in a named month, which is why `EXPIRY` moves the
 * `carriedOver` bucket and not `entitled`. No rule in this system sets the column, so
 * there is nothing for that job to do yet and it would be a schedule with no work on it.
 *
 * **Settling a leaver.** FR 37a compares what somebody was granted against the part year
 * they actually worked. A leaver is not carried anything here because the job runs over
 * active employees only, which is the truthful default — they have no new year to carry
 * into — and what happens to their remainder is that story's.
 */

import type { AnnualGrantRun } from './annual-grant.js';
import { summaryOf as summaryOfTheGrant } from './annual-grant.js';

/**
 * Why days were not carried, in the words a report uses.
 *
 * Closed, and each is a different thing to do about it: nothing at all, nothing at all,
 * ask HR to write a rule, nothing, or look at a balance somebody has overdrawn.
 *
 * Two of the five are the ordinary case rather than a fault, and they are reported all
 * the same. "The rollover ran and Ama's three days are gone" has to be answerable in a
 * sentence, and the only way it is answerable is if the run said so at the time.
 */
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
   * What is left in the closing year's balance: `available`, which is what somebody
   * could still have booked on the last day of it.
   *
   * Read *after* the year is closed, so it cannot move again. Days that were held for a
   * request nobody decided are already subtracted from it — they are spoken for rather
   * than unused — and the run reports them separately, because a request left pending in
   * a year that has closed is somebody's problem rather than a number.
   */
  available: number;
  /**
   * FR 36, and `leave_entitlement_rule.carries_over`. Whether unused days of this type
   * roll into the next year at all.
   *
   * Undefined where no rule reaches this person for this type, which is not the same as
   * false: unpaid leave has no figure at all, deliberately, and "nobody has said" is a
   * different report line from "HR said no".
   *
   * **Resolved as at the last day of the year being closed**, not the first day of the
   * new one, and FR 31 is why: the days being carried were earned under the policy that
   * covered them, and a rule written to take effect in January must not reach back and
   * strip days somebody accrued in a year it says nothing about. Changing the figure for
   * next year is an insert; changing what last year was worth is not a thing this system
   * permits.
   */
  carriesOver: boolean | undefined;
  /**
   * FR 36a, and `leave_entitlement_rule.carryover_max_days`. The most that may cross the
   * boundary, or null for uncapped.
   *
   * Null on every statutory figure this company runs on, which is the story's second
   * criterion held as data. Honoured anyway, because a column the code ignores is a
   * setting that lies to whoever fills it in.
   */
  carryoverMaxDays: number | null;
}

/**
 * Carried, and how much; or not, and why.
 *
 * A carried decision says what it would have carried before the cap as well as what it
 * did, so the report can name the days somebody lost to a policy rather than leaving
 * them to work it out from two numbers. `cappedFrom` is null where nothing was capped,
 * which is every carry this company makes today.
 */
export type CarryDecision =
  { days: number; cappedFrom: number | null } | { because: NotCarriedBecause };

/** Whether the decision was to carry. */
export function wasCarried(
  decision: CarryDecision,
): decision is { days: number; cappedFrom: number | null } {
  return 'days' in decision;
}

/**
 * How much of this balance crosses into the new year. FR 36, FR 36a.
 *
 * The order of the four refusals is the order they are worth knowing about, and the
 * first two have to come before the arithmetic: whether a type carries at all is a
 * question about the policy, and asking how many days are left of something that does
 * not carry is asking about a figure nobody will use.
 *
 * **A balance in arrears is not carried, and is not forgiven either.** An annual balance
 * below nought is somebody who has taken more than they had — an adjustment HR posted,
 * or sick days on a type that may be exceeded. Carrying the debt would post a
 * `CARRY_FORWARD` of negative days, which the ledger refuses because a carry forward
 * adds; carrying nothing and saying nothing would quietly write the debt off on the
 * first of January. So it is reported by name, as the one outcome of this run that
 * somebody has to actually do something about.
 */
export function decideTheCarry(candidate: CarryCandidate): CarryDecision {
  if (candidate.carriesOver === undefined) {
    return { because: 'NO_ENTITLEMENT_RULE' };
  }

  /* FR 36 and the story's third and fourth criteria, as one line reading one column.
     Sick leave is false here and a maternity type never reaches this function at all. */
  if (!candidate.carriesOver) {
    return { because: 'DOES_NOT_CARRY' };
  }

  if (candidate.available < 0) {
    return { because: 'IN_ARREARS' };
  }

  /* Nought is not a movement. A ledger entry of no days would be a line in somebody's
     history that explains nothing, and "you carried no days" is what an empty
     `carriedOver` already says. */
  if (candidate.available === 0) {
    return { because: 'NOTHING_LEFT' };
  }

  const cap = candidate.carryoverMaxDays;

  return cap !== null && candidate.available > cap
    ? { days: cap, cappedFrom: candidate.available }
    : { days: candidate.available, cappedFrom: null };
}

/**
 * What the ledger entry says. FR 27.
 *
 * Both years are named, because the one question a carried figure has to answer is where
 * it came from — "3 days" in a January balance explains nothing, and "unused 2026 annual
 * leave carried into 2027" explains all of it without anybody opening another screen.
 *
 * A capped carry says so and says what it was capped from, for the same reason the pro
 * rata rule's name reaches the reason it produced: the person who lost two days to a
 * policy should read that in the sentence rather than infer it from a subtraction.
 */
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
