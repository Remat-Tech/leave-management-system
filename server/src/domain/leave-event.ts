/**
 * Entitlement that arrives with an event. FR 32g, FR 32e, §8.6, LMS 218, LMS 201, FR 36, FR 36a, FR 31.
 */

import type { CalendarDate } from './time.js';
import { monthsAfter } from './time.js';

/** What the caller supplies to record one. */
export interface NewLeaveEvent {
  employeeId: string;
  leaveTypeId: string;
  /** The day it happened, which is not the day it was recorded. */
  occurredOn: CalendarDate;
  /** HR's words, for the person reading their own history. */
  note?: string | null;
}

/** A record as it comes back out. */
export interface LeaveEvent {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  occurredOn: CalendarDate;
  /** FR 32e. */
  expiresOn: CalendarDate | null;
  note: string | null;
  /** The `GRANT` this event caused. */
  grantedEntryId: string;
  /** The `LAPSE` that closed it off, or null while there is still time. */
  lapsedEntryId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The shape a validated record has by the time it reaches the repository. */
export interface ValidatedLeaveEvent {
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  occurredOn: CalendarDate;
  expiresOn: CalendarDate | null;
  note: string | null;
  grantedEntryId: string;
}

/** An event that was refused, and the field that caused it. NFR USA 03. */
export class InvalidLeaveEvent extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidLeaveEvent';
    this.field = field;
  }
}

export class LeaveEventNotFound extends Error {
  readonly leaveEventId: string;

  constructor(id: string) {
    super(`No entitlement event with id ${id}.`);
    this.name = 'LeaveEventNotFound';
    this.leaveEventId = id;
  }
}

/**
 * The same event recorded twice.
 *
 * The duplicate that actually happens: somebody rings HR about a birth, and the second
 * person to hear about it does not know the first has already entered it. One event of
 * one kind per person per day — `leave_entitlement_event_one_per_day` — and the
 * refusal says which day it is already recorded against so the caller can see it is
 * the same one.
 *
 * Twins are one birth and one grant. Two births ten months apart are two rows,
 * correctly.
 */
export class EventAlreadyRecorded extends Error {
  readonly occurredOn: CalendarDate;

  constructor(occurredOn: CalendarDate) {
    super(
      `That event is already recorded against this person on ${occurredOn}, and the ` +
        `entitlement for it has been granted. Granting it twice would put the ` +
        `allowance into their balance twice. FR 32g.`,
    );
    this.name = 'EventAlreadyRecorded';
    this.occurredOn = occurredOn;
  }
}

/**
 * A lapse posted against an event that has already lapsed.
 *
 * The sibling of {@link AlreadyGranted} and {@link AlreadyCarried}, and what makes the
 * expiry job safe to run twice — which is not a hypothetical: it is a nightly job, so
 * every night after the first is a second run over the same rows.
 *
 * Read from the event row inside the transaction that posts the lapse, rather than
 * from the job remembering, for the reason every other "already" in this system is:
 * a job that remembers is a job that forgets.
 */
export class AlreadyLapsed extends Error {
  readonly leaveEventId: string;

  constructor(id: string) {
    super(
      `Entitlement event ${id} has already lapsed, and the LAPSE entry for it is in ` +
        `the ledger. Lapsing it again would take the days a second time. FR 32e.`,
    );
    this.name = 'AlreadyLapsed';
    this.leaveEventId = id;
  }
}

/* ---------------------------------------------------------------- the deadline */

/**
 * When an unused grant lapses, or null where it never does. FR 32e.
 *
 * `months` is `leave_type.entitlement_expiry_months`, read off the type rather than
 * decided here: paternity's six, and null on every other type this company has. A
 * `code === 'PATERNITY'` anywhere above the database is the bug design principle 5
 * exists to prevent, and this is the function that would have been the place to write
 * one.
 *
 * The month arithmetic is ./time.ts's {@link monthsAfter}, which clamps the end of a
 * month rather than rolling over it — six months after the thirty-first of August is
 * the twenty-eighth of February and not the third of March.
 *
 * The deadline is the day itself, and a grant lapses *after* it. Somebody whose six
 * months are up on the fourth of September may still take the leave on the fourth; the
 * expiry job lapses what is left from the fifth. A boundary either way is arbitrary
 * and this is the one a person would assume, which is the only argument that matters
 * for a rule somebody is held to.
 */
