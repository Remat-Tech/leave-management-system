/**
 * The balance ledger. FR 27, §5.7, design principle 1. LMS 210.
 *
 * The story is somebody asking why they have twelve days rather than fifteen, and
 * the answer being a list of rows rather than an assertion. Everything here is
 * either what makes such a row valid or how a run of them is read.
 *
 * ## The ledger is the truth; a balance is what it adds up to
 *
 * Design principle 1, and it is the reason this file has no `Balance` type in it.
 * A running total can only ever say what it is now. A ledger says how it got there,
 * and the difference is the whole of "any figure can be explained rather than taken
 * on trust" — the story's own "so that".
 *
 * {@link runningTotal} is here because reading a history means seeing the figure
 * after each line, which is what makes a list of movements legible as an account.
 * The cached `leave_balance` of §5.7, its five buckets and the reconciliation job
 * that proves the two agree are LMS 211, and deliberately not here: see
 * {@link BUCKETS} for the one part of that projection this file does settle, and
 * why it settles only that part.
 *
 * ## Nine entry types, in two families
 *
 * The division runs through every rule below, so it is worth having in mind before
 * reading any of them.
 *
 *   **Five are about what somebody is owed.** `GRANT`, `CARRY_FORWARD`,
 *   `ADJUSTMENT`, `EXPIRY`, `LAPSE`. Entitlement arriving, surviving a year end,
 *   corrected by hand, or running out — twice, and the two are not the same clock.
 *   These may carry a fraction, because §8.6d pro rates a mid year
 *   joiner to 10.08 days and "FR 24 governs how leave is requested, not how
 *   entitlement is held".
 *
 *   **`EXPIRY` and `LAPSE` are two clocks with similar names**, which is the
 *   distinction ../domain/leave-type.ts named before either existed. `EXPIRY` is
 *   FR 36a: carried days running out in the month HR named, so it takes days back out
 *   of `carriedOver` where the carry put them. `LAPSE` is FR 32e and LMS 218:
 *   paternity's fourteen days unused six months after the birth, so it takes days out
 *   of `entitled` where the *grant* put them. Using one for the other would leave a
 *   balance reading `carriedOver: -14` on a type that cannot carry a single day —
 *   available right, column false, which is the failure design principle 1 exists to
 *   prevent.
 *
 *   **Four are about a request.** `RESERVATION`, `DEDUCTION`, `RELEASE`,
 *   `RECALCULATION`. Days held when leave is asked for, taken when it is approved,
 *   given back when it is not, credited back when a holiday lands inside leave
 *   already approved. These are whole days, because a request is — LMS 209 — and
 *   half a day reserved is a caller that has miscounted rather than a policy.
 *
 * ## Nothing here changes anything
 *
 * There is no `edit`, no `void`, no `reverse` that rewrites. {@link correctionFor}
 * builds a *new* entry that puts an old one right, which is the fourth acceptance
 * criterion and is the only shape a fix takes. The database says the same thing to
 * every other writer with two triggers and by never granting UPDATE or DELETE.
 *
 * A correction is always an `ADJUSTMENT`, and that is not tidiness. Putting right an
 * erroneous `GRANT` of +20 means −20, and putting right an erroneous `EXPIRY` of −5
 * means +5; `ADJUSTMENT` is the only type whose sign is free, so routing corrections
 * through it is what lets the other seven keep a fixed one. It also means a
 * correction is always legible as a correction rather than disguised as a grant.
 *
 * ## What is deliberately not here
 *
 * **No policy.** Who may post an entry is ../auth/ledger-policy.ts. There is no
 * {@link Actor} in any `/domain` file and none should arrive.
 *
 * **No source request.** §5.7 has `leave_request_id` and `leave_request` is §8. A
 * field nothing can populate and nothing can check is the switch with nothing behind
 * it that LMS 209 argued against; it arrives with the table it points at.
 *
 * **No balance projection beyond {@link BUCKETS}.** Which of the five buckets each
 * type moves is one rule that has to live in one place, and the place is the story
 * that builds the cache.
 */

