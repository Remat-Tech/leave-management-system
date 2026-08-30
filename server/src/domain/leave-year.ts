/**
 * The leave year, and what closing one means. §5.4. LMS 205.
 *
 * Every balance in this system is per person, per leave type, per leave year. The
 * first two have had tables since LMS 201; this is the third, and until now "the
 * leave year" was an idea several files referred to and nothing held.
 *
 * The story is closing one. An HR Administrator settles 2026 — every request
 * decided, every leaver's final figure paid, every late entry made — and says so,
 * and after that the year's numbers are what they were on the day it was said.
 *
 * ## The question this file exists to give one answer to
 *
 * **Which leave year is this day in?** {@link yearFor}, and it has to return
 * exactly one year or none, never two. Two rules hold that, and they are the same
 * rule from opposite sides:
 *
 *   **No two years overlap.** A day in two years draws its balance from two
 *   allowances, and every report of it is a choice about which to believe.
 *
 *   **No two years leave a gap between them.** A day in no year is worse, because
 *   it fails quietly — a request lands on it, the balance it should draw from was
 *   never opened, and nothing refuses anything.
 *
 * Both are held here as {@link assertFitsAmong} and again in the
 * leave-year-rules migration, as an exclusion constraint and a deferred trigger.
 * Neither copy is redundant and the division of labour is the usual one: the
 * database makes a bad row impossible for every writer, including a psql prompt,
 * and these make the refusal name the year it collided with.
 *
 * A gap *after* the last year is not a gap. This database ships with 2026 and
 * 2027 and nothing after, and 2028 is not missing — it is next year's decision.
 *
 * ## Closing is one way, and that is the point
 *
 * {@link assertMayBeClosed} refuses a year that has not ended yet, which is the
 * mistake that actually happens: it is the third of January, somebody is tidying
 * up, and the year they reach for is the one that started two days ago.
 *
 * Nothing here reopens one, and there is no method elsewhere that does. That is
 * what "locked" means — a flag that can be turned back is a flag that says the
 * year was settled until somebody decided otherwise. The database holds the same
 * refusal as a trigger, so it is true of every connection, and the way back is a
 * migration with an argument attached: the same price the audit log charges for
 * its own immutability, for the same reason.
 *
 * ## What closing actually locks today
 *
 * The boundary {@link earliestOpenDayOf} produces, which is what
 * {@link EarliestOpenDay} in ./entitlement-rule.ts has been asking for since
 * LMS 203 and getting `NOTHING_IS_CLOSED_YET` for. No entitlement figure may be
 * dated back into a settled year, and from this story on that sentence is about
 * rows rather than about an argument somebody passed.
 *
 * The balances themselves are `leave_balance` and `leave_ledger_entry`, which
 * arrive with LMS 210 and LMS 214 carrying a `leave_year_id` each. Not stubbed
 * here: a flag guarding nothing is a flag nobody trusts, and what those stories
 * need from this one is a row to point at and a boolean to read.
 */

import { type CalendarDate, dayAfter, dayBefore, isCalendarDate } from './time.js';

/** What the caller supplies to create one. */
export interface NewLeaveYear {
  /** What HR calls it. '2026', or '2026/27' for a year that runs April to March. */
  label: string;
  /** The first day the year covers. Inclusive. */
  startDate: CalendarDate;
  /** The last day it covers. Inclusive, because that is how a person says it. */
  endDate: CalendarDate;
}

/**
 * The fields of an existing one that may change.
 *
 * `isClosed` is not among them, for the reason it is not an ordinary leave type
 * edit either: closing a year is a decision about every figure in it rather than
 * a correction to what the year is, and putting the flag in an ordinary edit
 * would give that decision a second door nobody would remember to guard. It is
 * {@link LeaveYearService.close}, and there is no matching `reopen`.
 *
 * The dates are among them only while the year is open. A year that has settled
 * nothing may be corrected freely — the honest fix for one typed wrong in January
 * is to fix it — and one that has been closed may only be relabelled. Calling a
 * year by a better name does not change which days it covered, exactly as
 * improving the note on an entitlement rule in effect does not change the figure.
 */
export type LeaveYearChanges = Partial<NewLeaveYear>;