export function expiryFor(occurredOn: CalendarDate, months: number | null): CalendarDate | null {
  if (months === null) {
    return null;
  }

  if (!Number.isInteger(months) || months <= 0) {
    throw new InvalidLeaveEvent(
      'entitlementExpiryMonths',
      `A grant cannot be usable within ${String(months)} months. A type whose grant ` +
        `does not run out has no expiry month count at all, which is not the same as ` +
        `a count of nought.`,
    );
  }

  return monthsAfter(occurredOn, months);
}

/** Whether this event's grant has run out of time, as at the day given. */
export function hasExpired(event: LeaveEvent, on: CalendarDate): boolean {
  return event.expiresOn !== null && event.expiresOn < on;
}

/** Whether anything is still owed against this event: it has not lapsed and cannot yet. */
export function isStillLive(event: LeaveEvent, on: CalendarDate): boolean {
  return event.lapsedEntryId === null && !hasExpired(event, on);
}

/* --------------------------------------------------------------- what lapses */

/**
 * Why nothing lapsed, in the words a report uses.
 *
 * Closed, and each is a different thing to do about it: nothing, nothing, wait, or
 * look at a balance in a year somebody settled with days still in it.
 */
export const NOT_LAPSED = [
  'ALREADY_LAPSED',
  'NOTHING_LEFT',
  'ANOTHER_GRANT_IS_LIVE',
  'THE_YEAR_IS_CLOSED',
] as const;

export type NotLapsedBecause = (typeof NOT_LAPSED)[number];

/** One expired event, and everything the lapse turns on. */
export interface LapseCandidate {
  /**
   * What is left in the balance the grant landed in: `available`.
   *
   * The balance rather than the grant, and that is the honest limit of what this
   * system can know. There is no per-grant consumption anywhere — §8.6aa lets one
   * grant be drawn down by several requests and the balance is what tracks it — so
   * "whatever remains" is whatever remains of the balance. For the ordinary case,
   * which is one event per balance, those are the same number.
   */
  available: number;
  /**
   * Whether another grant in the same balance is still within its own deadline.
   *
   * The case that makes the paragraph above matter: two births in one leave year, the
   * first six months up and the second not. The days in the balance cannot be
   * attributed to one or the other, so lapsing the first's deadline would take days
   * somebody still has a live claim on. Nothing is lapsed and the run says why; the
   * second deadline will catch whatever is left.
   */
  anotherGrantIsLive: boolean;
  /**
   * Whether the leave year the grant landed in has since been closed.
   *
   * A paternity grant made in December runs to June, and the year it is filed under
   * may well have been settled in February. The ledger refuses every entry but an
   * `ADJUSTMENT` into a closed year and that is right — see §8.9 — so nothing is
   * posted. Nothing is lost either: a closed year's balance cannot be booked against,
   * so the days were already unreachable, and the run reports it rather than failing.
   */
  theYearIsClosed: boolean;
}

/** Lapsed, and how much; or not, and why. */
export type LapseDecision = { days: number } | { because: NotLapsedBecause };

/** Whether the decision was to lapse. */
export function wasLapsed(decision: LapseDecision): decision is { days: number } {
  return 'days' in decision;
}

/**
 * How much of an expired grant lapses. FR 32e.
 *
 * The order of the three refusals is the order they are cheap in, and only the first
 * is load bearing: a live grant in the same balance has to be asked about before the
 * arithmetic, because the arithmetic would otherwise take days that belong to it.
 *
 * **A balance in arrears lapses nothing.** Nought or less means the grant was used and
 * then some — a sick-style overdraft, or an adjustment HR posted — and a `LAPSE` of
 * negative days is a movement the wrong way round that the ledger refuses anyway. The
 * debt is somebody's to settle by hand, exactly as the rollover leaves it.
 */
export function decideTheLapse(candidate: LapseCandidate): LapseDecision {
  if (candidate.anotherGrantIsLive) {
    return { because: 'ANOTHER_GRANT_IS_LIVE' };
  }

  if (candidate.theYearIsClosed) {
    return { because: 'THE_YEAR_IS_CLOSED' };
  }

  return candidate.available > 0 ? { days: candidate.available } : { because: 'NOTHING_LEFT' };
}

/* ------------------------------------------------------------------- the words */

/**
 * What the granting entry says. FR 27.
 *
 * The date the event happened is in the sentence, and it is the whole reason this
 * function exists rather than a template at the call site: "Maternity Leave" and a
 * hundred and twenty days explains nothing, and "for the birth on 4 March 2026"
 * explains all of it. The deadline is there too where there is one, because the person
 * reading it is the person who has to use the days before it.
 */