import type { BalanceBucket } from './balance.js';
import { isWholeDays, WHOLE_DAYS_ONLY } from './whole-days.js';

/**
 * Every kind of movement there is. §5.7.
 *
 * Ordered as an account reads rather than alphabetically: what arrives, what
 * survives a year end, what is corrected, the two ways days run out, then the four a
 * request moves. The same list is `leave_ledger_entry_type_known` in the
 * immutable-leave-ledger migration as the event-based-entitlement-grants one left it,
 * and the integration suite asserts the two agree — a type this file knows and the
 * database refuses would be a write that fails at the last moment, and one the
 * database allows and this file does not would be days moving for a reason no screen
 * can render.
 */
export const LEDGER_ENTRY_TYPES = [
  'GRANT',
  'CARRY_FORWARD',
  'ADJUSTMENT',
  'EXPIRY',
  'LAPSE',
  'RESERVATION',
  'DEDUCTION',
  'RELEASE',
  'RECALCULATION',
] as const;

export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/**
 * The four that move days because of a leave request, rather than because of what
 * somebody is owed.
 *
 * The distinction FR 24 turns on. A request is whole days, so these are; what has
 * been accrued is divisible, so the other four are not held to it.
 */
export const REQUEST_MOVEMENTS: readonly LedgerEntryType[] = [
  'RESERVATION',
  'DEDUCTION',
  'RELEASE',
  'RECALCULATION',
];

/**
 * Which way each kind of movement goes. §5.7's own table.
 *
 * `'ADDS'` is a positive amount, `'CONSUMES'` a negative one, `'EITHER'` the one
 * type free in its sign. Zero is refused everywhere: a movement of no days is not a
 * movement, and a row saying so is a line in somebody's history that explains
 * nothing and has to be skipped by every reader forever.
 *
 * Held as data rather than as a switch for the reason the counting basis is a
 * column rather than an `if` on a type code — though the parallel is not exact, and
 * the difference matters. A leave *type* is configuration and HR adds one whenever
 * they like. An entry type is not: adding a ninth is a migration, because the
 * database holds the same list. This is one table read two ways, not a rule that
 * varies.
 */
export const ENTRY_SIGNS: Readonly<Record<LedgerEntryType, 'ADDS' | 'CONSUMES' | 'EITHER'>> = {
  GRANT: 'ADDS',
  CARRY_FORWARD: 'ADDS',
  ADJUSTMENT: 'EITHER',
  EXPIRY: 'CONSUMES',
  LAPSE: 'CONSUMES',
  RESERVATION: 'CONSUMES',
  DEDUCTION: 'CONSUMES',
  RELEASE: 'ADDS',
  RECALCULATION: 'ADDS',
};

/**
 * Which of the cached balance's columns each type moves. §5.7's second table.
 *
 * Here rather than in LMS 211 for one reason: it is the fact that explains why
 * {@link runningTotal} is not a balance, and a reader who has just been told "these
 * do not sum to what is available" is owed the reason on the spot.
 *
 * `DEDUCTION` names two, and it is the whole of the wrinkle. Approval does not
 * consume days a second time — the reservation already did that — it moves them from
 * held to taken, so the pair `RESERVATION -5` then `DEDUCTION -5` is five days gone
 * once and not ten. Any projection that adds signed days into a single figure gets
 * that wrong, which is why there is no such function anywhere in this file.
 *
 * `GRANT` and `LAPSE` are the same pair seen from the other end, and are the reason
 * LMS 218 added a ninth type rather than reusing `EXPIRY`: days that arrived because
 * of an event go back where the grant put them, and days that were carried go back
 * where the carry put them. One entry type cannot do both, because which column it
 * moves would then depend on the leave type — and this table would stop being a
 * table.
 *
 * Written here by LMS 210 as the statement of what LMS 211 would have to implement,
 * in the file that knows what an entry means. LMS 211 implemented it in
 * `rebuild_one_balance_from_the_ledger()`, LMS 213 lifted it into the
 * `what_the_ledger_says` view, and that is the only arithmetic — a second copy in
 * this language would be the drift the cache exists to be checked against. So this
 * stays a statement rather than becoming a function:
 * ../../tests/integration/balance.test.ts posts one entry of each kind and asserts
 * that exactly the columns named here moved, which is what makes the two agree rather
 * than merely both existing.
 */
