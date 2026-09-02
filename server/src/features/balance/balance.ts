/** The cached balance. §5.7, LMS 211, FR 37, FR 36a, §8.6, FR 26, LMS 212, FR 32a, §8.2. */

import { isWholeDays, WHOLE_DAYS_ONLY } from '../../shared/whole-days.js';

/** The five columns, named as the domain names them. §5.7.. */
export const BALANCE_BUCKETS = [
  'entitled',
  'carriedOver',
  'adjustment',
  'taken',
  'pending',
] as const;

export type BalanceBucket = (typeof BALANCE_BUCKETS)[number];

/** What a balance is keyed by. */
export interface BalanceKey {
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
}

/** One balance, as the cache holds it. */
export interface LeaveBalance extends BalanceKey {
  /** GRANT entries. */
  entitled: number;
  /** CARRY_FORWARD less EXPIRY. FR 36, FR 36a. */
  carriedOver: number;
  /** ADJUSTMENT entries. FR 37. */
  adjustment: number;
  /** Days consumed by approved leave, as a positive count. FR 24. */
  taken: number;
  /** Days held for leave asked for and not yet decided. FR 24. */
  pending: number;
  /** When the cache last moved, or null where nothing has moved it. */
  updatedAt: Date | null;
}

/** What this person may still book. §8.6. */
export function available(balance: LeaveBalance): number {
  return round(
    balance.entitled + balance.carriedOver + balance.adjustment - balance.taken - balance.pending,
  );
}

/** Everything this person was given, before anything they have spent. */
export function owed(balance: LeaveBalance): number {
  return round(balance.entitled + balance.carriedOver + balance.adjustment);
}

/** Days spoken for, whether decided or not. */
export function committed(balance: LeaveBalance): number {
  return balance.taken + balance.pending;
}

/** A balance with nothing in it yet. */
export function noMovementsYet(key: BalanceKey): LeaveBalance {
  return {
    ...key,
    entitled: 0,
    carriedOver: 0,
    adjustment: 0,
    taken: 0,
    pending: 0,
    updatedAt: null,
  };
}

/** Whether anything has ever moved this balance. */
export function hasMoved(balance: LeaveBalance): boolean {
  return balance.updatedAt !== null;
}

/** Whether the two are the same balance. */
export function isTheSameBalance(one: BalanceKey, other: BalanceKey): boolean {
  return (
    one.employeeId === other.employeeId &&
    one.leaveTypeId === other.leaveTypeId &&
    one.leaveYearId === other.leaveYearId
  );
}

/** A reserve that would take more days than there are. FR 26. */
export class BalanceOverdrawn extends Error {
  readonly requested: number;
  readonly available: number;
  /** Positive. */
  readonly shortBy: number;

  constructor(requested: number, availableDays: number) {
    super(
      `That is ${requested} days against a balance of ${availableDays}. ` +
        `${round(requested - availableDays)} more days are being asked for than are left.`,
    );
    this.name = 'BalanceOverdrawn';
    this.requested = requested;
    this.available = availableDays;
    this.shortBy = round(requested - availableDays);
  }
}

/**
 * A commit or a release of days that were never held.
 *
 * The error that makes "my days cannot be deducted twice" true rather than hoped
 * for. Approving the same five days a second time asks to take five days out of a
 * hold that has already been spent, and there is nothing there to take.
 */
export class NotEnoughHeld extends Error {
  readonly requested: number;
  readonly held: number;

  constructor(what: string, requested: number, held: number) {
    super(
      `That is ${requested} days to ${what}, and only ${held} are being held for this ` +
        `balance. Days can only be ${what === 'approve' ? 'approved' : 'given back'} once, ` +
        `and only after they were reserved — so this is either a second attempt at ` +
        `something that already happened or a figure that does not match the request.`,
    );
    this.name = 'NotEnoughHeld';
    this.requested = requested;
    this.held = held;
  }
}

/**
 * How many days a reserve may hold. FR 26.
 *
 * The first of the three rules that make this the only place a balance moves, and the
 * one that has an exception. `mayExceed` is `leave_type.exceedable_with_document`,
 * read from the type rather than decided here: FR 32a makes sick leave a
 * documentation threshold rather than a cap, so exceeding it is a request for a
 * medical certificate and not a refusal. §8.6b — "sick balances go negative, and that
 * is correct".
 *
 * That flag is the *only* thing that varies, and it is a column. There is no
 * `if (type.code === …)` here or anywhere above the database; see design principle 5.
 *
 * **This is only sound while the balance was read under a lock**, which is the whole
 * of §8.2 and is why {@link BalanceService} is the one caller. Checked against a
 * figure anybody else could still be moving, this is arithmetic on a number that was
 * true a moment ago.
 */
