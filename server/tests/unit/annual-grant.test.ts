import { describe, expect, it } from 'vitest';
import {
  type AnnualGrantRun,
  daysGranted,
  decideTheGrant,
  type GrantCandidate,
  NOT_GRANTED,
  type NotGrantedBecause,
  passedOver,
  reasonFor,
  summaryOf,
  wasGranted,
} from '../../src/features/entitlement/annual-grant.js';
import {
  BY_COMPLETED_TWELFTHS,
  type ProRataRule,
} from '../../src/features/entitlement/pro-rata.js';

/**
 * The annual grant of entitlement. FR 30. LMS 214.
 *
 * The whole rule is a pure function, so this is where the story is proved. The
 * integration suite beside it — ../integration/annual-grant.test.ts — covers the two
 * things arithmetic cannot: that the grant lands as a ledger entry the cache follows,
 * and that running the job twice does not grant the year twice.
 *
 * Nearly every test below is about a *refusal*, and that is the shape of this story
 * rather than a bias in the file. Granting twenty days to somebody who is owed twenty
 * days is the easy half. The four ways somebody is not granted are where a run goes
 * quietly wrong, and three of them look identical from a balance screen — nought days,
 * no explanation.
 */

const YEAR = { startsOn: '2026-01-01', endsOn: '2026-12-31' };

const FULL_YEAR: GrantCandidate = {
  year: YEAR,
  employment: { startedOn: '2025-04-01', leftOn: null },
  entitlementDays: 20,
  proRateAPartYear: true,
  eligible: true,
};

function candidate(overrides: Partial<GrantCandidate> = {}): GrantCandidate {
  return { ...FULL_YEAR, ...overrides };
}

function because(overrides: Partial<GrantCandidate>): NotGrantedBecause | undefined {
  const decision = decideTheGrant(candidate(overrides));

  return wasGranted(decision) ? undefined : decision.because;
}

function granted(one: GrantCandidate): number | undefined {
  const decision = decideTheGrant(one);

  return wasGranted(decision) ? decision.days : undefined;
}

function proRatedBy(one: GrantCandidate): ProRataRule | null | undefined {
  const decision = decideTheGrant(one);

  return wasGranted(decision) ? decision.proRatedBy : undefined;
}

/** The hundredth of a day the ledger's column holds, so a test can state the sum. */
function round(days: number): number {
  return Math.round(days * 100) / 100;
}

