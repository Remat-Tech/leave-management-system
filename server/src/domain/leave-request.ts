/**
 * Asking for leave, and knowing what it costs first. FR 10, FR 11, FR 16, §8. LMS 301,
 * and the refusals of LMS 303.
 *
 * The story is an employee who wants no surprises when the days come off their
 * balance, and the whole of this file follows from taking that literally: the figure
 * a person is shown before they submit and the figure that is stored afterwards are
 * produced by the same function from the same facts, and once stored the figure is
 * never derived again.
 *
 * ## The quote and the request are the same arithmetic
 *
 * {@link LeaveRequestQuote} is what a form shows. {@link ValidatedLeaveRequest} is
 * what is stored. The second carries the first's numbers, unchanged, because
 * `LeaveRequestService` counts once for the quote and again inside the transaction
 * that writes — and if those two ever disagreed, the disagreement would be the
 * surprise the story exists to prevent. What makes them agree is that neither does
 * any arithmetic of its own: both call {@link countLeaveDays}, which is pure and
 * gives the same answer for the same period, pattern, calendar and basis.
 *
 * ## Why the basis is copied, and what it protects
 *
 * The story's third criterion, and it is a criterion about the *future* rather than
 * about today. `leave_type.counting_basis` is configuration — an HR Administrator may
 * change it, `leaveTypePolicy.update` says so, and moving one type from WORKING_DAYS
 * to CALENDAR_DAYS is one dropdown. If a request read the basis off the type every
 * time it was rendered, that single edit would restate every request ever made under
 * the old rule: last March's fortnight of annual leave would begin displaying as
 * fourteen days rather than ten, on a screen beside a ledger still saying ten, and
 * nothing anywhere would say which was right.
 *
 * So the basis, the day count and the calendar span are written onto the row at
 * submission and the database refuses to let them move —
 * `refuse_rewriting_what_a_request_cost()`. This file holds the same rule in the type
 * system: every one of those fields is on {@link ValidatedLeaveRequest} and none of
 * them is on {@link LeaveRequestChanges}.
 *
 * It is the same argument three other tables in this schema have already made, and
 * that is worth knowing rather than rediscovering. `leave_entitlement_event` stores
 * `expires_on` so that changing a type's expiry months cannot move a deadline already
 * given. `leave_ledger_entry` stores `days` so that changing an entitlement figure
 * cannot restate a grant. `leave_balance` is a cache checked nightly against the rows
 * it was built from. In each case the rule is design principle 1: **what was recorded
 * is what happened**, and configuration describes what happens *next*.
 *
 * ## Dates that are obviously wrong are refused here, and refused at once
 *
 * FR 16, FR 16a, §8.3, LMS 303. The story is somebody finding out while the form is
 * still open rather than after two days in a queue, and three refusals answer it:
 *
 *   **The dates run backwards.** {@link validateLeavePeriod}, which owns
 *   {@link LeavePeriod} and is asked before anything at all is fetched.
 *
 *   **Nothing in the period is charged.** {@link assertItCostsSomething}, on the
 *   {@link DayCount} the calculator gave back.
 *
 *   **The period runs past the end of its leave year.** {@link reachesPastTheEndOf},
 *   and then {@link LeaveCrossesAYearEnd} with both years named and the two dates to
 *   resubmit on.
 *
 * **All three are refusals about a request, and none of them is the calculator's.**
 * LMS 303 moved the second one here from ./leave-calculator.ts, and the reason is the
 * reason it belongs beside the other two: that a fortnight over Christmas costs eight
 * days, or that a Saturday costs none, is arithmetic about a calendar, and the
 * calculator answers it for anybody who asks — including FR 25's recalculation, which
 * has to be able to ask "what does this cost now" and get *nought* rather than an
 * exception. Whether a person may submit that is a rule about submissions.
 *
 * The practical half of that division: the calculator stays pure and total, so every
 * one of its cases is arithmetic a unit test can assert without a database, and every
 * refusal a person can actually see is in one file with one voice.
 *
 * ## What is not here
 *
 * **No counting.** ./leave-calculator.ts counts, and it is where the working pattern,
 * the holiday calendar and the counting basis meet. This file is handed the answer and
 * judges it.
 *
 * **No balance.** Whether the days are there is the ledger's, through
 * `BalanceService.reserve`, and the check happens inside the lock rather than here —
 * §8.2. A domain function that decided affordability would be deciding it a moment
 * before the decision was acted on.
 *
 * **No transitions.** {@link REQUEST_STATUSES} holds one value. The state machine of
 * §8 — approve, refuse, withdraw, cancel — is the next story's, it brings its own
 * migration extending the CHECK exactly as LMS 218 extended the ledger's entry types,
 * and the README's rule that "only the state machine moves a request" is what it
 * inherits. What this story guarantees is that nothing else has moved one first.
 *
 * **No overlap check.** Two requests for the same fortnight is a rule about two rows
 * and needs the state machine's list of which statuses count as live. The baseline
 * enabled `btree_gist` for the exclusion constraint that will hold it.
 *
 * **No policy.** There is no {@link Actor} here and there is none in a `/domain` file
 * anywhere. Who may ask for leave is ../auth/leave-request-policy.ts.
 */