export const BUCKETS: Readonly<Record<LedgerEntryType, readonly BalanceBucket[]>> = {
  GRANT: ['entitled'],
  CARRY_FORWARD: ['carriedOver'],
  ADJUSTMENT: ['adjustment'],
  EXPIRY: ['carriedOver'],
  LAPSE: ['entitled'],
  RESERVATION: ['pending'],
  DEDUCTION: ['pending', 'taken'],
  RELEASE: ['pending'],
  RECALCULATION: ['taken'],
};

/** The largest movement the column holds, `NUMERIC(6,2)`. */
export const LARGEST_MOVEMENT = 9999.99;

/** What the caller supplies to post one. */
export interface NewLedgerEntry {
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  entryType: LedgerEntryType;
  /** Signed. Positive adds to what the person is owed, negative consumes it. */
  days: number;
  /** FR 27. Why this happened, in words somebody reading a balance can use. */
  reason: string;
  /** The entry this one puts right. Only an `ADJUSTMENT` may name one. */
  correctsId?: string | null;
  /**
   * The request that caused this movement. LMS 301.
   *
   * Required of exactly the four in {@link REQUEST_MOVEMENTS} and refused of every
   * other type — an equivalence rather than a requirement, and both halves matter. A
   * reservation with no request is days held for nothing anybody can find; a grant
   * *with* one is a year's entitlement filed under a fortnight in March, which is the
   * shape a method copied from `reserve` would produce.
   *
   * `leave_ledger_entry_request_movements_name_a_request` holds the same equivalence
   * on every connection. This is the half that says which field was wrong.
   */
  leaveRequestId?: string | null;
}

/** The shape a validated entry has by the time it reaches the repository. */
export interface ValidatedLedgerEntry {
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  entryType: LedgerEntryType;
  days: number;
  reason: string;
  correctsId: string | null;
  leaveRequestId: string | null;
}

/**
 * An entry as it comes back out.
 *
 * There is no `updatedAt`, in the type or in the table, and its absence is the
 * story: a row that is never updated has no such thing, and the column would be a
 * claim that it might be.
 */
export interface LedgerEntry {
  id: string;
  employeeId: string;
  leaveTypeId: string;
  leaveYearId: string;
  entryType: LedgerEntryType;
  days: number;
  reason: string;
  correctsId: string | null;
  /**
   * The request that caused this, for the four in {@link REQUEST_MOVEMENTS}, and null
   * for every other kind. LMS 301.
   */
  leaveRequestId: string | null;
  /** Who, as the writer named themselves. Never null; a job says it is a job. */
  createdBy: string;
  /** Which employee, where the writer was a person. Null for a scheduled job. */
  createdByEmployeeId: string | null;
  createdAt: Date;
}

/**
 * An entry that was refused, and the field that caused it.
 *
 * The same shape as {@link InvalidHoliday} and {@link InvalidEntitlementRule}, and
 * for the same reason, NFR USA 03: the message has to reach the form beside the
 * input it is about.
 */
export class InvalidLedgerEntry extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidLedgerEntry';
    this.field = field;
  }
}

export class LedgerEntryNotFound extends Error {
  readonly entryId: string;

  constructor(id: string) {
    super(`No ledger entry with id ${id}.`);
    this.name = 'LedgerEntryNotFound';
    this.entryId = id;
  }
}

/**
 * An attempt to change or remove an entry that has already been written.
 *
 * Not thrown by anything here, because there is nothing here that changes an entry
 * — which is the point. It exists so that a service or a repository meeting the
 * database's refusal has the sentence to answer with, and so that the sentence says
 * what to do instead rather than only that the door is locked. NFR USA 03.
 */
export class LedgerEntryIsFinal extends Error {
  readonly entryId: string;

