/**
 * What somebody has left, for every kind of leave, on one screen. FR 53, §7.4., LMS 401, FR 05, FR 37, FR 22, FR 32g, FR 36, LMS 211.
 */

import {
  available,
  hasMoved as balanceHasMoved,
  type LeaveBalance,
  noMovementsYet,
  owed,
} from './balance.js';
import type { Gender } from './employee.js';
import {
  type AllowanceUnit,
  byDisplayOrder,
  type CountingBasis,
  countingBasisLabel,
  type EntitlementBasis,
  grantExpires,
  hasRunningBalance,
  isEligible,
  type LeaveType,
} from './leave-type.js';
import { byStartDate, coversDay, type LeaveYear } from './leave-year.js';
import { employedPortionOf, type Employment } from './pro-rata.js';
import type { CalendarDate } from './time.js';

/** One leave type on one person's statement, for one leave year. */
export interface BalanceStatementLine {
  leaveTypeId: string;
  /** The stable handle, for an export and a report. */
  code: string;
  name: string;
  /** FR 21, FR 22. */
  countingBasis: CountingBasis;
  /** The story's third criterion, in two words. */
  countingBasisLabel: string;
  /** FR 32g. */
  entitlementBasis: EntitlementBasis;
  /** What the figures on this line are, so that a nought says which kind of nought. */
  allowanceInWords: string;
  /** How the allowance is expressed to a person. */
  unit: AllowanceUnit;
  isPaid: boolean;
  /** FR 21. */
  stillOffered: boolean;

  /** GRANT entries. */
  entitled: number;
  /** CARRY_FORWARD less EXPIRY. FR 36, FR 36a. */
  carriedOver: number;
  /** FR 37. */
  adjustment: number;
  /** Days consumed by approved leave. */
  taken: number;
  /** Days held for leave asked for and not yet decided. */
  pending: number;
  /** `entitled + carriedOver + adjustment`. */
  owed: number;
  /** What may still be booked. §8.6. */
  available: number;

  /** Whether anything has ever moved this balance. */
  hasMoved: boolean;
  /** When the figures last changed, or null where they never have. */
  updatedAt: Date | null;
}

/** One person's balances for one leave year, and the years they may ask for instead. */
export interface BalanceStatement {
  employeeId: string;
  /** The year these figures are for. */
  year: LeaveYear;
  /** Every type worth showing, in the order §7.4 lists a balance screen. */
  lines: BalanceStatementLine[];
  /** The story's second criterion. */
  years: LeaveYear[];
}

/** Everything a statement is assembled from, all of it read by the caller. */
export interface StatementFacts {
  employeeId: string;
  /** FR 05, and the only thing the employee record is consulted for here. */
  gender: Gender | null;
  /** The year being shown. */
  year: LeaveYear;
  /** The years this person may choose between, from yearsToChooseFrom. */
  years: readonly LeaveYear[];
  /** Every leave type there is, retired ones included. */
  types: readonly LeaveType[];
  /** This person's balances. */
  balances: readonly LeaveBalance[];
}

/** A leave year somebody asked for that has nothing to do with this person. NFR USA 03. */
export class NotOneOfTheirLeaveYears extends Error {
  readonly employeeId: string;
  readonly leaveYearId: string;

  constructor(employeeId: string, year: LeaveYear, choices: readonly LeaveYear[]) {
    super(
      `${year.label} is not a leave year this person has any balances in — they were ` +
        `employed for no part of it and nothing has been filed under it for them. ` +
        (choices.length === 0
          ? 'There are no leave years to show for them at all.'
          : `The years to choose from are ${choices.map((one) => one.label).join(', ')}.`),
    );
    this.name = 'NotOneOfTheirLeaveYears';
    this.employeeId = employeeId;
    this.leaveYearId = year.id;
  }
}

/**
 * Nobody has defined a leave year this person could hold a balance in.
 *
 * Reachable two ways and both are the same gap: a database whose leave years have been
 * outrun by the calendar — it is 2028 and HR defined 2026 and 2027 — and a record whose
 * start date is past every year defined, which is somebody hired for next year before
 * next year exists.
 *
 * Refused rather than answered with an empty screen, because an empty screen is
 * indistinguishable from nought days and this is neither. §5.4's two rules are what make
 * it the only shape the gap can take: leave years do not overlap and leave no hole
 * between them, so there is never a partial answer to fall back on.
 */
export class NoLeaveYearToShow extends Error {
  readonly employeeId: string;

  constructor(employeeId: string) {
    super(
      `There is no leave year to show these balances for. Every balance is per person, ` +
        `per leave type, per leave year, and this person was employed for no part of any ` +
        `year that has been defined. Ask an HR Administrator to define the leave year ` +
        `that covers today. §5.4.`,
    );
    this.name = 'NoLeaveYearToShow';
    this.employeeId = employeeId;
  }
}

/* -------------------------------------------------------------------- which years */

/**
 * The leave years this person's statement may be asked for. The story's second criterion.
 *
 * Two limbs, and each catches what the other cannot. **Employed for any part of it** is
 * what a person expects to be able to look back at, and it is `employedPortionOf` rather
 * than a comparison written here — the same function the pro rata grant asks, so that
 * "was this person here for any of it" has one answer in this system. **Holds a balance in
 * it** is the safety net: an adjustment filed under a year somebody was not employed for
 * is a figure that exists, and a figure that exists has to be reachable, whatever put it
 * there.
 *
 * Oldest first, ordered by the day the year starts rather than by its id, for the reason
 * `BalanceRepository.forEmployee` gives: a company moving to an April start inserts a year
 * whose id is newer than the year it precedes.
 */