import type { DayCount, FreeDay, LeavePeriod } from './leave-calculator.js';
import {
  approvalChainInWords,
  type CountingBasis,
  documentationRequired,
  type LeaveType,
  noticeShortfall,
} from './leave-type.js';
import type { LeaveYear } from './leave-year.js';
import {
  type CalendarDate,
  calendarDaysBetween,
  dayAfter,
  formatDay,
  isCalendarDate,
} from './time.js';

/**
 * Where a request has got to.
 *
 * One value, and the shortness of this list is the story's boundary rather than an
 * omission. See the module note: a CHECK naming six states of which one is reachable
 * is a promise the schema cannot keep, and `leave_request_status_known` in the
 * create-and-submit-a-leave-request migration holds exactly this list. The integration
 * suite asserts the two agree.
 */
export const REQUEST_STATUSES = ['SUBMITTED'] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** What somebody fills in. FR 10's four fields, and nothing else. */
export interface NewLeaveRequest {
  employeeId: string;
  leaveTypeId: string;
  from: CalendarDate;
  to: CalendarDate;
  /**
   * Why. Mandatory, unlike an entitlement event's note, and the difference is who
   * reads it: an event is a fact HR recorded, and a request is somebody asking a
   * manager for something. A manager looking at five days in March with nothing
   * against them is being asked to approve something they know nothing about.
   */
  reason: string;
}

/**
 * The shape a validated request has by the time it reaches the repository.
 *
 * Everything the reservation was calculated from, resolved. `leaveYearId` is the year
 * covering the period rather than today's; `countingBasis`, `days` and `calendarDays`
 * are the copy the story is named for. None of them is supplied by the caller — a
 * caller who could hand over the day count could hand over a smaller one.
 */
export interface ValidatedLeaveRequest {
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  from: CalendarDate;
  to: CalendarDate;
  reason: string;
  countingBasis: CountingBasis;
  days: number;
  calendarDays: number;
  status: RequestStatus;
}

/**
 * The only fields an existing request may change.
 *
 * `reason` explains rather than decides, which is the same line
 * `leave_entitlement_event` draws around its `note`. Everything else was what the days
 * were priced from, and the database refuses to move any of it on any connection.
 *
 * `status` is absent because moving it is the state machine's, through the one method
 * the README insists on, rather than an ordinary edit.
 */
export interface LeaveRequestChanges {
  reason?: string;
}