  constructor(id: string, attempted: string) {
    super(
      `Ledger entry ${id} cannot be ${attempted}. A balance is made of these rows, so ` +
        `changing one moves a figure with nothing to show for it. Post a compensating ` +
        `adjustment instead: the difference, with a reason saying what went wrong and ` +
        `this entry named as the one it puts right. FR 27.`,
    );
    this.name = 'LedgerEntryIsFinal';
    this.entryId = id;
  }
}

/* ------------------------------------------------------------- what is valid */

/**
 * Checks and tidies an entry before it is posted.
 *
 * Every rule here is also a constraint or a trigger in the immutable-leave-ledger
 * migration, and neither copy is redundant. The database is what holds against a
 * psql prompt, a migration correcting data and a writer that never came through a
 * service. This is what produces a sentence with a field name on it, which is what
 * a screen needs and what a `check_violation` is not.
 */
export function validateNewLedgerEntry(input: NewLedgerEntry): ValidatedLedgerEntry {
  const entryType = requireEntryType(input.entryType);
  const correctsId = optionalId('correctsId', input.correctsId);
  const leaveRequestId = optionalId('leaveRequestId', input.leaveRequestId);

  if (correctsId !== null && entryType !== 'ADJUSTMENT') {
    throw new InvalidLedgerEntry(
      'entryType',
      `A ${entryType} cannot put another entry right. A correction is always an ` +
        `adjustment, because it is the only kind of entry whose amount may go either ` +
        `way — putting right a grant of 20 days means −20, and putting right an ` +
        `expiry of 5 means +5.`,
    );
  }

  /* LMS 301, and an equivalence rather than a requirement. Both halves are refused
     here so that the message names the field, and both are held again by
     `leave_ledger_entry_request_movements_name_a_request` for every other writer. */
  const movesForARequest = REQUEST_MOVEMENTS.includes(entryType);

  if (movesForARequest && leaveRequestId === null) {
    throw new InvalidLedgerEntry(
      'leaveRequestId',
      `A ${entryType} moves days because of a leave request, so it has to say which ` +
        `one. Days held or taken with nothing to point at are days nobody can explain ` +
        `to the person they belong to. FR 27.`,
    );
  }

  if (!movesForARequest && leaveRequestId !== null) {
    throw new InvalidLedgerEntry(
      'leaveRequestId',
      `A ${entryType} is not caused by a leave request, so it cannot name one. What it ` +
        `moves is what somebody is owed rather than what they have asked for, and ` +
        `filing a year's entitlement under a fortnight in March would misfile both.`,
    );
  }

  return {
    employeeId: requireId('employeeId', input.employeeId),
    leaveTypeId: requireId('leaveTypeId', input.leaveTypeId),
    leaveYearId: requireId('leaveYearId', input.leaveYearId),
    entryType,
    days: requireDays(entryType, input.days),
    reason: requireReason(input.reason),
    correctsId,
    leaveRequestId,
  };
}

/**
 * The entry that puts an earlier one right. The story's fourth criterion.
 *
 * Builds the compensating movement rather than performing it: the exact negation of
 * what was posted, in the same balance, as an `ADJUSTMENT` naming the entry it
 * reverses. The caller supplies the reason, because the one thing this cannot know
 * is what went wrong, and FR 27 will not hold a row without it.
 *
 * The negation is exact and is not a figure the caller passes in. A correction the
 * caller could size is a correction that can be the wrong size, and "an adjustment
 * of −18 correcting a grant of 20" is a row that looks reconciled and leaves two
 * days behind. Somebody who wants a different amount wants an ordinary adjustment,
 * which is a different thing and reads as one.
 *
 * Correcting a correction is permitted, deliberately. A wrong reversal is a mistake
 * like any other, and the honest fix for it is another row.
 */
export function correctionFor(entry: LedgerEntry, reason: string): NewLedgerEntry {
  return {
    employeeId: entry.employeeId,
    leaveTypeId: entry.leaveTypeId,
    leaveYearId: entry.leaveYearId,
    entryType: 'ADJUSTMENT',
    days: -entry.days,
    reason: requireReason(reason),
    correctsId: entry.id,
  };
}

