import { describe, expect, it } from 'vitest';
import type { AnnualGrantRun } from '../../src/domain/annual-grant.js';
import { AlreadyCarried, daysToCarry } from '../../src/domain/balance.js';
import {
  type Carried,
  type CarryCandidate,
  type NotCarried,
  daysCapped,
  daysCarried,
  decideTheCarry,
  needsAttention,
  NOT_CARRIED,
  type NotCarriedBecause,
  notCarriedCounts,
  reasonForCarry,
  summaryOf,
  wasCarried,
  type YearRolloverRun,
} from '../../src/domain/year-rollover.js';

/**
 * The year rollover. FR 36, FR 36a, §11. LMS 217.
 *
 * What carries and what does not is a pure function, so this is where three of the
 * story's five criteria are proved: carry over is uncapped, sick leave does not carry,
 * and — by the shape of the candidate rather than by a branch — neither does anything
 * else HR has said no to.
 *
 * The other two are ../integration/year-rollover.test.ts's, because they are claims about
 * a database rather than about arithmetic: that the three acts happen in the right order
 * against real rows, and that running the whole thing twice changes nothing.
 *
 * **Not one test below mentions a leave type by code**, and that is the fourth criterion
 * held by design rather than asserted. {@link decideTheCarry} reads `carriesOver` off the
 * entitlement rule and has no idea which type it belongs to; event based types never
 * reach it at all, because the job filters them out on `hasRunningBalance` before a
 * candidate is built.
 */

const CARRIES: CarryCandidate = {
  available: 4,
  carriesOver: true,
  carryoverMaxDays: null,
};

function candidate(overrides: Partial<CarryCandidate> = {}): CarryCandidate {
  return { ...CARRIES, ...overrides };
}

function because(overrides: Partial<CarryCandidate>): NotCarriedBecause | undefined {
  const decision = decideTheCarry(candidate(overrides));

  return wasCarried(decision) ? undefined : decision.because;
}

function carried(overrides: Partial<CarryCandidate> = {}): number | undefined {
  const decision = decideTheCarry(candidate(overrides));

  return wasCarried(decision) ? decision.days : undefined;
}

function cappedFrom(overrides: Partial<CarryCandidate> = {}): number | null | undefined {
  const decision = decideTheCarry(candidate(overrides));

  return wasCarried(decision) ? decision.cappedFrom : undefined;
}

/* ------------------------------------------------------- what crosses the boundary */

describe('what is left of a year is what carries into the next one', () => {
  /* The story, in one line: leave somebody did not get to take is not lost on the
     first of January. */
  it('carries every unused day, and says nothing was capped', () => {
    expect(carried()).toBe(4);
    expect(cappedFrom()).toBeNull();
  });

  /**
   * Uncapped, which is the story's second criterion.
   *
   * There is no ceiling anywhere in this function that a caller has not asked for.
   * Somebody who took none of their twenty days carries all twenty — which is a thing
   * HR may well want to cap one day, and the way to cap it is a column rather than a
   * number appearing here.
   */
  it('and a whole unused year carries whole, because nothing caps it', () => {
    expect(carried({ available: 20 })).toBe(20);
    expect(carried({ available: 365 })).toBe(365);
  });

  /* §8.6d. What somebody has accrued is divisible even though what they may ask for is
     not, so a pro rated joiner's remainder crosses the boundary as it stands rather
     than being rounded to something tidier. */
  it('and a part year’s remainder keeps its hundredths', () => {
    expect(carried({ available: 5.08 })).toBe(5.08);
  });
});

/* ------------------------------------------------------------- what does not carry */

