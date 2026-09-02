/**
 * The balance ledger. FR 27, §5.7, LMS 210, LMS 211, §8.6, FR 24, FR 36a, FR 32e, LMS 218, LMS 209, §8..
 */

import type { BalanceBucket } from './balance.js';
import { isWholeDays, WHOLE_DAYS_ONLY } from './whole-days.js';

/** Every kind of movement there is. §5.7.. */
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
 * The four that move days because of a leave request, rather than because of what somebody is owed. FR 24.
 */
export const REQUEST_MOVEMENTS: readonly LedgerEntryType[] = [
  'RESERVATION',
  'DEDUCTION',
  'RELEASE',
  'RECALCULATION',
];

/** Which way each kind of movement goes. §5.7. */
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

/** Which of the cached balance's columns each type moves. §5.7, LMS 211, LMS 218, LMS 210, LMS 213. */
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
  /** Signed. */
  days: number;
  /** FR 27. */
  reason: string;
  /** The entry this one puts right. */
  correctsId?: string | null;
  /** The request that caused this movement. LMS 301. */
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

/** An entry as it comes back out. */
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
   * The request that caused this, for the four in REQUEST_MOVEMENTS, and null for every other kind. LMS 301.
   */
  leaveRequestId: string | null;
  /** Who, as the writer named themselves. */
  createdBy: string;
  /** Which employee, where the writer was a person. */
  createdByEmployeeId: string | null;
  createdAt: Date;
}

/** An entry that was refused, and the field that caused it. NFR USA 03. */
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

/** The entry that puts an earlier one right. FR 27. */
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

/** The entries in the order they were written, oldest first. */
export function inOrderWritten(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.id.length - right.id.length ||
      left.id.localeCompare(right.id),
  );
}

/** Each entry with the figure it left behind it. LMS 211. */
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

/** How many days, and which way. FR 24, LMS 209, §8.6. */
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
