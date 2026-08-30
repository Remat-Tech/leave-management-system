import { describe, expect, it } from 'vitest';
import {
  available,
  BALANCE_BUCKETS,
  type BalanceBucket,
  type BalanceKey,
  committed,
  hasMoved,
  isTheSameBalance,
  type LeaveBalance,
  noMovementsYet,
  owed,
} from '../../src/domain/balance.js';
import { BUCKETS, LEDGER_ENTRY_TYPES } from '../../src/domain/ledger.js';

/**
 * The cached balance. §5.7, design principle 1. LMS 211.
 *
 * A short file for a short story, and the shortness is the point rather than a gap.
 * The arithmetic this story is about — which of the eight kinds of movement lands in
 * which of the five columns — is not in TypeScript at all: it is
 * `rebuild_one_balance_from_the_ledger()` in the cached-balance-table migration, so
 * that the cache is kept in step by the database rather than by every writer
 * remembering to. ../integration/balance.test.ts is where that half is proved, and
 * it is most of the story.
 *
 * What is left here is what a balance *means* once it has been read, and it is
 * worth having on its own because two of the three things below are the ones a
 * hurried reading gets wrong:
 *
 *   **Available subtracts.** `taken` and `pending` are positive counts of movements
 *   the ledger records as negative. A sum where a subtraction belongs is a system
 *   that credits somebody every time they ask for leave, and it would look right in
 *   every test that only ever grants days.
 *
 *   **Available can be negative.** §8.6b. Sick leave goes below nought on purpose,
 *   and a clamp at zero would hide exactly the case FR 32a exists for.
 *
 *   **Nothing here computes a balance.** There is no function that takes ledger
 *   entries and returns one, and the last test in this file is what keeps it that
 *   way: a second implementation of the projection is the drift the cache exists to
 *   be checked against.
 */

const KEY: BalanceKey = { employeeId: '1', leaveTypeId: '2', leaveYearId: '3' };

/** A balance with everything at nought, so a test can vary only what it is about. */
function balanceOf(figures: Partial<LeaveBalance> = {}): LeaveBalance {
  return { ...noMovementsYet(KEY), updatedAt: new Date('2026-03-01T09:00:00Z'), ...figures };
}

describe('what a balance adds up to', () => {
  /* §5.7's own formula, and the one figure the story is about. */
  it('is what was given, less what has been taken and what is spoken for', () => {
    const balance = balanceOf({
      entitled: 20,
      carriedOver: 5,
      adjustment: 2,
      taken: 8,
      pending: 3,
    });

    expect(owed(balance)).toBe(27);
    expect(committed(balance)).toBe(11);
    expect(available(balance)).toBe(16);
  });

  /**
   * The half a naive reading gets backwards.
   *
   * The ledger records a RESERVATION as −5 days and the cache records it as five
   * days pending. Adding where this subtracts would give somebody five more days
   * every time they asked for leave — and every test that only grants days would
   * still pass.
   */
  it('subtracts days that are spoken for, rather than adding the movement that held them', () => {
    const before = balanceOf({ entitled: 20 });
    const after = balanceOf({ entitled: 20, pending: 5 });

    expect(available(before)).toBe(20);
    expect(available(after)).toBe(15);
  });

  /* Approval does not consume days a second time. The reservation already did, and
     DEDUCTION moves them from one column to the other — which is the one place a
     balance query is most often wrong, and the reason `taken` and `pending` are
     separate columns rather than one. */
  it('is unmoved when held days become taken days', () => {
    const held = balanceOf({ entitled: 20, pending: 5 });
    const approved = balanceOf({ entitled: 20, taken: 5 });

    expect(available(held)).toBe(available(approved));
    expect(committed(held)).toBe(committed(approved));
  });

  /**
   * §8.6b, and there is no `Math.max(0, …)` anywhere in the file this exercises.
   *
   * Sick leave is exceedable with a medical certificate, so the balance goes below
   * nought and the system is supposed to say so. A figure clamped at zero is a
   * figure that has stopped explaining itself.
   */
  it('goes below nought, because sick leave does', () => {
    expect(available(balanceOf({ entitled: 12, taken: 15 }))).toBe(-3);
  });

  /**
   * §8.6d: a joiner on 1 July is owed 20 × 184/365 = 10.08 days.
   *
   * Doubles cannot hold that exactly, so the sum has to come back at the precision
   * the columns hold rather than with fourteen decimal places on the end of it. A
   * balance shown to a person has to be one they can add up themselves.
   */
  it('keeps a pro rated figure to the hundredth of a day', () => {
    const balance = balanceOf({ entitled: 10.08, carriedOver: 0.01, adjustment: 0.01 });

    expect(owed(balance)).toBe(10.1);
    expect(available(balance)).toBe(10.1);
  });

  /* Whole days out of a fractional entitlement, which is the line LMS 209 drew and
     this table draws between two columns: what somebody is owed may carry a
     fraction, what they have taken may not. */
  it('takes whole days out of a fractional entitlement', () => {
    expect(available(balanceOf({ entitled: 10.08, taken: 4, pending: 1 }))).toBe(5.08);
  });
});