describe('what does not carry, and why each is said out loud', () => {
  /**
   * The story's third criterion, and there is no mention of sick leave in it.
   *
   * `carriesOver` is false on the statutory sick figure, so this is the whole of "sick
   * leave does not carry" — one column, read once. A `code === 'SICK'` anywhere above
   * the database is the bug the entitlement table exists to prevent.
   */
  it('a type whose rule says unused days do not roll over', () => {
    expect(because({ carriesOver: false })).toBe('DOES_NOT_CARRY');
  });

  /* And it is decided before the arithmetic, so a full balance of a type that does not
     carry is still refused for the right reason rather than for a lucky one. */
  it('however many days are left of it', () => {
    expect(because({ carriesOver: false, available: 20 })).toBe('DOES_NOT_CARRY');
    expect(because({ carriesOver: false, available: 0 })).toBe('DOES_NOT_CARRY');
  });

  /**
   * Nobody having said is not the same as HR having said no.
   *
   * Unpaid leave has no entitlement rule at all, deliberately — FR 32h is agreed
   * occasion by occasion. Reported apart from `DOES_NOT_CARRY` because they are
   * different conversations: one is the policy working, the other is a policy nobody
   * has written.
   */
  it('a type nobody has written a rule for', () => {
    expect(because({ carriesOver: undefined })).toBe('NO_ENTITLEMENT_RULE');
  });

  it('and a balance with nothing left in it', () => {
    expect(because({ available: 0 })).toBe('NOTHING_LEFT');
  });

  /**
   * And a balance in arrears, which is the one line of a rollover somebody has to act
   * on.
   *
   * Carrying a debt would post a `CARRY_FORWARD` of negative days, which the ledger
   * refuses because a carry forward adds. Carrying nothing and saying nothing would
   * write the debt off on the first of January, quietly, which is the same failure as
   * losing somebody's unused days pointed the other way.
   */
  it('and a balance that is overdrawn, which is neither carried nor forgiven', () => {
    expect(because({ available: -3 })).toBe('IN_ARREARS');
    expect(because({ available: -0.5 })).toBe('IN_ARREARS');
  });

  /* Each of the five is a different thing to do about it, so the list is closed and the
     report can be counted by it. */
  it('and every reason a run can give is one of the five', () => {
    const reasons: NotCarriedBecause[] = [
      because({ carriesOver: false })!,
      because({ carriesOver: undefined })!,
      because({ available: 0 })!,
      because({ available: -1 })!,
    ];

    for (const reason of reasons) {
      expect(NOT_CARRIED).toContain(reason);
    }
  });
});

/* ------------------------------------------------------------------- FR 36a’s cap */

describe('a cap, where HR has set one', () => {
  /**
   * Nothing this company runs on sets one, and the code honours it anyway.
   *
   * The same argument `unit/pro-rata.test.ts` makes about a rule that is not in force:
   * a column nothing reads is a setting that lies to whoever fills it in, and a test
   * that exercises it is what stops it quietly ceasing to work.
   */
  it('takes only as much as the cap allows, and says what it took it from', () => {
    expect(carried({ available: 12, carryoverMaxDays: 5 })).toBe(5);
    expect(cappedFrom({ available: 12, carryoverMaxDays: 5 })).toBe(12);
  });

  it('and does not bite where there is less left than the cap', () => {
    expect(carried({ available: 3, carryoverMaxDays: 5 })).toBe(3);
    expect(cappedFrom({ available: 3, carryoverMaxDays: 5 })).toBeNull();
  });

  /* Exactly the cap is not capped. The distinction matters because `cappedFrom` is what
     a report shows somebody as days they lost to a policy, and losing nought days is
     not a sentence anybody should read. */
  it('nor where there is exactly the cap left', () => {
    expect(carried({ available: 5, carryoverMaxDays: 5 })).toBe(5);
    expect(cappedFrom({ available: 5, carryoverMaxDays: 5 })).toBeNull();
  });
});

/* ------------------------------------------------------- what the ledger entry says */

describe('the reason on a carried entry', () => {
  /* FR 27. "3 days" in a January balance explains nothing; the year it came from
     explains all of it without anybody opening another screen. */
  it('names both years, so the days can be traced to where they came from', () => {
    expect(reasonForCarry('Annual Leave', '2026', '2027', { days: 4, cappedFrom: null })).toBe(
      'Unused Annual Leave from 2026 carried into 2027',
    );
  });

  it('and says so where a cap took some away', () => {
    expect(reasonForCarry('Annual Leave', '2026', '2027', { days: 5, cappedFrom: 12 })).toBe(
      'Unused Annual Leave from 2026 carried into 2027, capped at 5 of 12 days. FR 36a',
    );
  });
});