/** A record as it comes back out. */
export interface LeaveYear {
  id: string;
  label: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  /** Settled. Never goes back; see the module note. */
  isClosed: boolean;
  /** When it was closed, stamped by the database. Null while it is open. */
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The shape a validated record has by the time it reaches the repository. */
export interface ValidatedLeaveYear {
  label: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
}

/**
 * A year that was refused, and the field that caused it.
 *
 * The same shape as {@link InvalidLeaveType} and for the same reason, NFR USA 03:
 * the message has to reach the form beside the input it is about, and this one
 * has a rule that spans both dates.
 */
export class InvalidLeaveYear extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidLeaveYear';
    this.field = field;
  }
}

export class LeaveYearNotFound extends Error {
  readonly leaveYearId: string;

  constructor(id: string) {
    super(`No leave year with id ${id}.`);
    this.name = 'LeaveYearNotFound';
    this.leaveYearId = id;
  }
}

export class DuplicateLeaveYearLabel extends Error {
  constructor(label: string) {
    super(
      `There is already a leave year called ${label}. Two years under one name is a ` +
        `screen where somebody picks the wrong one.`,
    );
    this.name = 'DuplicateLeaveYearLabel';
  }
}

/**
 * Two years covering the same day.
 *
 * The year already there is named, because "those dates overlap" is not
 * actionable and "they overlap 2026, which runs to the thirty first of December"
 * is.
 */
export class OverlappingLeaveYears extends Error {
  readonly leaveYearId: string;

  constructor(existing: LeaveYear) {
    super(
      `Those dates fall inside ${existing.label}, which runs from ${existing.startDate} ` +
        `to ${existing.endDate}. A day can only be in one leave year, or its balance ` +
        `would be drawn from two allowances at once.`,
    );
    this.name = 'OverlappingLeaveYears';
    this.leaveYearId = existing.id;
  }
}

/**
 * A day in no leave year at all.
 *
 * The quiet failure, refused loudly. Leave taken in the gap would draw on a
 * balance nobody opened, and the rollover of FR 36 would have nothing to carry
 * into.
 */
export class LeaveYearLeavesAGap extends Error {
  readonly neighbourId: string;

  constructor(neighbour: LeaveYear, gapFrom: CalendarDate, gapTo: CalendarDate) {
    super(
      `That would leave ${gapFrom} to ${gapTo} in no leave year at all, between this ` +
        `one and ${neighbour.label}. Leave years run one after another with no day ` +
        `between them; define the year that fills the gap first.`,
    );
    this.name = 'LeaveYearLeavesAGap';
    this.neighbourId = neighbour.id;
  }
}

/**
 * A settled year being changed, reopened, or closed twice.
 *
 * `attempted` is the word that goes in the message — "changed", "reopened" — so
 * that the refusal names what was being done rather than describing every
 * possibility. The same shape as {@link EntitlementRuleAlreadyApplies}, and for
 * the same reason: a refusal with no second sentence is a refusal somebody works
 * around.
 */
export class LeaveYearAlreadyClosed extends Error {
  readonly leaveYearId: string;

  constructor(year: LeaveYear, attempted = 'changed') {
    super(
      `${year.label} was closed and cannot be ${attempted}. Its balances are what ` +
        `they were on the day it was closed, which is the whole of what closing a ` +
        `year is for. Reopening one is a migration with a reason attached.`,
    );
    this.name = 'LeaveYearAlreadyClosed';
    this.leaveYearId = year.id;
  }
}

/** A year still running, being closed. */
export class LeaveYearNotFinished extends Error {
  readonly leaveYearId: string;
  readonly endDate: CalendarDate;

  constructor(year: LeaveYear, today: CalendarDate) {
    super(
      `${year.label} runs to ${year.endDate} and today is ${today}, so it has not ` +
        `finished yet. Closing it would freeze figures that people are still adding ` +
        `to. Close it once it has ended and its requests have been settled.`,
    );
    this.name = 'LeaveYearNotFinished';
    this.leaveYearId = year.id;
    this.endDate = year.endDate;
  }
}

/* ------------------------------------------------------------- what is valid */

/** Checks and tidies a new record. */
export function validateNewLeaveYear(input: NewLeaveYear): ValidatedLeaveYear {
  const validated: ValidatedLeaveYear = {
    label: requireLabel(input.label),
    startDate: requireDay('startDate', input.startDate),
    endDate: requireDay('endDate', input.endDate),
  };

  assertRunsForwards(validated);

  return validated;
}

