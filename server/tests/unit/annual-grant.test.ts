import { describe, expect, it } from 'vitest';
import {
  type AnnualGrantRun,
  daysGranted,
  decideTheGrant,
  type GrantCandidate,
  NOT_GRANTED,
  type NotGrantedBecause,
  passedOver,
  summaryOf,
  wasGranted,
} from '../../src/domain/annual-grant.js';

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

const FULL_YEAR: GrantCandidate = {
  startedOn: '2025-04-01',
  yearBeganOn: '2026-01-01',
  entitlementDays: 20,
  eligible: true,
};

function candidate(overrides: Partial<GrantCandidate> = {}): GrantCandidate {
  return { ...FULL_YEAR, ...overrides };
}

function because(overrides: Partial<GrantCandidate>): NotGrantedBecause | undefined {
  const decision = decideTheGrant(candidate(overrides));

  return wasGranted(decision) ? undefined : decision.because;
}

describe('what somebody is granted for a year', () => {
  /* The story's own criterion: the full year, at the start of the year. */
  it('is the whole figure the rule says the type is worth', () => {
    expect(decideTheGrant(FULL_YEAR)).toEqual({ days: 20 });
  });

  it('and somebody who started on the first day of the year gets the whole of it', () => {
    expect(decideTheGrant(candidate({ startedOn: '2026-01-01' }))).toEqual({ days: 20 });
  });

  /**
   * And somebody who joined after it began gets nothing here.
   *
   * FR 29 and §8.6d: they are owed a proportion, and the formula is a different story.
   * Granting them the whole figure now and correcting it later would have somebody
   * planning a year around days they were never owed — which is the failure this story
   * exists to prevent rather than a rough version of success.
   *
   * Asked before the figure is looked at, because it settles the question whatever the
   * rule says.
   */
  it('and somebody who joined in July gets none of it, and is reported', () => {
    expect(because({ startedOn: '2026-07-01' })).toBe('JOINED_AFTER_THE_YEAR_BEGAN');
    expect(because({ startedOn: '2026-07-01', entitlementDays: 25 })).toBe(
      'JOINED_AFTER_THE_YEAR_BEGAN',
    );
  });

  /* FR 05, read off the type by the caller rather than decided here — this file has no
     leave type in it and no code being compared to anything. */
  it('and somebody the type is not open to gets none of it', () => {
    expect(because({ eligible: false })).toBe('NOT_ELIGIBLE');
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
     built a lock to close. `daysToGrant` in domain/balance.ts asks it inside that lock. */
  it('and has no opinion about whether it has been granted before', () => {
    expect(Object.keys(FULL_YEAR)).not.toContain('alreadyGranted');
    expect(decideTheGrant(FULL_YEAR)).toEqual({ days: 20 });
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
          missed('JOINED_AFTER_THE_YEAR_BEGAN'),
          missed('JOINED_AFTER_THE_YEAR_BEGAN'),
          missed('NO_ENTITLEMENT_RULE'),
        ],
      }),
    );

    expect(counts.JOINED_AFTER_THE_YEAR_BEGAN).toBe(2);
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
        notGranted: [missed('JOINED_AFTER_THE_YEAR_BEGAN'), missed('ALREADY_GRANTED')],
      }),
    );

    expect(summary).toContain('2 were not granted');
    expect(summary).toContain('1 had already been granted, and were left exactly as they were.');
    expect(summary).toContain('owed a proportion rather than the whole figure. FR 29.');
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