/* --------------------------------------------------------- carried once, and once only */

describe('a balance is carried into once', () => {
  /**
   * The story's fifth criterion, as arithmetic. The other half of it is the lock, and
   * that is the integration suite's.
   *
   * The same shape `daysToGrant` has, deliberately: a rollover is three acts and every
   * one of them has to be safe to repeat, so they are safe in the same way rather than
   * in three ways somebody has to check separately.
   */
  it('and a second carry is refused rather than doubling the figure', () => {
    expect(daysToCarry(4, 0)).toBe(4);
    expect(() => daysToCarry(4, 1)).toThrow(AlreadyCarried);
    expect(() => daysToCarry(4, 3)).toThrow(/3 times/);
  });

  /* The refusal says what to do instead, because "you cannot do that" with no second
     sentence is how somebody ends up writing a figure straight into the table. */
  it('and says the fix is an adjustment with a reason on it', () => {
    expect(() => daysToCarry(4, 1)).toThrow(/adjustment with a reason/);
  });

  /* A debt and an empty balance are both refused here as well as by `decideTheCarry`,
     for a caller that did not ask. The ledger refuses them too — a CARRY_FORWARD adds —
     so this is the message rather than the guarantee. */
  it('and neither nothing nor a debt is a carry', () => {
    expect(() => daysToCarry(0, 0)).toThrow(/not one/);
    expect(() => daysToCarry(-3, 0)).toThrow(/not written off on the first of January/);
  });
});

/* --------------------------------------------------------------------- what a run says */