describe('what somebody is granted for a year', () => {
  /* The story's own criterion: the full year, at the start of the year. */
  it('is the whole figure the rule says the type is worth', () => {
    expect(granted(FULL_YEAR)).toBe(20);
    expect(proRatedBy(FULL_YEAR)).toBeNull();
  });

  it('and somebody who started on the first day of the year gets the whole of it', () => {
    expect(granted(candidate({ employment: { startedOn: '2026-01-01', leftOn: null } }))).toBe(20);
  });

  /**
   * And somebody who joined in July gets §8.6d's worked example. FR 29, LMS 215.
   *
   * 20 × 184/365 = 10.08 days, which is the figure the Technical Design Document quotes
   * and the reason this build's rule in force is the calendar day one. The entry says
   * which rule produced it, which is what makes the figure correctable when LMS 013
   * settles the formula.
   */
  it('and somebody who joined in July gets the proportion of it they worked', () => {
    const july = candidate({ employment: { startedOn: '2026-07-01', leftOn: null } });

    expect(granted(july)).toBe(10.08);
    expect(proRatedBy(july)?.name).toBe('calendar-days');
  });

  /* FR 29a, the same call with the other end moved in. Nothing in the decision knows
     which of the two it is looking at, which is the second acceptance criterion. */
  it('and somebody who left in March gets the proportion of it they worked', () => {
    const march = candidate({ employment: { startedOn: '2020-01-01', leftOn: '2026-03-31' } });

    expect(granted(march)).toBe(round((20 * 90) / 365));
  });

  it('and somebody who joined and left inside one year gets the part in between', () => {
    const both = candidate({ employment: { startedOn: '2026-04-01', leftOn: '2026-06-30' } });

    expect(granted(both)).toBe(round((20 * 91) / 365));
  });

  /**
   * And a type nobody pro rates gives the whole figure whatever the dates say.
   *
   * `leave_entitlement_rule.prorate_on_join`, FR 29. The three days of sick leave are
   * not accrued, so a joiner in December gets all three — and the entry carries no rule
   * name, because no rule was asked.
   */
  it('and a type nobody pro rates gives the whole figure to a December joiner', () => {
    const december = candidate({
      employment: { startedOn: '2026-12-01', leftOn: null },
      entitlementDays: 3,
      proRateAPartYear: false,
    });

    expect(granted(december)).toBe(3);
    expect(proRatedBy(december)).toBeNull();
  });

  /* Somebody who was not here at any point in the year is a different answer from
     somebody who was here for a day: there is nothing to grant rather than nothing
     granted. */
  it('and somebody not employed in the year at all is passed over', () => {
    expect(because({ employment: { startedOn: '2027-01-01', leftOn: null } })).toBe(
      'NOT_EMPLOYED_IN_THE_YEAR',
    );
    expect(because({ employment: { startedOn: '2020-01-01', leftOn: '2025-12-31' } })).toBe(
      'NOT_EMPLOYED_IN_THE_YEAR',
    );
  });

  /**
   * A proportion so small it rounds to nothing is reported rather than posted.
   *
   * A ledger entry of no days is not a movement, so there is nothing to write down. It
   * takes a one day entitlement and a one day portion to get there, which is the point:
   * the branch exists because the ledger would otherwise refuse the entry, and the
   * refusal would arrive as an error in a job rather than a line in a report.
   */
  it('and a proportion that rounds to nothing is not granted', () => {
    expect(
      because({
        employment: { startedOn: '2026-12-31', leftOn: null },
        entitlementDays: 1,
      }),
    ).toBe('WORTH_NOTHING');
  });

  /* And one that rounds to a hundredth of a day *is* granted, because that is what the
     formula says they are owed. Rounding it away would be taking something; rounding it
     up to a day would be giving. §8.6d quotes its own example to the hundredth. */
  it('and a proportion of a hundredth of a day is still a grant', () => {
    expect(
      granted(
        candidate({ employment: { startedOn: '2026-12-31', leftOn: null }, entitlementDays: 3 }),
      ),
    ).toBe(0.01);
  });

  /**
   * And the formula is swappable, which is the first acceptance criterion.
   *
   * The same candidate under the candidate rule gives ten days rather than 10.08, and
   * the decision says which one it used. When LMS 013 answers, that is the whole of the
   * change.
   */
  it('and the same July joiner under a different rule gets a different figure', () => {
    const july = candidate({ employment: { startedOn: '2026-07-01', leftOn: null } });
    const decision = decideTheGrant(july, BY_COMPLETED_TWELFTHS);

    expect(wasGranted(decision) && decision.days).toBe(10);
    expect(wasGranted(decision) && decision.proRatedBy?.name).toBe('completed-twelfths');
  });

  /* FR 05, read off the type by the caller rather than decided here — this file has no
     leave type in it and no code being compared to anything. */
  it('and somebody the type is not open to gets none of it', () => {
    expect(because({ eligible: false })).toBe('NOT_ELIGIBLE');
  });

  /* The reason on the entry carries the rule name, which is the third criterion. A full
     year says nothing about a rule, because none was asked. */
  it('and the reason names the rule and the part of the year it covered', () => {
    const july = decideTheGrant(
      candidate({ employment: { startedOn: '2026-07-01', leftOn: null } }),
    );
    const whole = decideTheGrant(FULL_YEAR);

    expect(wasGranted(july) && reasonFor('Annual Leave', '2026', july)).toBe(
      'Annual Leave entitlement for 2026, pro rated for 2026-07-01 to 2026-12-31 by the calendar-days rule',
    );
    expect(wasGranted(whole) && reasonFor('Annual Leave', '2026', whole)).toBe(
      'Annual Leave entitlement for 2026',
    );
  });

  /**
   * Two ways of having no figure, told apart on purpose.
   *
   * Unpaid leave has no entitlement rule at all, deliberately: FR 32h is agreed
   * occasion by occasion. A rule of *nought* days is HR having said this is worth
   * nothing to this person. Both grant nothing, and they are different conversations —
   * one is "ask HR to write a rule", the other is "HR already answered".
   */
  it('and tells having no rule apart from a rule saying nothing', () => {
    expect(because({ entitlementDays: undefined })).toBe('NO_ENTITLEMENT_RULE');
    expect(because({ entitlementDays: 0 })).toBe('WORTH_NOTHING');
  });

  /* A ledger entry of no days is not a movement, so a grant of nought is refused here
     rather than posted and skipped by every reader of that history forever. */
  it('and never grants a movement of no days', () => {
    for (const days of [0, -5]) {
      expect(wasGranted(decideTheGrant(candidate({ entitlementDays: days })))).toBe(false);
    }
  });

  /* Whether a year has already been granted is deliberately not asked here: a pure
     function would be asking it a moment before the write, which is the window LMS 212
     built a lock to close. `daysToGrant` in features/balance/balance.ts asks it inside that lock. */
  it('and has no opinion about whether it has been granted before', () => {
    expect(Object.keys(FULL_YEAR)).not.toContain('alreadyGranted');
    expect(granted(FULL_YEAR)).toBe(20);
  });
});