export function yearsToChooseFrom(
  years: readonly LeaveYear[],
  employment: Employment,
  heldIn: readonly string[],
): LeaveYear[] {
  return [...years]
    .filter(
      (year) =>
        heldIn.includes(year.id) ||
        employedPortionOf({ startsOn: year.startDate, endsOn: year.endDate }, employment) !==
          undefined,
    )
    .sort(byStartDate);
}

/**
 * Which year the screen opens on when the caller has not said. §5.4.
 *
 * The year covering today, which is the answer in every ordinary case and the only one
 * anybody would call correct. The two fallbacks behind it are for the records that are not
 * ordinary, and they are ordered by which is less surprising:
 *
 *   **The latest year that has already started**, for a leaver whose last year ended
 *   before today, or a database the calendar has outrun. Showing a leaver the year they
 *   left in is right; showing them a year they were never here for is not.
 *
 *   **The earliest**, for somebody who starts next year. That year is the only one they
 *   have, so it is the one to open on.
 *
 * `choices` is taken already sorted — {@link yearsToChooseFrom} sorts — so this reads the
 * ends of the list rather than sorting it again.
 */
export function theYearToOpenOn(
  choices: readonly LeaveYear[],
  today: CalendarDate,
): LeaveYear | undefined {
  return (
    choices.find((year) => coversDay(year, today)) ??
    choices.filter((year) => year.startDate <= today).at(-1) ??
    choices[0]
  );
}

/* -------------------------------------------------------------------- which types */

/**
 * The lines of one statement, in the order §7.4 lists them.
 *
 * A type is on it where **anything has moved its balance**, or where it is **still
 * offered and open to this person**. The module note argues both limbs; what is worth
 * saying beside the code is the order they are asked in, which is deliberate — the moved
 * test comes first, so that no rule about eligibility or retirement can hide a figure
 * that exists.
 *
 * A type with no row comes back as `noMovementsYet` rather than as an absence, which is
 * the answer `BalanceRepository.forOne` gives and for the same reason: a balance nobody
 * has posted a movement against is not missing, it is empty.
 *
 * `byDisplayOrder` rather than a sort written here. §7.4 orders the balance read by that
 * column so that a screen and a report agree without either of them deciding.
 */
export function linesFor(facts: StatementFacts): BalanceStatementLine[] {
  const byType = new Map(
    facts.balances
      .filter((balance) => balance.leaveYearId === facts.year.id)
      .map((balance) => [balance.leaveTypeId, balance] as const),
  );

  return [...facts.types]
    .sort(byDisplayOrder)
    .map((type) => ({
      type,
      balance:
        byType.get(type.id) ??
        noMovementsYet({
          employeeId: facts.employeeId,
          leaveTypeId: type.id,
          leaveYearId: facts.year.id,
        }),
    }))
    .filter(
      ({ type, balance }) =>
        balanceHasMoved(balance) || (type.isActive && isEligible(type, facts.gender)),
    )
    .map(({ type, balance }) => lineFor(type, balance));
}

/**
 * One line: the stored figures, the two derived ones, and the type's own facts.
 *
 * `available` and `owed` are ./balance.ts's, called rather than restated. There is no
 * column behind either and there should never be one — that file makes the argument at
 * length and is the only place the subtraction is written.
 */
export function lineFor(type: LeaveType, balance: LeaveBalance): BalanceStatementLine {
  return {
    leaveTypeId: type.id,
    code: type.code,
    name: type.name,
    countingBasis: type.countingBasis,
    countingBasisLabel: countingBasisLabel(type.countingBasis),
    entitlementBasis: type.entitlementBasis,
    allowanceInWords: allowanceInWords(type, balance),
    unit: type.unit,
    isPaid: type.isPaid,
    stillOffered: type.isActive,

    entitled: balance.entitled,
    carriedOver: balance.carriedOver,
    adjustment: balance.adjustment,
    taken: balance.taken,
    pending: balance.pending,
    owed: owed(balance),
    available: available(balance),

    hasMoved: balanceHasMoved(balance),
    updatedAt: balance.updatedAt,
  };
}

/**
 * What the figures on this line are, said to a person. FR 32g, FR 32e.
 *
 * The sentence that stops a nought lying. A quota type's nought is "you have used it
 * all"; an event type's nought before the event is "this arrives when it happens", and
 * those are opposite pieces of news shown as the same digit.
 *
 * A function of `entitlement_basis` and `entitlement_expiry_months`, never of the type's
 * code, exactly as {@link countingBasisInWords} is. A type HR adds next year reads
 * correctly the moment the row exists.
 */
export function allowanceInWords(type: LeaveType, balance: LeaveBalance): string {
  if (hasRunningBalance(type)) {
    return 'a yearly allowance, granted at the start of the leave year';
  }

  const within = grantExpires(type)
    ? `, and usable within ${months(type.entitlementExpiryMonths ?? 0)} of it`
    : '';

  return balanceHasMoved(balance)
    ? `granted per occasion rather than yearly${within}`
    : `granted per occasion rather than yearly${within}, so there is nothing here until ` +
        `an occasion arises`;
}

/* ------------------------------------------------------------------ the statement */

/**
 * The statement, from the facts the service has gathered.
 *
 * Pure, and assembled here rather than in the service for the reason `quoteFor` in
 * ./leave-request.ts is: what a person is shown about their own leave is a rule about
 * what they are owed an explanation of, and it should be testable without a database.
 *
 * The year and the list of years arrive already decided, because deciding either needs a
 * clock or an argument the caller made, and neither belongs in a file of rules.
 */
export function statementFor(facts: StatementFacts): BalanceStatement {
  return {
    employeeId: facts.employeeId,
    year: facts.year,
    lines: linesFor(facts),
    years: [...facts.years],
  };
}

function months(count: number): string {
  return `${count} ${count === 1 ? 'month' : 'months'}`;
}