export function daysToReserve(balance: LeaveBalance, days: number, mayExceed: boolean): number {
  const wanted = wholeDaysToMove('reserve', days);

  if (!mayExceed && wanted > available(balance)) {
    throw new BalanceOverdrawn(wanted, available(balance));
  }

  return wanted;
}

/**
 * A year's entitlement granted a second time. FR 30, LMS 214.
 *
 * The one refusal in this file that is not about arithmetic. Nothing about the figure
 * is wrong: the days are right, the sign is right, and posting it would put a perfectly
 * valid `GRANT` in the ledger. What is wrong is that it has happened already, and the
 * balance would carry a year's entitlement twice.
 *
 * The realistic cause is the ordinary one — the annual job errored halfway through a
 * January morning and somebody ran it again — which is exactly why this refuses rather
 * than the job remembering.
 */
export class AlreadyGranted extends Error {
  readonly grants: number;

  constructor(grants: number) {
    super(
      `This leave year has already been granted for this balance${
        grants > 1 ? `, ${grants} times` : ''
      }. A year's entitlement is granted once; where the figure has changed since, the ` +
        `difference is an adjustment with a reason on it, so that the balance still ` +
        `explains itself. FR 30.`,
    );
    this.name = 'AlreadyGranted';
    this.grants = grants;
  }
}

/** How many days a year's entitlement grants. FR 30, LMS 214, §8.6. */
export function daysToGrant(days: number, grantsAlreadyPosted: number): number {
  if (grantsAlreadyPosted > 0) {
    throw new AlreadyGranted(grantsAlreadyPosted);
  }

  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
    throw new InvalidBalanceMovement(
      `A grant is a number of days somebody is given, and ${String(days)} is not one. A ` +
        `leave type worth nothing to somebody is a rule saying so rather than a grant of ` +
        `nought days, which would be a line in their history that explains nothing.`,
    );
  }

  return days;
}

/**
 * A year's unused days carried across the boundary a second time. FR 36, LMS 217.
 *
 * The sibling of {@link AlreadyGranted} and refused for the same reason: nothing about
 * the figure is wrong, and posting it would put a perfectly valid `CARRY_FORWARD` in the
 * ledger. What is wrong is that it has happened, and the balance would open the year
 * with last year's remainder in it twice.
 *
 * It matters more here than it does for a grant, because the realistic cause is worse. A
 * rollover is three acts over four hundred people and it is the *first* of January: the
 * job that failed at employee three hundred is run again by somebody who does not know
 * how far it got, which is exactly the situation in which "run it again and see" has to
 * be a safe thing to do.
 */
export class AlreadyCarried extends Error {
  readonly carries: number;

  constructor(carries: number) {
    super(
      `Last year's unused days have already been carried into this balance${
        carries > 1 ? `, ${carries} times` : ''
      }. A year is carried forward once; where the figure turned out to be wrong, the ` +
        `difference is an adjustment with a reason on it, so that the balance still ` +
        `explains itself. FR 36.`,
    );
    this.name = 'AlreadyCarried';
    this.carries = carries;
  }
}

/** How many days a carry forward brings into the new year. FR 36, LMS 217, §8.6. */
export function daysToCarry(days: number, carriesAlreadyPosted: number): number {
  if (carriesAlreadyPosted > 0) {
    throw new AlreadyCarried(carriesAlreadyPosted);
  }

  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
    throw new InvalidBalanceMovement(
      `A carry forward is a number of days left over from last year, and ${String(days)} is ` +
        `not one. A balance with nothing left carries nothing, and a balance that is ` +
        `overdrawn carries nothing either — a debt is not written off on the first of ` +
        `January, it is reported and settled by hand. FR 36.`,
    );
  }

  return days;
}