describe('what a run reports', () => {
  function run(overrides: Partial<AnnualGrantRun> = {}): AnnualGrantRun {
    return {
      leaveYearId: '1',
      leaveYearLabel: '2026',
      grantedAt: new Date('2026-01-01T02:00:00Z'),
      granted: [],
      notGranted: [],
      ...overrides,
    };
  }

  const granted = (days: number) => ({
    employeeId: '1',
    employeeNumber: 'RH-0001',
    leaveTypeId: '1',
    leaveTypeName: 'Annual Leave',
    days,
    entryId: '1',
  });

  const missed = (reason: NotGrantedBecause) => ({
    employeeId: '2',
    employeeNumber: 'RH-0002',
    leaveTypeId: '1',
    leaveTypeName: 'Annual Leave',
    because: reason,
  });

  it('adds up the days it put into balances', () => {
    expect(daysGranted(run({ granted: [granted(20), granted(10.08)] }))).toBe(30.08);
  });

  it('and counts what it passed over, by reason', () => {
    const counts = passedOver(
      run({
        notGranted: [
          missed('NOT_EMPLOYED_IN_THE_YEAR'),
          missed('NOT_EMPLOYED_IN_THE_YEAR'),
          missed('NO_ENTITLEMENT_RULE'),
        ],
      }),
    );

    expect(counts.NOT_EMPLOYED_IN_THE_YEAR).toBe(2);
    expect(counts.NO_ENTITLEMENT_RULE).toBe(1);
    expect(counts.ALREADY_GRANTED).toBe(0);
  });

  it('and says plainly what it did', () => {
    const summary = summaryOf(run({ granted: [granted(20), granted(20)] }));

    expect(summary).toContain('Annual entitlement for 2026');
    expect(summary).toContain('2 grants posted, 40 days in total');
  });

  /**
   * And why anybody was left out, in words that say what to do about it.
   *
   * "The grant ran and Ama has nothing" is a support call either way. Whether it is a
   * two minute answer or an afternoon is entirely whether the run said why.
   */
  it('and why anybody was left out', () => {
    const summary = summaryOf(
      run({
        granted: [granted(20)],
        notGranted: [missed('NOT_EMPLOYED_IN_THE_YEAR'), missed('ALREADY_GRANTED')],
      }),
    );

    expect(summary).toContain('2 were not granted');
    expect(summary).toContain('1 had already been granted, and were left exactly as they were.');
    expect(summary).toContain('were not employed at any point in this leave year.');
  });

  /* A clean run says nothing about reasons rather than listing five noughts, because a
     report is read by somebody deciding whether they have to do anything. */
  it('and says nothing about reasons when nobody was left out', () => {
    expect(summaryOf(run({ granted: [granted(20)] }))).not.toContain('were not granted');
  });

  /* Every reason has a sentence. A reason added without one would print as a bare code
     in the middle of a report, which is the sort of thing nobody notices until January. */
  it('and has a sentence for every reason there is', () => {
    const summary = summaryOf(run({ notGranted: NOT_GRANTED.map(missed) }));

    for (const reason of NOT_GRANTED) {
      expect(summary, reason).not.toContain(reason);
    }
    expect(summary.split('\n').filter((line) => line.startsWith('  '))).toHaveLength(
      NOT_GRANTED.length,
    );
  });
});
