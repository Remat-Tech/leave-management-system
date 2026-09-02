/**
 * What somebody has left, for every kind of leave, on one screen. FR 53, §7.4. LMS 401.
 *
 * The story is the first sentence of Phase 4 and the shortest one in the backlog: "so
 * that I can plan without asking HR". Everything the answer is made of has existed since
 * Phase 2 — the ledger records the movements, `leave_balance` keeps the sum, and
 * `BalanceService.forEmployee` reads it — and none of it is a screen. This file is the
 * arrangement of those figures into something a person can read in one go, and it is
 * three decisions rather than a projection.
 *
 * ## Every leave type, including the ones nothing has happened in
 *
 * `BalanceRepository.forEmployee` returns **only balances something has moved**, says so,
 * and hands the rest of the question here by name: "which types a screen should offer
 * anyway is a different question with real rules in it — `entitlement_basis` for the ones
 * that arrive with an event, `gender_restriction` for FR 05 — and it belongs to the story
 * that builds the screen." This is that story, and {@link linesFor} is that rule.
 *
 * A type appears where **anything has moved it**, or where it is **still offered and open
 * to this person**. The two limbs catch different things and neither is redundant:
 *
 *   **Moved, whatever else is true of it.** A type HR retired in March is on the
 *   statement of everybody who took days under it, and so is a type somebody is no longer
 *   eligible for. A figure that exists has to be explainable — design principle 1 — and a
 *   screen that hid it would leave days gone from a balance with nothing to say why.
 *
 *   **Offered and eligible, even at nought.** Somebody who has been ill on no day this
 *   year still has three days of sick leave, and a statement that showed nothing until
 *   they used some would be answering a different question. FR 05 is the other side of
 *   it: maternity leave is not on a man's statement at all, because a line reading "0
 *   days" against a type he can never request is worse than no line.
 *
 * Nothing here reads {@link LeaveType.code}. Which types exist, what they are worth and
 * who may have them are columns, and design principle 5 is that they stay columns.
 *
 * ## The five figures are shown as five figures, and there are six of them
 *
 * The story asks for entitled, carried over, taken, pending and available, and
 * ./balance.ts has already argued at length why the first four are kept apart rather than
 * netted. {@link BalanceStatementLine} carries `adjustment` as well, and it is not
 * padding.
 *
 * Leave it off and the line does not add up. Available is
 * `entitled + carriedOver + adjustment − taken − pending`, so a statement showing four of
 * those five terms beside the answer is a subtraction the reader cannot perform — and the
 * missing term would be exactly the one they are querying, because FR 37's manual
 * movements are the figures people ask about. "Somebody decided this" is the sentence a
 * surprising balance most needs to be able to say.
 *
 * `owed` is the top half added up, because "3 left" is unreadable without "of what".
 *
 * **Nothing here totals the lines.** Twenty annual days and three sick days are not
 * twenty-three of anything, and a figure at the foot of the column would be a number the
 * screen invented. The lines are the answer.
 *
 * ## The counting basis, per type, in two words
 *
 * The story's third criterion. It matters more on a statement than anywhere else, because
 * a statement puts annual leave and maternity leave in adjacent rows where the same "14
 * days" means a fortnight of work in one and a fortnight of the calendar in the other. FR
 * 22, and the difference is invisible unless it is written.
 *
 * `countingBasisLabel` rather than `countingBasisInWords`, and the two live side by side
 * in ./leave-type.ts without either being a duplicate. The long sentence is the request
 * quote's, where somebody is committing to a fortnight and the explanation earns its
 * space; the short label is this screen's, where six types each already carry six figures
 * and the same explanation six times crowds out the numbers it explains.
 *
 * Both are functions of the column and neither is a client's business. `WORKING_DAYS` is
 * not shown to anybody, and a browser mapping it to "Working days" for itself would be the
 * second place this system decided what a basis is called.
 *
 * ## And a nought that means "not yet" is not a nought that means "none left"
 *
 * FR 32g divides the types in two and the statement has to say which side a line is on. A
 * quota type opens the year with an allowance; an event type's days arrive with the
 * event, so compassionate leave reading nought in January is not somebody who has used it
 * all — it is somebody nothing has happened to. Shown as a bare nought it says the
 * opposite of what is true, and the person it says it to is by definition having a bad
 * week.
 *
 * So {@link BalanceStatementLine.allowanceInWords} says what the figures on the line
 * *are*, and {@link BalanceStatementLine.hasMoved} is the fact behind it — the same
 * distinction a null `updatedAt` draws in ./balance.ts, carried up to the screen rather
 * than left for it to work out.
 *
 * ## Prior years, and which of them are this person's
 *
 * The story's second criterion is a picker, and a picker is a list plus a rule about what
 * is on it. {@link yearsToChooseFrom} is that rule, and it has two limbs for the same
 * reason {@link linesFor} does: **the years they were employed for**, which is what
 * somebody expects to be able to look back at, and **the years they hold a balance in**,
 * which is what stops a figure existing in a year nothing will show.
 *
 * The employment test is `employedPortionOf` in ./pro-rata.ts — the same function the pro
 * rata grant asks, so "was this person here for any part of it" has one answer in this
 * system rather than two. A leaver's statement stops at the year they left in; a joiner's
 * starts at the year they arrived, and 2025 is not on it merely because HR defined the
 * row.
 *
 * Years in the *future* are on the list on purpose. The rollover posts next year's
 * `CARRY_FORWARD` the moment this year closes, so the year ahead holds real figures
 * before it starts, and a picker that hid it would hide the days somebody is planning
 * around. FR 36.
 *
 * ## What is not here
 *
 * **No clock.** {@link theYearToOpenOn} is handed today rather than reading one, exactly
 * as every date rule in `/domain` is: a rule whose answer depends on when it was asked is
 * a rule that cannot be tested.
 *
 * **No history.** Why a figure is what it is remains `LedgerService.history`, one call
 * away, and putting a run of movements on the statement would make the screen this story
 * is about the slow read that LMS 211 built the cache to avoid.
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

/**
 * One leave type on one person's statement, for one leave year.
 *
 * The stored figures and the type's own facts on one row, because a screen that had to
 * join them itself is a screen that can join them wrongly — and because every one of the
 * type's facts here is something the figures beside it are unreadable without.
 */