/**
 * How many days an event grant lapses when its time is up. FR 32e, LMS 218.
 *
 * The third of the "days arriving and leaving by rule" rules, beside {@link daysToGrant}
 * and {@link daysToCarry}, and the only one of the three that takes days *away*. It is
 * stated positive like every other movement in this file — which way the balance goes
 * is the operation, and `BalanceService.lapse` is what makes it negative in the ledger.
 *
 * **There is no "already lapsed" count here**, and that is the one place this differs
 * from its two siblings. A grant is granted once per balance per year and a carry
 * arrives once per balance, both of which are questions the *ledger* can answer by
 * counting entries. A lapse is once per **event**, and two events in one balance may
 * each lapse — so the question is a fact about the event row, read inside the same
 * transaction by `BalanceService.lapse` and refused with {@link AlreadyLapsed}.
 * Counting `LAPSE` entries in the balance instead would refuse the second birth's
 * deadline because the first one had already run.
 */
export function daysToLapse(days: number): number {
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
    throw new InvalidBalanceMovement(
      `A lapse is a number of days going unused, and ${String(days)} is not one. A ` +
        `balance with nothing left in it lapses nothing — there is no movement to post ` +
        `— and one that is overdrawn lapses nothing either, because a lapse takes days ` +
        `away and there are none to take. FR 32e.`,
    );
  }

  return days;
}

/**
 * How many days an approval may take out of what is held.
 *
 * Approval does not consume days again — the reserve already did — so this can only
 * ever draw down `pending`, and it is refused where there is not enough of it. That
 * refusal is the story's "so that", stated as arithmetic: five days approved twice is
 * a second commit against a hold that the first one emptied.
 */
export function daysToCommit(balance: LeaveBalance, days: number): number {
  return daysAlreadyHeld('approve', balance, days);
}

/**
 * How many days a withdrawal, refusal or cancellation may give back.
 *
 * The same rule as {@link daysToCommit} and for the same reason from the other side:
 * giving back days that were never held would credit somebody for leave nobody was
 * holding, and doing it twice would credit them twice.
 */
export function daysToRelease(balance: LeaveBalance, days: number): number {
  return daysAlreadyHeld('give back', balance, days);
}

function daysAlreadyHeld(what: string, balance: LeaveBalance, days: number): number {
  const wanted = wholeDaysToMove(what, days);

  if (wanted > balance.pending) {
    throw new NotEnoughHeld(what, wanted, balance.pending);
  }

  return wanted;
}

/**
 * A number of days somebody is asking to move, as the operations state it.
 *
 * Positive and whole, always, and both halves are deliberate.
 *
 * **Positive**, because the three operations are stated the way a person says them —
 * "reserve five days" — and the ledger's signs are ./ledger.ts's business. A caller
 * that has to remember that a reserve is −5 and a release is +5 is a caller that will
 * eventually get one of them backwards, and the entry would still be valid.
 *
 * **Whole**, because FR 24, and because these are the four entry types LMS 209 held
 * to it. Refused here as well as by the column so that the message names the field
 * while somebody still has the form open. Nought is refused for the reason a ledger
 * entry of nought days is: a movement of no days is not a movement.
 */
function wholeDaysToMove(what: string, days: unknown): number {
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
    throw new InvalidBalanceMovement(
      `A ${what} is a number of days, and ${String(days)} is not one of them. It has to be ` +
        `at least one: moving no days is not a movement, and which way the balance goes is ` +
        `decided by the operation rather than by the sign of the figure.`,
    );
  }

  if (!isWholeDays(days)) {
    throw new InvalidBalanceMovement(
      `${String(days)} is not a whole number of days to ${what}. ${WHOLE_DAYS_ONLY}`,
    );
  }

  return days;
}

/**
 * A figure that is not a number of days at all.
 *
 * Separate from {@link BalanceOverdrawn}, which is about a request the balance cannot
 * afford: this one is about a request that is not a request. The first is answered by
 * asking for fewer days and the second by typing something else, so telling them
 * apart is what lets a screen say which.
 */
export class InvalidBalanceMovement extends Error {
  readonly field = 'days';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidBalanceMovement';
  }
}

/**
 * Two decimal places, which is what the columns hold.
 *
 * The same rounding ./ledger.ts does and for the same reason: doubles cannot hold
 * 10.08 exactly, so `20 + 10.08 - 0.01` drifts into a figure with fourteen decimal
 * places on the end of it, and a balance shown to a person has to be one they can
 * add up themselves.
 *
 * It is not a rounding of days. Nothing here changes the size of a movement — the
 * figures arrive already summed by Postgres, which adds `numeric` exactly — and
 * this only puts the arithmetic done above back onto the precision the columns were
 * read at.
 */
function round(days: number): number {
  return Math.round(days * 100) / 100;
}