/** A request as it comes back out. */
export interface LeaveRequest {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  from: CalendarDate;
  to: CalendarDate;
  reason: string;
  /**
   * FR 11. The basis this was priced under, as it stood at submission.
   *
   * Read this rather than `leaveType.countingBasis` when rendering a request, always.
   * They agree today and the whole reason the column exists is the day they do not.
   */
  countingBasis: CountingBasis;
  /** What it cost. Whole days, FR 24, and what the RESERVATION took. */
  days: number;
  /** The span, counted or not. "Nine days off, seven of them counted." */
  calendarDays: number;
  status: RequestStatus;
  submittedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/* ------------------------------------------------------------------- refusals */

/**
 * A request that is not a request.
 *
 * The same shape as {@link InvalidLeaveType} and {@link InvalidLeavePeriod}, and for
 * the same reason, NFR USA 03: the message has to reach the form beside the input it
 * is about.
 */
export class InvalidLeaveRequest extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidLeaveRequest';
    this.field = field;
  }
}

/** No such request. */
export class LeaveRequestNotFound extends Error {
  readonly leaveRequestId: string;

  constructor(id: string) {
    super(`There is no leave request ${id}.`);
    this.name = 'LeaveRequestNotFound';
    this.leaveRequestId = id;
  }
}

/**
 * A period of leave that costs nothing at all. FR 16a.
 *
 * A Saturday to Sunday of annual leave against a Monday to Friday week, or a single
 * public holiday. Refused rather than stored, and the reason is that every caller
 * downstream would otherwise have to invent the same handling: a request worth no days
 * deducts nothing from a balance, waits in a queue for an approval that changes nothing,
 * and shows on a team calendar as an absence that cost nobody anything. There is no
 * sensible thing for any of them to do with it. `leave_request_costs_at_least_a_day`
 * says the same where no sentence can reach.
 *
 * The message names the days rather than only the verdict, because the person looking at
 * it has typed two dates they believe in and needs to see which part of the period the
 * system thinks is free. Somebody who genuinely meant to record a weekend has not made a
 * mistake about the dates — they have chosen the wrong kind of leave, and a type counting
 * calendar days is the answer.
 *
 * It moved here from ./leave-calculator.ts in LMS 303 with its message unchanged; see the
 * module note for why a refusal about a request does not belong in the arithmetic.
 */
export class LeaveCountsNoDays extends Error {
  readonly leaveTypeId: string;
  readonly period: LeavePeriod;
  readonly free: FreeDay[];

  constructor(type: LeaveType, period: LeavePeriod, free: FreeDay[]) {
    super(
      `${period.from} to ${period.to} costs no ${type.name} at all: ${inWords(free)}. ` +
        `Leave that costs nothing is leave nobody needs to ask for. Check the dates — ` +
        `or, if the whole period really is meant to be recorded, it is a kind of ` +
        `leave that counts every day rather than only working ones.`,
    );
    this.name = 'LeaveCountsNoDays';
    this.leaveTypeId = type.id;
    this.period = period;
    this.free = free;
  }
}

/**
 * A period that runs past the end of a leave year. FR 16.
 *
 * Refused rather than split, and refused with both years named so the person at the
 * form knows what to do instead of only that they may not do this.
 *
 * A request is one period against one balance and a balance belongs to one leave year,
 * so twenty-eighth of December to fifth of January is two balances. Reserving all ten
 * days against either one would be a figure that reconciles and is wrong: days taken
 * in January charged to last year's entitlement, or the reverse. `leave_type.may_be_split`
 * and `assertMayBeSplit()` are what a story offering the split would use, and it is a
 * decision — two requests with one approval between them — rather than an arithmetic
 * anything here could perform.
 *
 * ## The message is two sentences, and the second one is the useful one
 *
 * "This request crosses into the 2027 leave year. Submit one request ending 31 December
 * 2026, and another starting 1 January 2027." NFR USA 03: a refusal that only says no
 * leaves somebody at a form doing date arithmetic to find out what they are allowed to
 * type, and they will get it wrong at exactly the boundary that produced the refusal.
 *
 * **Every year and every date in it is read off the record.** The boundary is
 * `year.endDate`, the day to resume on is {@link dayAfter} of it, and the year being
 * crossed into is whatever HR called it — '2027' here, '2027/28' at a company running
 * April to March, which is why `next` is looked up rather than derived from the month.
 * Nothing here assumes a leave year is a calendar year, because §5.4 is explicit that it
 * need not be and a hard-coded 'the thirty-first of December' would be wrong for the
 * first company that changes.
 *
 * `next` is undefined where nobody has defined the year after this one yet — a gap after
 * the last leave year is allowed, and the database ships with 2026 and 2027 and nothing
 * beyond. The label then falls back to the year part of the day to resume on, which is
 * still read off the record rather than written down: the sentence stays true and the two
 * dates in it stay right, which is the half somebody acts on.
 */