export function reasonForGrant(
  leaveTypeName: string,
  occurredOn: CalendarDate,
  expiresOn: CalendarDate | null,
): string {
  const granted = `${leaveTypeName} for the event recorded on ${occurredOn}`;

  return expiresOn === null ? granted : `${granted}, usable up to ${expiresOn}`;
}

/**
 * What the lapsing entry says. FR 27, and the sentence somebody disputes.
 *
 * It names the deadline rather than the day the job ran, because the question is
 * always "when was I supposed to have used these" and the answer is not "last night at
 * two in the morning".
 */
export function reasonForLapse(
  leaveTypeName: string,
  occurredOn: CalendarDate,
  expiresOn: CalendarDate,
): string {
  return (
    `Unused ${leaveTypeName} from the event on ${occurredOn} lapsed after ` + `${expiresOn}. FR 32e`
  );
}

/* ------------------------------------------------------------- what is valid */

/**
 * Checks and tidies an event before it is recorded.
 *
 * Every rule here is also a constraint or a trigger in the
 * event-based-entitlement-grants migration, and neither copy is redundant: the
 * database is what holds against a psql prompt, and this is what produces a sentence
 * with a field name on it.
 */
export function validateNewLeaveEvent(input: {
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  occurredOn: CalendarDate;
  expiresOn: CalendarDate | null;
  note?: string | null;
  grantedEntryId: string;
}): ValidatedLeaveEvent {
  const occurredOn = requireDay('occurredOn', input.occurredOn);
  const expiresOn = input.expiresOn === null ? null : requireDay('expiresOn', input.expiresOn);

  if (expiresOn !== null && expiresOn <= occurredOn) {
    throw new InvalidLeaveEvent(
      'expiresOn',
      `A grant cannot run out on ${expiresOn}, which is not after the event on ` +
        `${occurredOn}. A deadline before the thing it is a deadline for is a month ` +
        `count with its sign the wrong way round.`,
    );
  }

  return {
    employeeId: requireId('employeeId', input.employeeId),
    leaveTypeId: requireId('leaveTypeId', input.leaveTypeId),
    leaveYearId: requireId('leaveYearId', input.leaveYearId),
    occurredOn,
    expiresOn,
    note: optionalText(input.note),
    grantedEntryId: requireId('grantedEntryId', input.grantedEntryId),
  };
}

/**
 * Refuses an event dated into the future.
 *
 * Separate from {@link validateNewLeaveEvent} because it takes a clock, and nothing in
 * `/domain` reads one — the service says which day the answer comes from, exactly as
 * `assertMayBeClosed` takes today rather than reading it.
 *
 * A birth cannot be recorded before it has happened, and the failure this prevents is
 * not fraud but a typo: 2027 for 2026 in January puts somebody's maternity leave a
 * year out and starts the six month clock in the wrong place. FR 18's backdating
 * window is deliberately not applied — a birth told to HR three weeks late is
 * ordinary, and refusing it would leave the entitlement ungrantable.
 */
export function assertHasHappened(occurredOn: CalendarDate, today: CalendarDate): void {
  if (occurredOn > today) {
    throw new InvalidLeaveEvent(
      'occurredOn',
      `An event on ${occurredOn} has not happened yet — today is ${today}. Entitlement ` +
        `arrives with the event rather than in anticipation of it, and a date in the ` +
        `future is a year typed wrong far more often than it is a plan. FR 32g.`,
    );
  }
}

function requireDay(field: string, value: unknown): CalendarDate {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new InvalidLeaveEvent(
      field,
      `${field === 'occurredOn' ? 'The day it happened' : 'The day the grant runs out'} is ` +
        `a date in the form YYYY-MM-DD. 03/04/2026 and 04/03/2026 are the same ten ` +
        `characters meaning two different days.`,
    );
  }

  return value as CalendarDate;
}

function requireId(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidLeaveEvent(field, `An entitlement event has to name the ${label(field)}.`);
  }

  return value.trim();
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new InvalidLeaveEvent('note', 'A note is text.');
  }

  const trimmed = value.trim();

  return trimmed === '' ? null : trimmed;
}

function label(field: string): string {
  switch (field) {
    case 'employeeId':
      return 'employee it happened to';
    case 'leaveTypeId':
      return 'kind of leave it entitles them to';
    case 'leaveYearId':
      return 'leave year it falls in';
    case 'grantedEntryId':
      return 'grant it caused';
    default:
      return 'event';
  }
}