describe('the report a run produces', () => {
  const NOTHING_GRANTED: AnnualGrantRun = {
    leaveYearId: '2',
    leaveYearLabel: '2027',
    grantedAt: new Date('2027-01-01T02:00:00Z'),
    granted: [],
    notGranted: [],
  };

  function carriedRow(overrides: Partial<Carried> = {}): Carried {
    return {
      employeeId: '11',
      employeeNumber: 'RH-0011',
      leaveTypeId: '1',
      leaveTypeName: 'Annual Leave',
      days: 4,
      cappedFrom: null,
      entryId: '41',
      ...overrides,
    };
  }

  function notCarriedRow(because: NotCarriedBecause): NotCarried {
    return {
      employeeId: '11',
      employeeNumber: 'RH-0011',
      leaveTypeId: '1',
      leaveTypeName: 'Annual Leave',
      because,
    };
  }

  function run(overrides: Partial<YearRolloverRun> = {}): YearRolloverRun {
    return {
      fromLeaveYearId: '1',
      fromLeaveYearLabel: '2026',
      intoLeaveYearId: '2',
      intoLeaveYearLabel: '2027',
      ranAt: new Date('2027-01-01T02:00:00Z'),
      closed: 'CLOSED_BY_THIS_RUN',
      carried: [],
      notCarried: [],
      unsettled: [],
      grant: NOTHING_GRANTED,
      ...overrides,
    };
  }

  it('adds up the days that crossed the boundary', () => {
    expect(daysCarried(run({ carried: [carriedRow(), carriedRow({ days: 5.08 })] }))).toBe(9.08);
  });

  /* Nought on this company's figures, and the figure a report has to be able to state
     the day somebody sets a cap. */
  it('and the days lost to a cap, which is nought where nothing is capped', () => {
    expect(daysCapped(run({ carried: [carriedRow()] }))).toBe(0);
    expect(daysCapped(run({ carried: [carriedRow({ days: 5, cappedFrom: 12 })] }))).toBe(7);
  });

  it('and counts what was passed over, by reason', () => {
    const counted = notCarriedCounts(
      run({
        notCarried: [
          notCarriedRow('DOES_NOT_CARRY'),
          notCarriedRow('DOES_NOT_CARRY'),
          notCarriedRow('NOTHING_LEFT'),
        ],
      }),
    );

    expect(counted.DOES_NOT_CARRY).toBe(2);
    expect(counted.NOTHING_LEFT).toBe(1);
    expect(counted.IN_ARREARS).toBe(0);
  });

  /**
   * And says whether a person has to look at it.
   *
   * An ordinary rollover needs nobody: it is the first of January and this was always
   * going to happen. Two things are not ordinary — a balance somebody has overdrawn,
   * and days still held for a request that can now never be approved — and both are
   * losses that would otherwise be invisible.
   */
  it('and a plain rollover needs nobody to look at it', () => {
    expect(needsAttention(run({ carried: [carriedRow()] }))).toBe(false);
  });

  it('but a balance in arrears does', () => {
    expect(
      needsAttention(
        run({
          notCarried: [
            {
              employeeId: '11',
              employeeNumber: 'RH-0011',
              leaveTypeId: '1',
              leaveTypeName: 'Annual Leave',
              because: 'IN_ARREARS',
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it('and so does a request left pending in a year that has closed', () => {
    expect(
      needsAttention(
        run({
          unsettled: [
            {
              employeeId: '11',
              employeeNumber: 'RH-0011',
              leaveTypeId: '1',
              leaveTypeName: 'Annual Leave',
              pending: 5,
            },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe('the summary somebody reads after a run', () => {
  const GRANT: AnnualGrantRun = {
    leaveYearId: '2',
    leaveYearLabel: '2027',
    grantedAt: new Date('2027-01-01T02:00:00Z'),
    granted: [],
    notGranted: [],
  };

  const RAN: YearRolloverRun = {
    fromLeaveYearId: '1',
    fromLeaveYearLabel: '2026',
    intoLeaveYearId: '2',
    intoLeaveYearLabel: '2027',
    ranAt: new Date('2027-01-01T02:00:00Z'),
    closed: 'CLOSED_BY_THIS_RUN',
    carried: [
      {
        employeeId: '11',
        employeeNumber: 'RH-0011',
        leaveTypeId: '1',
        leaveTypeName: 'Annual Leave',
        days: 4,
        cappedFrom: null,
        entryId: '41',
      },
    ],
    notCarried: [
      {
        employeeId: '11',
        employeeNumber: 'RH-0011',
        leaveTypeId: '2',
        leaveTypeName: 'Sick Leave',
        because: 'DOES_NOT_CARRY',
      },
    ],
    unsettled: [],
    grant: GRANT,
  };

  it('names both years and which way round they go', () => {
    expect(summaryOf(RAN)).toContain('2026 into 2027');
  });

  it('and says whether this run closed the year or found it closed', () => {
    expect(summaryOf(RAN)).toContain('2026 was closed by this run');
    expect(summaryOf({ ...RAN, closed: 'ALREADY_CLOSED' })).toContain('was already closed');
  });

  it('and what carried, and what did not and why', () => {
    const said = summaryOf(RAN);

    expect(said).toContain('1 balances carried forward, 4 days in total.');
    expect(said).toContain('1 carried nothing:');
    expect(said).toContain('do not carry over. FR 36.');
  });

  /* The grant's own summary is nested rather than restated, so there is one rendering of
     a grant run rather than two that can drift. */
  it('and carries the grant’s own summary rather than restating it', () => {
    expect(summaryOf(RAN)).toContain('Annual entitlement for 2027');
  });

  /* The two things somebody has to act on are said in the report rather than left to be
     counted out of a list. */
  it('and names days held in a year that has closed', () => {
    const said = summaryOf({
      ...RAN,
      unsettled: [
        {
          employeeId: '11',
          employeeNumber: 'RH-0011',
          leaveTypeId: '1',
          leaveTypeName: 'Annual Leave',
          pending: 5,
        },
      ],
    });

    expect(said).toContain('never decided');
    expect(said).toContain('release or adjust them');
  });

  it('and days lost to a cap, where any were', () => {
    const said = summaryOf({
      ...RAN,
      carried: [{ ...RAN.carried[0], days: 5, cappedFrom: 12 }],
    });

    expect(said).toContain('7 days lost to a carry over cap. FR 36a.');
  });
});