/**
 * Checks and tidies a change to an existing one.
 *
 * Takes the current record, like {@link validateLeaveTypeChanges}, because the
 * one rule here spans both dates and a change usually mentions only one of them:
 * moving the end of a year alone has to be judged against the start already on
 * the row.
 */
export function validateLeaveYearChanges(
  changes: LeaveYearChanges,
  current: LeaveYear,
): Partial<ValidatedLeaveYear> {
  const validated: Partial<ValidatedLeaveYear> = {};

  if ('label' in changes) {
    validated.label = requireLabel(changes.label);
  }
  if ('startDate' in changes) {
    validated.startDate = requireDay('startDate', changes.startDate);
  }
  if ('endDate' in changes) {
    validated.endDate = requireDay('endDate', changes.endDate);
  }

  assertRunsForwards({
    label: current.label,
    startDate: current.startDate,
    endDate: current.endDate,
    ...validated,
  });

  return validated;
}

/**
 * The rule that is about both dates at once.
 *
 * Strictly greater rather than "at least equal", because a leave year of one day
 * is a typo in the same family as one that ends before it starts. A year that
 * covers no day at all reads as "this year is nothing", which is never what
 * somebody typing it meant.
 */
function assertRunsForwards(year: ValidatedLeaveYear): void {
  if (year.endDate <= year.startDate) {
    throw new InvalidLeaveYear(
      'endDate',
      `A leave year cannot end on ${year.endDate}, which is not after it starts on ` +
        `${year.startDate}. Both days are inside the year: 2026 runs from 2026-01-01 ` +
        'to 2026-12-31.',
    );
  }
}

/* --------------------------------------------------------------- the readings */

/**
 * Whether the year covers that day. Inclusive both ends.
 *
 * A string comparison, which is the whole reason a {@link CalendarDate} is ten
 * characters: `'2026-12-31' < '2027-01-01'` is true for every pair of dates in
 * this form, so there is no parsing, no zone and no library between the question
 * and the answer.
 */
export function coversDay(year: LeaveYear, day: CalendarDate): boolean {
  return year.startDate <= day && day <= year.endDate;
}

/**
 * The year a day falls in, or undefined where none does.
 *
 * Undefined is an answer rather than a failure, and it is the honest one: this
 * system holds no leave year before 2026 and none after whatever HR has defined,
 * and a request dated into either is a question about a year nobody has decided
 * on. A caller has to say what that means for them — the request workflow refuses
 * it, a report shows nothing — and throwing here would make every one of them
 * catch it.
 *
 * That there is at most one is not this function's doing. It is
 * {@link assertFitsAmong} and `leave_year_never_overlaps`, and without them this
 * would be "whichever year the list happened to hold first".
 */
export function yearFor(years: readonly LeaveYear[], day: CalendarDate): LeaveYear | undefined {
  return years.find((year) => coversDay(year, day));
}

/**
 * The first day still open to change, or null where nothing has been closed.
 *
 * The day after the latest closed year ends, which is what
 * {@link EarliestOpenDay} in ./entitlement-rule.ts has been asking for since
 * LMS 203 and being told `NOTHING_IS_CLOSED_YET`. Null keeps meaning exactly what
 * it meant then — no year has been closed — which is the true answer on a fresh
 * database and stays a truthful one rather than becoming a stub.
 *
 * The *latest* closed year rather than the earliest open one, and the difference
 * only shows if somebody closes 2027 while 2026 is still open. Nothing refuses
 * that and it would be an odd thing to do; reading the latest closed end means the
 * boundary is the safe one either way, because a year somebody has declared
 * settled cannot be reached back into through a hole left in front of it.
 */
export function earliestOpenDayOf(years: readonly LeaveYear[]): CalendarDate | null {
  const closed = years.filter((year) => year.isClosed);

  if (closed.length === 0) {
    return null;
  }

  return dayAfter(
    closed
      .map((year) => year.endDate)
      .sort()
      .at(-1)!,
  );
}

/**
 * Refuses a year that would overlap another, or leave a gap beside one.
 *
 * `others` is every year except this one, which matters when a year is being
 * edited rather than created: a year always overlaps itself, and judging it
 * against its own row would refuse every correction.
 *
 * The two checks are one rule from opposite sides — a day has to be in exactly
 * one leave year — so they are asked together and neither is optional. A gap is
 * measured only against a year that is actually there: the first year in the
 * table has nothing before it and the last has nothing after it, and neither of
 * those is a hole.
 */