/* --------------------------------------------------------------- the readings */

/**
 * The entries in the order they were written, oldest first.
 *
 * By `createdAt` and then by `id`, and the second is not decoration. A year
 * rollover posts a `CARRY_FORWARD` and a `GRANT` in one transaction, so `now()` is
 * identical on both; ordering on the timestamp alone would put them in a different
 * order on different reads, and an account that reorders itself is one nobody can
 * check twice. `leave_ledger_entry_balance` is the same pair, in the same order.
 *
 * Ids compare as numbers held in strings — see the note in ../db/schema.ts about
 * why a `bigint` stays text — so they are compared by length first and then
 * lexically, which is the same order for the non negative integers an identity
 * column produces.
 */
export function inOrderWritten(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.id.length - right.id.length ||
      left.id.localeCompare(right.id),
  );
}

/**
 * Each entry with the figure it left behind it.
 *
 * What makes a list of movements read as an account: a column of amounts is
 * arithmetic somebody has to do, and a column of amounts with the total beside each
 * one is a statement they can check a line at a time. It is the shape a bank
 * statement has, for the reason a bank statement has it.
 *
 * **This total is not the available balance and must never be shown as one.** It is
 * the sum of the signed movements, which answers "what did these rows do" and not
 * "what may this person book" — a `RESERVATION` and the `DEDUCTION` that follows it
 * appear here as ten days consumed where five were. See {@link BUCKETS}: available
 * is five figures, `DEDUCTION` moves days between two of them, and that projection
 * is LMS 211's.
 *
 * Kept anyway, and named for what it is, because the history screen this story
 * makes possible needs a running figure and the alternative is every caller writing
 * its own reduce.
 */
export function runningTotal(entries: readonly LedgerEntry[]): (LedgerEntry & { after: number })[] {
  let total = 0;

  return inOrderWritten(entries).map((entry) => {
    total = round(total + entry.days);
    return { ...entry, after: total };
  });
}

/** Whether this kind of entry is one a leave request caused. */
export function isARequestMovement(entryType: LedgerEntryType): boolean {
  return REQUEST_MOVEMENTS.includes(entryType);
}

/** Whether this entry puts an earlier one right. */
export function isACorrection(entry: LedgerEntry): boolean {
  return entry.correctsId !== null;
}

/* ---------------------------------------------------------------- the fields */

/**
 * How many days, and which way.
 *
 * Three rules in one place because they are one question — is this a movement this
 * ledger can hold — and splitting them would mean a caller meeting them one round
 * trip at a time.
 *
 *   **Not zero, and the right way round.** {@link ENTRY_SIGNS}. A grant of −20 is
 *   somebody who meant an adjustment, and a reservation of +5 is a sign convention
 *   got backwards, which is the bug that shows up as a balance drifting upward.
 *
 *   **Whole, where a request caused it.** FR 24 and LMS 209. The entitlement four
 *   are exempt because §8.6d says what is accrued is divisible.
 *
 *   **Two decimal places, and inside the column.** Postgres would round 10.083 to
 *   10.08 and say nothing, which is a figure nobody typed appearing in an account
 *   whose whole claim is that every figure can be explained.
 */