export class LeaveCrossesAYearEnd extends Error {
  /**
   * FR 16. What a client branches on, where the message is what a person reads.
   *
   * The one refusal in this file carrying a code, and the story asks for it by name
   * because this is the one a form is expected to *do* something about — offer the split
   * as two prefilled requests rather than only printing the sentence. A message is
   * reworded the first time somebody reads it aloud; a code is a contract.
   */
  readonly code = 'CROSS_LEAVE_YEAR';
  readonly period: LeavePeriod;
  readonly leaveYearId: string;
  /** The last day one request may cover, and the first day the other may. */
  readonly endsOn: CalendarDate;
  readonly resumesOn: CalendarDate;

  constructor(period: LeavePeriod, year: LeaveYear, next: LeaveYear | undefined) {
    const resumesOn = dayAfter(year.endDate);

    super(
      `This request crosses into the ${next?.label ?? resumesOn.slice(0, 4)} leave year. ` +
        `Submit one request ending ${formatDay(year.endDate)}, and another starting ` +
        `${formatDay(resumesOn)}.`,
    );
    this.name = 'LeaveCrossesAYearEnd';
    this.period = period;
    this.leaveYearId = year.id;
    this.endsOn = year.endDate;
    this.resumesOn = resumesOn;
  }
}

/* ------------------------------------------------------- refusing the dates */

/**
 * Whether the period runs out of the year it started in. FR 16.
 *
 * A string comparison against the year's last day, which is all "crosses a year end"
 * means once {@link coversDay} has found the year the first day is in. The service
 * asks this before it looks up the year being crossed into, because that lookup is a
 * second query and every quote a person's keystrokes produce would otherwise pay for it
 * to answer a question almost every request answers no to.
 *
 * `refuse_a_request_outside_its_leave_year()` holds the same rule for every other
 * writer, so the two cannot drift.
 */
export function reachesPastTheEndOf(year: LeaveYear, period: LeavePeriod): boolean {
  return period.to > year.endDate;
}

/**
 * Refuses a period that nothing in is charged. FR 16a.
 *
 * Takes the count rather than recounting, which is what keeps the number a person is
 * refused on the same number they were quoted: there is one walk over the days and this
 * reads its answer. The free days come from the same {@link DayCount}, so the message
 * names the days that were actually free rather than a second opinion about them.
 *
 * Nought is the only refusable answer. A count cannot come back negative — the walk
 * increments — and every other value is a request somebody may make, affordable or not:
 * whether the days are *there* is the ledger's, and §8.6b lets sick leave go past its
 * allowance on purpose.
 */
export function assertItCostsSomething(
  type: LeaveType,
  period: LeavePeriod,
  count: DayCount,
): void {
  if (count.days === 0) {
    throw new LeaveCountsNoDays(type, period, count.free);
  }
}

/**
 * The free days as a person would say them, for the one message that needs it.
 *
 * Named rather than counted, because "the twenty fifth is Christmas Day" is what makes a
 * refusal actionable and "3 days were free" is what makes somebody ask which. Capped at
 * four, because a refusal listing a hundred and twenty days is a refusal nobody reads to
 * the end of.
 */