export interface BalanceStatementLine {
  leaveTypeId: string;
  /** The stable handle, for an export and a report. Never something to branch on. */
  code: string;
  name: string;
  /** FR 21, FR 22. Whether days the person does not work fall inside a period. */
  countingBasis: CountingBasis;
  /**
   * The story's third criterion, in two words. `WORKING_DAYS` is not shown to anybody.
   *
   * The short rendering rather than `countingBasisInWords`, which is the request quote's:
   * six types on one screen, each already carrying six figures, and the full explanation
   * repeated six times is noise that crowds out the numbers it is explaining. See
   * ./leave-type.ts, where both live and neither is a duplicate of the other.
   */
  countingBasisLabel: string;
  /** FR 32g. Whether the year opens with an allowance, or days arrive with an event. */
  entitlementBasis: EntitlementBasis;
  /** What the figures on this line are, so that a nought says which kind of nought. */
  allowanceInWords: string;
  /** How the allowance is expressed to a person. "4 months", counted in days. */
  unit: AllowanceUnit;
  isPaid: boolean;
  /** FR 21. False for a retired type still shown because days moved in it. */
  stillOffered: boolean;

  /** GRANT entries. What the year's entitlement rule was worth to this person. */
  entitled: number;
  /** CARRY_FORWARD less EXPIRY. FR 36 and FR 36a. */
  carriedOver: number;
  /** FR 37. The only figure that goes either way, and the one people ask about. */
  adjustment: number;
  /** Days consumed by approved leave. */
  taken: number;
  /** Days held for leave asked for and not yet decided. */
  pending: number;
  /** `entitled + carriedOver + adjustment`. What the "of 25 days" is. */
  owed: number;
  /** What may still be booked. May be negative — §8.6b, sick leave. */
  available: number;

  /** Whether anything has ever moved this balance. A nought that means "not yet". */
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
  /** The story's second criterion. Oldest first, which is the order a year runs. */
  years: LeaveYear[];
}

/** Everything a statement is assembled from, all of it read by the caller. */
export interface StatementFacts {
  employeeId: string;
  /** FR 05, and the only thing the employee record is consulted for here. */
  gender: Gender | null;
  /** The year being shown. */
  year: LeaveYear;
  /** The years this person may choose between, from {@link yearsToChooseFrom}. */
  years: readonly LeaveYear[];
  /** Every leave type there is, retired ones included. {@link linesFor} filters. */
  types: readonly LeaveType[];
  /** This person's balances. Rows for other years are ignored rather than refused. */
  balances: readonly LeaveBalance[];
}

/**
 * A leave year somebody asked for that has nothing to do with this person.
 *
 * Told apart from {@link LeaveYearNotFound}, which is an id that is nobody's: this one is
 * a real year that this person was employed for no day of and holds no balance in, so a
 * statement for it would be seven rows of nought describing a year they were not here
 * for. A screen showing that has told somebody they have no leave.
 *
 * Refused rather than shown, and the message names what *is* available, because anybody
 * meeting this has picked from a list somewhere that was longer than it should have been.
 * NFR USA 03.
 */
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