export function assertFitsAmong(
  candidate: Pick<LeaveYear, 'startDate' | 'endDate'>,
  others: readonly LeaveYear[],
): void {
  const overlap = others.find(
    (year) => year.startDate <= candidate.endDate && candidate.startDate <= year.endDate,
  );

  if (overlap !== undefined) {
    throw new OverlappingLeaveYears(overlap);
  }

  const before = latest(others.filter((year) => year.endDate < candidate.startDate));
  if (before !== undefined && dayAfter(before.endDate) !== candidate.startDate) {
    throw new LeaveYearLeavesAGap(before, dayAfter(before.endDate), dayBefore(candidate.startDate));
  }

  const after = earliest(others.filter((year) => year.startDate > candidate.endDate));
  if (after !== undefined && dayAfter(candidate.endDate) !== after.startDate) {
    throw new LeaveYearLeavesAGap(after, dayAfter(candidate.endDate), dayBefore(after.startDate));
  }
}

/**
 * Refuses a change to a year that has been closed.
 *
 * The label is exempt and is the only thing that is, which is the same exemption
 * an entitlement rule in effect makes for its note. Calling a year by a better
 * name does not change which days it covered or what anybody was owed in it;
 * moving its dates does both.
 */
export function assertMayBeChanged(year: LeaveYear, changes: LeaveYearChanges): void {
  if (!year.isClosed) {
    return;
  }

  if ('startDate' in changes || 'endDate' in changes) {
    throw new LeaveYearAlreadyClosed(year, 'given different dates');
  }
}

/**
 * Refuses closing a year that cannot be closed yet, or again.
 *
 * `today` is passed in rather than read, for the reason every date in `/domain`
 * is passed in: this file has no clock, so "has it finished" can be asked about
 * any day rather than only about now, and the service is the one place that
 * decides which clock the answer comes from.
 *
 * The comparison is against the last day of the year, so a year is closable from
 * the day after it ends. Whether it *should* be closed then is HR's judgement and
 * deliberately not a rule here — FR 18 lets an absence be recorded a week late,
 * so they will wait, and a system that made them wait a fixed number of days
 * would be inventing a policy nobody asked for.
 */
export function assertMayBeClosed(year: LeaveYear, today: CalendarDate): void {
  if (year.isClosed) {
    throw new LeaveYearAlreadyClosed(year, 'closed again');
  }

  if (year.endDate >= today) {
    throw new LeaveYearNotFinished(year, today);
  }
}

/** Years in the order they run, which is the order every screen shows them in. */
export function byStartDate(left: LeaveYear, right: LeaveYear): number {
  return left.startDate < right.startDate ? -1 : left.startDate > right.startDate ? 1 : 0;
}

/* ---------------------------------------------------------------- the fields */

/**
 * What the year is called on the screen somebody picks it from.
 *
 * Trimmed rather than refused when it arrives padded, as a department name is.
 * Deliberately not derived from the start date: that arithmetic is right for a
 * year running January to December and wrong the moment somebody runs April to
 * March, where the year everybody says out loud is '2026/27'.
 */
function requireLabel(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidLeaveYear(
      'label',
      'A leave year needs a name. It is what people call it — 2026, or 2026/27 for ' +
        'a year that runs April to March.',
    );
  }

  const label = value.trim();

  if (label.length > 40) {
    throw new InvalidLeaveYear(
      'label',
      'A leave year name is longer than the 40 characters the record holds.',
    );
  }

  return label;
}

function requireDay(field: string, value: unknown): CalendarDate {
  if (!isCalendarDate(value)) {
    throw new InvalidLeaveYear(
      field,
      `${field === 'startDate' ? 'The first day' : 'The last day'} of a leave year is a ` +
        'date in the form YYYY-MM-DD. A year begins and ends on a day, so it is ' +
        'written as one — 31/07/2026 and 07/31/2026 are the same eleven characters ' +
        'meaning two different days.',
    );
  }

  return value;
}

function latest(years: readonly LeaveYear[]): LeaveYear | undefined {
  return [...years].sort(byStartDate).at(-1);
}

function earliest(years: readonly LeaveYear[]): LeaveYear | undefined {
  return [...years].sort(byStartDate)[0];
}