function inWords(free: readonly FreeDay[]): string {
  if (free.length === 0) {
    /* Unreachable: a period holds at least one day, and a day that did not count put a
       reason in the list. Answered rather than assumed, because a refusal that trails
       off mid sentence is worse than a clumsy one. */
    return 'no day in it counts';
  }

  const named = free
    .slice(0, 4)
    .map((day) => (day.name === null ? day.date : `${day.date} (${day.name})`));
  const rest = free.length - named.length;

  return rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', ');
}

/* --------------------------------------------------------------- the quote */

/**
 * Something worth telling somebody before they submit, that is not a refusal.
 *
 * The difference from an error is whether the request may still go ahead. A period
 * that costs nothing is refused; a period with four days' notice where the type asks
 * for seven is submitted, and the person is told. FR 17 is explicitly a warning rather
 * than a bar — leave is sometimes needed at short notice and the system's job is to
 * make sure nobody is surprised, not to make it impossible.
 */
export const QUOTE_WARNINGS = [
  /** FR 17. Less notice than the type asks for. Advisory; the approver decides. */
  'SHORT_NOTICE',
  /** FR 13. This length of this type needs something attached to it. */
  'DOCUMENTATION_REQUIRED',
  /** The days are not there. Refused at submission by the balance's own check. */
  'NOT_ENOUGH_DAYS',
] as const;

export type QuoteWarning = (typeof QUOTE_WARNINGS)[number];

export interface RequestWarning {
  code: QuoteWarning;
  /** In words the person at the form can act on. NFR USA 03. */
  message: string;
}

/**
 * What a period would cost, before anything is written. The story's second criterion.
 *
 * Everything a form needs to say "this is what you are asking for" in a sentence
 * somebody accepts: the number, the basis it was reached by, the days inside the
 * period that were free and why, what the balance is now and what it would become,
 * and anything worth knowing that is not a refusal.
 *
 * `free` is what turns a number into an explanation. "Nine days off cost you seven" is
 * an assertion; "the twenty-fifth is Christmas Day and the twenty-sixth is Boxing Day"
 * is the reason, and NFR USA 03 asks for the second.
 *
 * `availableAfter` may be negative, and legitimately: §8.6b lets sick leave go past
 * its allowance because FR 32a makes that a documentation threshold rather than a cap.
 * A quote showing −3 with a `DOCUMENTATION_REQUIRED` warning beside it is the honest
 * account of what somebody is about to ask for.
 */
export interface LeaveRequestQuote {
  leaveTypeId: string;
  leaveTypeName: string;
  from: CalendarDate;
  to: CalendarDate;
  /** FR 11. The basis this was counted under, which is what would be copied onto it. */
  countingBasis: CountingBasis;
  /** In words, for a screen: "working days" or "every day, weekends included". */
  countingBasisInWords: string;
  days: number;
  calendarDays: number;
  free: DayCount['free'];
  /** What the balance holds now, and what it would hold if this were submitted. */
  availableNow: number;
  availableAfter: number;
  /** Who would decide it, in words. FR 38a. */
  approvedBy: string;
  warnings: RequestWarning[];
}

/**
 * The counting basis, said to a person rather than to a database.
 *
 * On the quote because the story asks for the basis to be *shown*, and `WORKING_DAYS`
 * is not shown to anybody. The sentence names what is skipped, because that is the
 * part somebody is checking: a person looking at "7 days" for a nine day period wants
 * to know the weekend is why.
 *
 * A function of the basis and never of the type's code, exactly as
 * {@link countsWorkingDays} is. A type HR adds next year renders correctly the moment
 * the row exists.
 */
export function countingBasisInWords(basis: CountingBasis): string {
  return basis === 'WORKING_DAYS'
    ? 'working days — days you are not scheduled to work, and public holidays, cost nothing'
    : 'calendar days — every day of the period counts, weekends and public holidays included';
}