function requireDays(entryType: LedgerEntryType, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidLedgerEntry(
      'days',
      `A ledger entry moves a number of days, and ${String(value)} is not one.`,
    );
  }

  if (value === 0) {
    throw new InvalidLedgerEntry(
      'days',
      'A ledger entry of no days is not a movement. It would be a line in somebody’s ' +
        'history that explains nothing and has to be skipped by every reader of it.',
    );
  }

  const sign = ENTRY_SIGNS[entryType];

  if ((sign === 'ADDS' && value < 0) || (sign === 'CONSUMES' && value > 0)) {
    throw new InvalidLedgerEntry(
      'days',
      `A ${entryType.toLowerCase().replace('_', ' ')} ` +
        `${sign === 'ADDS' ? 'adds days to a balance' : 'takes days out of a balance'}, so ` +
        `${String(value)} is the wrong way round. A movement that goes either way is an ` +
        `adjustment, which is the only kind there is: putting right a grant of 20 days ` +
        `means −20, and that is not a grant.`,
    );
  }

  if (isARequestMovement(entryType)) {
    if (!isWholeDays(value)) {
      throw new InvalidLedgerEntry(
        'days',
        `A ${entryType.toLowerCase()} follows a leave request, and a request is a whole ` +
          `number of days. ${WHOLE_DAYS_ONLY}`,
      );
    }
  } else if (round(value) !== value) {
    /* Accrued figures may be fractional — 20 × 184/365 is 10.08 — but only to the
       two places the column holds. Refused rather than rounded, because the whole
       of §8.6d's argument for keeping the fraction is that the figure can be
       explained, and a third place silently dropped is a figure that cannot. */
    throw new InvalidLedgerEntry(
      'days',
      `${String(value)} is a number of days to more than two decimal places. An accrued ` +
        `figure is held to the hundredth of a day — a joiner on 1 July is owed 10.08 — ` +
        `and anything finer would be rounded away without saying so.`,
    );
  }

  if (Math.abs(value) > LARGEST_MOVEMENT) {
    throw new InvalidLedgerEntry(
      'days',
      `${String(value)} days is more than a ledger entry holds. The longest absence this ` +
        `system knows about is a hundred and twenty days of maternity leave, so a figure ` +
        `this size is a unit or a decimal point rather than a movement.`,
    );
  }

  return value;
}

/**
 * Why the days moved. FR 27, and the one thing only the writer knows.
 *
 * Trimmed rather than refused when it arrives padded, as every other name and note
 * in this system is. Deliberately no rule about what it may say beyond being
 * something: a reason nobody can write freely is a reason everybody writes
 * 'correction' in.
 */
function requireReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidLedgerEntry(
      'reason',
      'Every movement in a balance needs a reason. It is what somebody reads when they ' +
        'ask why they have twelve days rather than fifteen, and it is the one thing ' +
        'about an entry that nothing else in the system can work out afterwards. FR 27.',
    );
  }

  return value.trim();
}

function requireEntryType(value: unknown): LedgerEntryType {
  if (typeof value !== 'string' || !(LEDGER_ENTRY_TYPES as readonly string[]).includes(value)) {
    throw new InvalidLedgerEntry(
      'entryType',
      `${String(value)} is not a kind of movement this ledger holds. They are ` +
        `${LEDGER_ENTRY_TYPES.join(', ')}.`,
    );
  }

  const entryType = value as LedgerEntryType;
  const sign = ENTRY_SIGNS[entryType];

  /* Unreachable while the two lists agree, and asserted rather than assumed because
     they are edited in different places: a type added above without a sign beside
     it would otherwise reach the database and be refused there, one round trip and
     one unhelpful message later. */
  if (sign === undefined) {
    throw new InvalidLedgerEntry('entryType', `${entryType} has no sign rule.`);
  }

  return entryType;
}

function requireId(field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidLedgerEntry(
      field,
      `A ledger entry has to name the ${labelFor(field)} whose balance it moves.`,
    );
  }

  return value.trim();
}

function optionalId(field: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return requireId(field, value);
}

function labelFor(field: string): string {
  switch (field) {
    case 'employeeId':
      return 'employee';
    case 'leaveTypeId':
      return 'leave type';
    case 'leaveYearId':
      return 'leave year';
    default:
      return 'entry';
  }
}

/**
 * Two decimal places, which is what the column holds.
 *
 * Doubles cannot hold 10.08 exactly, so adding a run of accrued figures drifts —
 * 10.08 + 0.01 is 10.089999999999998 — and a total shown to a person has to be the
 * figure they can add up themselves. Rounding to the column's own precision after
 * each step is the smallest thing that makes that true.
 *
 * It is not a rounding of *days*, which LMS 209 refuses: no movement changes size
 * here, and a figure that needed rounding to be valid was refused by
 * {@link requireDays} before it was ever written.
 */
function round(days: number): number {
  return Math.round(days * 100) / 100;
}