describe('a balance nothing has moved yet', () => {
  it('is nought rather than an absence', () => {
    const balance = noMovementsYet(KEY);

    expect(available(balance)).toBe(0);
    expect(balance.employeeId).toBe('1');
    expect(balance.leaveTypeId).toBe('2');
    expect(balance.leaveYearId).toBe('3');
  });

  /**
   * And says so, which is the whole reason `updatedAt` is nullable.
   *
   * "Nothing has ever happened" and "a correcting adjustment moved this back to
   * nought" are the same five figures and different histories. A fabricated
   * timestamp on the first would be a claim that something happened.
   */
  it('is told apart from one that has moved back to nought', () => {
    expect(hasMoved(noMovementsYet(KEY))).toBe(false);
    expect(hasMoved(balanceOf({ entitled: 20, adjustment: -20 }))).toBe(true);
    expect(available(balanceOf({ entitled: 20, adjustment: -20 }))).toBe(0);
  });
});

describe('which balance this is', () => {
  /* All three, and the reason is that "how many days do I have" is not a question
     until all three are named: annual leave and sick leave are different balances,
     and last year's annual leave is a third. */
  it('is the employee, the leave type and the leave year together', () => {
    expect(isTheSameBalance(KEY, { ...KEY })).toBe(true);
    expect(isTheSameBalance(KEY, { ...KEY, leaveTypeId: '9' })).toBe(false);
    expect(isTheSameBalance(KEY, { ...KEY, leaveYearId: '9' })).toBe(false);
    expect(isTheSameBalance(KEY, { ...KEY, employeeId: '9' })).toBe(false);
  });
});

/**
 * The two files that have to agree about what the five columns are called.
 *
 * `BUCKETS` in domain/ledger.ts says which of them each kind of movement moves, and
 * was written by LMS 210 before this table existed. `BALANCE_BUCKETS` here says what
 * the columns are. They are edited in different files for different reasons, so a
 * name in one that the other has never heard of is a projection into a column that
 * does not exist — which the type system now catches, and which this catches from
 * the other side.
 *
 * That the *database* agrees with `BUCKETS` is ../integration/balance.test.ts, and
 * it has to be: the arithmetic is SQL, and no unit test can ask SQL anything.
 */
describe('the five columns, as the ledger names them', () => {
  it('are the five the balance has', () => {
    const projected = new Set<BalanceBucket>(LEDGER_ENTRY_TYPES.flatMap((type) => BUCKETS[type]));

    expect([...projected].sort()).toEqual([...BALANCE_BUCKETS].sort());
  });

  /* Every kind of movement lands somewhere. A type with no bucket would be days
     moving in the ledger and nothing moving in the balance — the drift this table
     exists not to have. */
  it('and every kind of movement lands in at least one of them', () => {
    for (const type of LEDGER_ENTRY_TYPES) {
      expect(BUCKETS[type].length, type).toBeGreaterThan(0);
    }
  });

  /**
   * And the arithmetic is somewhere else, which this asserts by absence.
   *
   * The temptation this story creates is a `balanceFrom(entries)` here — it would be
   * twenty lines, it would be testable without a database, and it would be a second
   * implementation of the sum the trigger performs. Two implementations of one
   * projection is the drift the cache exists to be checked against, which the
   * immutable-leave-ledger migration said in the sentence that declined to write the
   * first one.
   *
   * So the domain exports nothing that takes a ledger entry. If that changes, this
   * fails, and whoever changed it has to argue here.
   */
  it('and nothing in the domain turns movements into a balance', async () => {
    const balance: Record<string, unknown> = await import('../../src/domain/balance.js');

    expect(Object.keys(balance).sort()).toEqual([
      'BALANCE_BUCKETS',
      'available',
      'committed',
      'hasMoved',
      'isTheSameBalance',
      'noMovementsYet',
      'owed',
    ]);
  });
});
