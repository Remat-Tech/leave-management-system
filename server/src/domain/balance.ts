/**
 * The cached balance. §5.7, design principle 1. LMS 211.
 *
 * The story is somebody opening the system and seeing what they have left, in the
 * time it takes a screen to draw. ./ledger.ts can answer the same question and is
 * the only thing that can answer it *correctly* — but answering it there means
 * adding up every movement the person has ever had, every time any screen shows a
 * figure. This file is about the sum, kept.
 *
 * ## Five figures, and available is not one of them
 *
 * `entitled + carriedOver + adjustment − taken − pending`. {@link available} is the
 * subtraction and there is no column behind it, which is deliberate: it is not a
 * sixth fact, it is what the five facts are for. Storing it would put the formula
 * in two languages, and the day the sign of one term changed, one of them would be
 * edited.
 *
 * The five are kept apart rather than netted for a reason each:
 *
 *   **`entitled` and `adjustment` are different sentences.** "The policy gave me
 *   this" and "somebody decided this" are what an employee looking at a surprising
 *   figure most needs told apart, and FR 37's manual movements would be invisible
 *   inside the entitlement if they shared a column.
 *
 *   **`carriedOver` is its own figure because it expires.** FR 36a caps it and
 *   lapses it in a named month, and "how many carried days are left" has to be
 *   readable without a subtraction the reader has to know to perform.
 *
 *   **`taken` and `pending` are not the same fact.** Five days pending is leave
 *   somebody may still be told they cannot have. Both are subtracted, because days
 *   spoken for are not days to spend twice, but a screen has to be able to say
 *   which is which.
 *
 * ## Nothing here computes a balance, and nothing here writes one
 *
 * The projection — which of the five columns each of the eight kinds of movement
 * moves — is `rebuild_one_balance_from_the_ledger()` in the cached-balance-table
 * migration, and it is the only implementation of it anywhere. `BUCKETS` in
 * ./ledger.ts is the same statement in this language, and ../../tests/integration/balance.test.ts
 * asserts the two agree by posting one entry of each kind and checking that exactly
 * the named columns moved.
 *
 * A second copy of that arithmetic here would be the drift the cache exists to be
 * checked against — the thing the immutable-leave-ledger migration declined to
 * write and said why. So this file reads a balance and says what it means; it never
 * produces one.
 *
 * ## A balance can be negative, and that is not an error
 *
 * §8.6b: sick leave is `exceedable_with_document`, so exceeding the allowance asks
 * for a medical certificate rather than refusing, and the balance goes below zero.
 * There is no `Math.max(0, …)` anywhere in this file and there should never be one:
 * a figure clamped at zero is a figure that has stopped explaining itself, which is
 * the whole thing design principle 1 is against.
 */

/**
 * The five columns, named as the domain names them. §5.7.
 *
 * Ordered as a balance reads rather than alphabetically: what somebody was given,
 * then what they have spent. It is the order a screen lays them out in and the
 * order the terms appear in {@link available}.
 *
 * The same five are `BUCKETS` in ./ledger.ts, which says which of them each kind of
 * ledger entry moves. That file states the projection and this one states the
 * columns; the unit suite asserts neither has grown a name the other has not.
 */
export const BALANCE_BUCKETS = [
  'entitled',
  'carriedOver',
  'adjustment',
  'taken',
  'pending',
] as const;

export type BalanceBucket = (typeof BALANCE_BUCKETS)[number];

/**
 * What a balance is keyed by. Employee, leave type, leave year.
 *
 * The same three the ledger files every movement under, and the same three
 * `leave_balance_one_per_year` holds unique. "How many days do I have" is not a
 * question until all three are named — annual leave and sick leave are different
 * balances, and last year's annual leave is a third.
 */
export interface BalanceKey {
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
}

/**
 * One balance, as the cache holds it.
 *
 * `updatedAt` is null for a balance nothing has moved yet — see
 * {@link noMovementsYet}. It is the only nullable field and it is the honest one:
 * "when did this figure last change" has no answer where it has never changed, and
 * a fabricated timestamp would be a claim that something happened.
 */
export interface LeaveBalance extends BalanceKey {
  /** GRANT entries. What the year's entitlement rule was worth to this person. */
  entitled: number;
  /** CARRY_FORWARD less EXPIRY. FR 36 and FR 36a. */
  carriedOver: number;
  /** ADJUSTMENT entries. FR 37, and the only figure that goes either way. */
  adjustment: number;
  /** Days consumed by approved leave, as a positive count. Whole days, FR 24. */
  taken: number;
  /** Days held for leave asked for and not yet decided. Whole days, FR 24. */
  pending: number;
  /** When the cache last moved, or null where nothing has moved it. */
  updatedAt: Date | null;
}

/**
 * What this person may still book. The figure the story is about.
 *
 * `entitled + carriedOver + adjustment − taken − pending`, and the two subtractions
 * are the half worth reading twice. `taken` and `pending` are held as positive
 * counts — the ledger records a RESERVATION as −5 days and the cache records it as
 * five days pending — so this subtracts where a naive sum of signed movements would
 * add. `runningTotal` in ./ledger.ts is that naive sum, is named `after` rather than
 * `balance` for exactly this reason, and answers a different question.
 *
 * May be negative. §8.6b, and see the note at the top of this file.
 */
export function available(balance: LeaveBalance): number {
  return round(
    balance.entitled + balance.carriedOver + balance.adjustment - balance.taken - balance.pending,
  );
}

/**
 * Everything this person was given, before anything they have spent.
 *
 * The top half of {@link available}, and what a screen shows beside it as "of 25
 * days". Separate because a person reading "3 left" wants to know three out of
 * what, and because the answer is three figures rather than the entitlement alone.
 */
export function owed(balance: LeaveBalance): number {
  return round(balance.entitled + balance.carriedOver + balance.adjustment);
}

/** Days spoken for, whether decided or not. The bottom half of {@link available}. */
export function committed(balance: LeaveBalance): number {
  return balance.taken + balance.pending;
}

/**
 * A balance with nothing in it yet.
 *
 * What a key with no cached row means, and why the repository returns one of these
 * rather than `undefined`: a balance nobody has posted a movement against is not
 * missing, it is empty. Somebody who has joined and whose grant has not run yet has
 * nought days, and every caller writing its own `?? 0` five times would be five
 * places for one of them to be a `?? null`.
 *
 * `updatedAt` is null, which is how a caller that genuinely needs to tell "empty"
 * from "moved back to nought by a correcting adjustment" can do so. Those are
 * different histories and the ledger is where the difference is legible.
 */
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

/**
 * Whether the two are the same balance.
 *
 * Ids compare as text — see the note in ../db/schema.ts about why a `bigint` stays
 * a string — so this is an exact match on three of them rather than arithmetic.
 */
export function isTheSameBalance(one: BalanceKey, other: BalanceKey): boolean {
  return (
    one.employeeId === other.employeeId &&
    one.leaveTypeId === other.leaveTypeId &&
    one.leaveYearId === other.leaveYearId
  );
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
