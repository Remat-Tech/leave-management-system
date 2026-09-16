import { describe, expect, it } from 'vitest';
import {
  daysToExpire,
  type LeaveBalance,
  unusedCarriedOver,
} from '../../src/features/balance/balance.js';
import {
  carryoverDeadline,
  type CarryoverExpiryRun,
  daysExpired,
  decideTheExpiry,
  type ExpiryCandidate,
  reasonForExpiry,
  summaryOf,
} from '../../src/features/leave-year/carryover-expiry.js';

/** Carried annual leave expiring at the end of June. FR 36a. */

function balance(overrides: Partial<LeaveBalance> = {}): LeaveBalance {
  return {
    employeeId: '11',
    leaveTypeId: '1',
    leaveYearId: '2',
    entitled: 20,
    carriedOver: 8,
    adjustment: 0,
    taken: 0,
    pending: 0,
    updatedAt: new Date('2027-01-01T02:00:00Z'),
    ...overrides,
  };
}

function candidate(overrides: Partial<ExpiryCandidate> = {}): ExpiryCandidate {
  return {
    yearStartDate: '2027-01-01',
    carryoverExpiryMonth: 6,
    asAt: '2027-07-01',
    balance: balance(),
    ...overrides,
  };
}

describe('the deadline', () => {
  it('is the last day of the month, in the year the days were carried into', () => {
    expect(carryoverDeadline('2027-01-01', 6)).toBe('2027-06-30');
    expect(carryoverDeadline('2028-01-01', 2)).toBe('2028-02-29');
  });

  it('and the first such day inside a year that does not start in January', () => {
    expect(carryoverDeadline('2027-04-01', 6)).toBe('2027-06-30');
    expect(carryoverDeadline('2027-07-01', 6)).toBe('2028-06-30');
  });
});

describe('what is unused', () => {
  it('is all of it where nothing was taken or asked for', () => {
    expect(unusedCarriedOver(balance())).toBe(8);
  });

  /* Carried days are spent first, whatever the leave's dates. */
  it('is what taken and pending leave did not use', () => {
    expect(unusedCarriedOver(balance({ taken: 3 }))).toBe(5);
    expect(unusedCarriedOver(balance({ taken: 3, pending: 5 }))).toBe(0);
    expect(unusedCarriedOver(balance({ taken: 12 }))).toBe(0);
  });

  it('is never more than is available, so booked leave is not overdrawn', () => {
    expect(unusedCarriedOver(balance({ entitled: 0, adjustment: -6 }))).toBe(2);
  });

  it('keeps hundredths', () => {
    expect(unusedCarriedOver(balance({ carriedOver: 5.08, taken: 2 }))).toBe(3.08);
  });
});

describe('the decision', () => {
  it('expires what is unused once the deadline has passed', () => {
    expect(decideTheExpiry(candidate({ balance: balance({ taken: 3 }) }))).toEqual({
      days: 5,
      deadline: '2027-06-30',
    });
  });

  it('expires nothing on the deadline itself', () => {
    expect(decideTheExpiry(candidate({ asAt: '2027-06-30' }))).toEqual({
      because: 'NOT_YET',
      deadline: '2027-06-30',
    });
  });

  it('expires nothing where the rule names no month', () => {
    expect(decideTheExpiry(candidate({ carryoverExpiryMonth: null }))).toMatchObject({
      because: 'NEVER_EXPIRES',
    });
    expect(decideTheExpiry(candidate({ carryoverExpiryMonth: undefined }))).toMatchObject({
      because: 'NEVER_EXPIRES',
    });
  });

  it('and nothing where every carried day was used', () => {
    expect(decideTheExpiry(candidate({ balance: balance({ pending: 8 }) }))).toMatchObject({
      because: 'NOTHING_LEFT',
    });
  });
});

describe('an expiry', () => {
  it('is a number of days', () => {
    expect(daysToExpire(5)).toBe(5);
    expect(() => daysToExpire(0)).toThrow(/not one/);
  });
});

describe('what it says', () => {
  it('names the year and the deadline on the entry', () => {
    expect(reasonForExpiry('Annual Leave', '2027', '2027-06-30')).toBe(
      'Annual Leave carried into 2027 and not used by 2027-06-30 expired. FR 36a',
    );
  });

  it('adds up and summarises a run', () => {
    const run: CarryoverExpiryRun = {
      asAt: '2027-07-01',
      ranAt: new Date('2027-07-01T02:00:00Z'),
      expired: [
        {
          employeeId: '11',
          leaveTypeId: '1',
          leaveTypeName: 'Annual Leave',
          leaveYearLabel: '2027',
          deadline: '2027-06-30',
          days: 5,
          entryId: '41',
        },
        {
          employeeId: '12',
          leaveTypeId: '1',
          leaveTypeName: 'Annual Leave',
          leaveYearLabel: '2027',
          deadline: '2027-06-30',
          days: 2.5,
          entryId: '42',
        },
      ],
      notExpired: [],
    };

    expect(daysExpired(run)).toBe(7.5);
    expect(summaryOf(run)).toContain('2 balances had carried days expire, 7.5 days in total.');
  });
});