/**
 * The quote, from the facts the service has gathered.
 *
 * Pure, and assembled here rather than in the service for the reason every rule in
 * this system lives in `/domain`: the sentence a person is shown before they commit to
 * a fortnight is a rule about what they are owed an explanation of, and it should be
 * testable without a database.
 *
 * The warnings are read off the leave type by the helpers that have been sitting in
 * ./leave-type.ts unused since LMS 201 — {@link noticeShortfall} and
 * {@link documentationRequired} — which is what those were built for.
 */
export function quoteFor(input: {
  type: LeaveType;
  period: LeavePeriod;
  count: DayCount;
  availableNow: number;
  daysOfNotice: number;
}): LeaveRequestQuote {
  const { type, period, count, availableNow, daysOfNotice } = input;
  const warnings: RequestWarning[] = [];

  const shortfall = noticeShortfall(type, daysOfNotice);
  if (shortfall > 0) {
    warnings.push({
      code: 'SHORT_NOTICE',
      message:
        `${type.name} normally wants ${type.minNoticeCalendarDays} days' notice and this ` +
        `gives ${daysOfNotice}. It can still be submitted — whoever approves it will see ` +
        `that it was short by ${shortfall}.`,
    });
  }

  if (documentationRequired(type, count.days)) {
    warnings.push({
      code: 'DOCUMENTATION_REQUIRED',
      message:
        `${count.days} days of ${type.name} needs supporting documentation. Have it ready ` +
        `— whoever approves this will ask for it.`,
    });
  }

  if (count.days > availableNow) {
    warnings.push({
      code: 'NOT_ENOUGH_DAYS',
      message: type.exceedableWithDocument
        ? `This is ${count.days} days and you have ${availableNow} left. ${type.name} may go ` +
          `past its allowance with documentation, so this can still be submitted.`
        : `This is ${count.days} days and you have ${availableNow} left, so it cannot be ` +
          `submitted as it stands.`,
    });
  }

  return {
    leaveTypeId: type.id,
    leaveTypeName: type.name,
    from: period.from,
    to: period.to,
    countingBasis: type.countingBasis,
    countingBasisInWords: countingBasisInWords(type.countingBasis),
    days: count.days,
    calendarDays: count.calendarDays,
    free: count.free,
    availableNow,
    availableAfter: availableNow - count.days,
    approvedBy: approvalChainInWords(type),
    warnings,
  };
}

/**
 * How many days' notice a request submitted today gives. FR 17.
 *
 * Calendar days between the day it is asked for and the first day off, so a request
 * made on Monday for the following Monday gives seven whatever the person's working
 * pattern is. Notice is about how much warning somebody had, and a manager's warning
 * does not shorten because the requester does not work Wednesdays.
 *
 * Zero for leave starting today, and negative for leave that has already begun — which
 * is FR 18's backdating, a real thing HR does for somebody who was off sick and could
 * not ask. {@link noticeShortfall} takes any negative as the full shortfall; the
 * magnitude is carried anyway, because "three weeks late" and "a day late" are not the
 * same conversation and a screen showing the number should show the true one.
 *
 * Both directions go through {@link calendarDaysBetween}, which counts inclusively and
 * clamps at zero for a pair the wrong way round — so each direction is asked with its
 * own arguments in the right order rather than one subtraction being trusted to go
 * negative.
 */
export function noticeGiven(asAt: CalendarDate, from: CalendarDate): number {
  return from >= asAt
    ? calendarDaysBetween(asAt, from) - 1
    : -(calendarDaysBetween(from, asAt) - 1);
}

/**
 * What the RESERVATION says it is for. FR 27.
 *
 * The sentence somebody reads beside five days missing from their balance, so it
 * carries the three things they would otherwise have to go and look up: what kind of
 * leave, how much, and when. The request id is not in it and does not need to be —
 * `leave_ledger_entry.leave_request_id` is the join, and a reason full of identifiers
 * is a reason nobody reads.
 *
 * Composed here rather than in the service for the reason `reasonForGrant` is: the
 * words in somebody's balance history are part of what the system promises, and a
 * service assembling them is a service that can assemble them differently next time.
 */
export function reasonForReservation(typeName: string, period: LeavePeriod, days: number): string {
  return (
    `${days} ${days === 1 ? 'day' : 'days'} of ${typeName} requested, ` +
    `${period.from} to ${period.to}, held while it is decided`
  );
}

/* ------------------------------------------------------------ what is stored */

/**
 * That the four fields somebody filled in are four fields.
 *
 * The dates are checked for shape only. Whether they are a *period* — the right way
 * round, and costing something, and inside one leave year — is
 * {@link validateLeavePeriod}, {@link assertItCostsSomething} and
 * {@link reachesPastTheEndOf}, each of which refuses with a message naming the days.
 * Asking the same question twice in two voices is how two different sentences come to be
 * shown for one mistake, so this asks none of them again.
 *
 * By the time anything reaches here all three have been asked, in the order the answers
 * become possible in — see ../services/leave-request-service.ts. What is left is the
 * four fields being four fields.
 */
export function validateNewLeaveRequest(input: {
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  from: CalendarDate;
  to: CalendarDate;
  reason: string;
  countingBasis: CountingBasis;
  days: number;
  calendarDays: number;
}): ValidatedLeaveRequest {
  return {
    employeeId: requireId('employeeId', input.employeeId),
    leaveTypeId: requireId('leaveTypeId', input.leaveTypeId),
    leaveYearId: requireId('leaveYearId', input.leaveYearId),
    from: requireDay('from', input.from),
    to: requireDay('to', input.to),
    reason: requireReason(input.reason),
    countingBasis: input.countingBasis,
    days: requireWholeDays('days', input.days),
    calendarDays: requireWholeDays('calendarDays', input.calendarDays),
    /* Not a parameter. A caller that could choose the status could submit something
       already approved, and the README's rule is that only the state machine moves
       one — which starts with only one thing being able to create one. */
    status: 'SUBMITTED',
  };
}

/**
 * A changed reason, or nothing.
 *
 * Deliberately not a general update. The one editable field is checked the same way
 * it was on the way in, so a reason cannot be blanked afterwards by a path the create
 * would have refused.
 */
export function validateLeaveRequestChanges(changes: LeaveRequestChanges): { reason: string } {
  if (changes.reason === undefined) {
    throw new InvalidLeaveRequest(
      'reason',
      'There is nothing to change. The dates, the kind of leave and what it cost are ' +
        'what the days were reserved against and cannot be edited; only the reason can.',
    );
  }

  return { reason: requireReason(changes.reason) };
}

function requireId(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidLeaveRequest(field, `${field} is required.`);
  }

  return value.trim();
}

function requireDay(field: string, value: unknown): CalendarDate {
  if (!isCalendarDate(value)) {
    throw new InvalidLeaveRequest(
      field,
      `${field} is a date in the form YYYY-MM-DD. 03/04/2026 and 04/03/2026 are the ` +
        `same ten characters meaning two different days.`,
    );
  }

  return value;
}

/**
 * FR 10, and the argument for it being mandatory is in {@link NewLeaveRequest}.
 *
 * Trimmed, never defaulted, and unconstrained beyond being something — the same rule a
 * ledger entry's reason is held to, and for the same reason: a reason nobody can write
 * freely is a reason everybody writes 'leave' in.
 */
function requireReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidLeaveRequest(
      'reason',
      'A leave request says why. Whoever approves it is being asked to agree to ' +
        'something, and a request with nothing against it asks them to agree to it blind.',
    );
  }

  return value.trim();
}

/** FR 24. Leave is requested in whole days; the ledger's fractions are entitlement. */
function requireWholeDays(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new InvalidLeaveRequest(
      field,
      `${field} is a whole number of days, at least one. Leave is requested in whole ` +
        `days — FR 24 — and a morning off is settled with a manager rather than here.`,
    );
  }

  return value;
}
