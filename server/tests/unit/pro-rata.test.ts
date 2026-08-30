import { describe, expect, it } from 'vitest';
import {
  BY_CALENDAR_DAYS,
  BY_COMPLETED_TWELFTHS,
  coversTheWholeYear,
  employedPortionOf,
  PRO_RATA_RULES,
  proRataDaysFor,
  ruleNamed,
  THE_RULE_IN_FORCE,
} from '../../src/domain/pro-rata.js';

/**
 * Pro rating an entitlement for part of a year. FR 29, FR 29a, §8.6d. LMS 215.
 *
 * The formula is arithmetic on two dates, so this is the whole of the story bar the
 * posting. ../integration/annual-grant.test.ts is where the figure becomes a `GRANT`
 * carrying the rule's name.
 *
 * **This story is blocked on LMS 013**, and every test below is written knowing it.
 * The rule in force is §8.6d's, which is the only formula this build has been given in
 * writing and the only one with a worked example against it — and it is a default
 * rather than a decision. So the suite proves two different things and keeps them
 * apart: that the calendar day formula is right, which will outlive the block either
 * way, and that swapping the rule works, which is what the block is being survived
 * with.
 */

const YEAR = { startsOn: '2026-01-01', endsOn: '2026-12-31' };

/* 2028 is a leap year, which is worth having because the formula divides by the length
   of the year rather than by 365. */
const LEAP = { startsOn: '2028-01-01', endsOn: '2028-12-31' };

/** An April to March leave year, which §5.4 allows and this company does not use. */
const APRIL = { startsOn: '2026-04-01', endsOn: '2027-03-31' };

describe('the part of a year somebody was employed for', () => {
  it('is the whole of it for somebody who was here throughout', () => {
    const portion = employedPortionOf(YEAR, { startedOn: '2020-01-01', leftOn: null })!;

    expect(portion).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(coversTheWholeYear(YEAR, portion)).toBe(true);
  });

  /* FR 29, the joining end. */
  it('and starts on their first day where they joined inside it', () => {
    expect(employedPortionOf(YEAR, { startedOn: '2026-07-01', leftOn: null })).toEqual({
      from: '2026-07-01',
      to: '2026-12-31',
    });
  });

  /**
   * And ends on their last, where they left inside it. FR 29a.
   *
   * The second acceptance criterion in one function: nothing here knows whether it is
   * looking at a joiner or a leaver. Both are the same clipping of an employment to a
   * year, and somebody who did both moves both ends.
   */
  it('and ends on their last day where they left inside it', () => {
    expect(employedPortionOf(YEAR, { startedOn: '2020-01-01', leftOn: '2026-03-31' })).toEqual({
      from: '2026-01-01',
      to: '2026-03-31',
    });

    expect(employedPortionOf(YEAR, { startedOn: '2026-04-01', leftOn: '2026-06-30' })).toEqual({
      from: '2026-04-01',
      to: '2026-06-30',
    });
  });

  /* Nothing to grant, which is different from granting nothing: somebody recorded
     before they start, or a year they had already left before. */
  it('and is nothing at all where the employment and the year do not overlap', () => {
    expect(employedPortionOf(YEAR, { startedOn: '2027-01-01', leftOn: null })).toBeUndefined();
    expect(
      employedPortionOf(YEAR, { startedOn: '2020-01-01', leftOn: '2025-12-31' }),
    ).toBeUndefined();
  });

  /* Both ends are inclusive, so somebody who joined and left on the same day was
     employed for a day rather than for none. */
  it('and is one day for somebody who joined and left on the same day', () => {
    const portion = employedPortionOf(YEAR, { startedOn: '2026-06-01', leftOn: '2026-06-01' })!;

    expect(portion).toEqual({ from: '2026-06-01', to: '2026-06-01' });
    expect(coversTheWholeYear(YEAR, portion)).toBe(false);
  });

  /* An employment starting before the year and ending after it covers the whole of it,
     which is the case that makes `coversTheWholeYear` a comparison rather than an
     equality. */
  it('and covers the whole year for an employment wider than it', () => {
    expect(coversTheWholeYear(YEAR, { from: '2025-01-01', to: '2027-12-31' })).toBe(true);
  });
});

describe('the calendar day rule, which is the one in force', () => {
  const daysFor = (from: string, to: string, fullYearDays = 20, year = YEAR) =>
    proRataDaysFor({ fullYearDays, year, portion: { from, to } }, BY_CALENDAR_DAYS);

  /**
   * §8.6d's own worked example, and the reason this rule is the default.
   *
   * "A joiner on 1 July is owed 20 × 184/365 = 10.08 days." It is quoted in four files
   * in this build and this is the one place it is executed.
   */
  it('gives a joiner on 1 July 20 × 184/365 = 10.08 days', () => {
    expect(daysFor('2026-07-01', '2026-12-31')).toBe(10.08);
  });

  it('and a whole year the whole figure', () => {
    expect(daysFor('2026-01-01', '2026-12-31')).toBe(20);
  });

  it('and half a year about half of it', () => {
    expect(daysFor('2026-01-01', '2026-06-30')).toBe(9.92);
    expect(daysFor('2026-01-01', '2026-06-30') + daysFor('2026-07-01', '2026-12-31')).toBe(20);
  });

  /* The divisor is the length of the year rather than 365, so a leap year is 366 and
     everybody in it is owed very slightly less per day. Hard coding 365 would be a
     figure that is wrong one year in four and right the year anybody checked it. */
  it('and divides by the length of the year, which is not always 365', () => {
    expect(daysFor('2028-01-01', '2028-12-31', 20, LEAP)).toBe(20);
    expect(daysFor('2028-07-01', '2028-12-31', 20, LEAP)).toBe(10.05);
  });

  /* §5.4 lets a leave year run April to March, and the rule asks the year how long it
     is rather than assuming January. */
  it('and works on a leave year that does not start in January', () => {
    expect(daysFor('2026-04-01', '2027-03-31', 20, APRIL)).toBe(20);
    /* 1 October to 31 March is 182 of the year's 365 days: 20 × 182/365 = 9.97. Two
       days shorter than the January year's second half, and a rule that assumed a
       January start would have said 9.92 without anybody noticing. */
    expect(daysFor('2026-10-01', '2027-03-31', 20, APRIL)).toBe(9.97);
  });

  /**
   * And rounds to the hundredth of a day, which is what the ledger's column holds.
   *
   * The one place in this system where rounding a number of days is right rather than
   * refused: FR 24's whole days govern what somebody may *request*, and §8.6d is
   * explicit that entitlement is held differently. A third decimal place would be
   * refused by `validateNewLedgerEntry`, which is the right refusal in the wrong place.
   */
  it('and rounds to the hundredth of a day', () => {
    const days = daysFor('2026-07-01', '2026-12-31');

    expect(days).toBe(Math.round(days * 100) / 100);
    expect(daysFor('2026-12-31', '2026-12-31', 3)).toBe(0.01);
  });

  /* A leave year of no days cannot exist — the leave year rules refuse it — and
     answering rather than dividing by it means a broken row produces a nought rather
     than an Infinity somewhere downstream. */
  it('and answers nought for a year that has no days in it', () => {
    expect(
      proRataDaysFor(
        {
          fullYearDays: 20,
          year: { startsOn: '2026-12-31', endsOn: '2026-01-01' },
          portion: { from: '2026-01-01', to: '2026-12-31' },
        },
        BY_CALENDAR_DAYS,
      ),
    ).toBe(0);
  });
});

/**
 * The seam, which is the first acceptance criterion and the answer to the fourth.
 *
 * LMS 013 has not delivered the formula. What this story ships instead is a formula
 * that can be replaced in one line, with every figure already granted carrying the name
 * of the rule that made it — so the day the answer arrives, what has to be put right is
 * a query rather than an investigation.
 */
describe('swapping the rule', () => {
  it('is one line, and the rules are named', () => {
    expect(THE_RULE_IN_FORCE).toBe(BY_CALENDAR_DAYS);
    expect(PRO_RATA_RULES.map((rule) => rule.name)).toEqual([
      'calendar-days',
      'completed-twelfths',
    ]);
  });

  /* A name read back off a ledger entry granted months ago turns into the rule that
     produced it, which is what makes the entry's reason worth carrying a name. */
  it('and a name off an old entry finds the rule that made the figure', () => {
    expect(ruleNamed('calendar-days')).toBe(BY_CALENDAR_DAYS);
    expect(ruleNamed('completed-twelfths')).toBe(BY_COMPLETED_TWELFTHS);
    expect(ruleNamed('whatever-lms-013-says')).toBeUndefined();
  });

  /**
   * And the second rule gives a different answer, which is the whole reason it is here.
   *
   * A seam with one implementation is a seam nobody has tried to use.
   * {@link BY_COMPLETED_TWELFTHS} is not a recommendation and is not in force; it earns
   * its place by answering 10 where the rule in force answers 10.08, so that a test can
   * tell whether the swap did anything.
   */
  it('and the candidate rule answers differently for the same joiner', () => {
    const july = {
      fullYearDays: 20,
      year: YEAR,
      portion: { from: '2026-07-01', to: '2026-12-31' },
    };

    expect(proRataDaysFor(july, BY_CALENDAR_DAYS)).toBe(10.08);
    expect(proRataDaysFor(july, BY_COMPLETED_TWELFTHS)).toBe(10);
  });

  /* And the candidate is a whole answer rather than a sketch: a part twelfth earns
     nothing, a whole year earns everything, and nothing it returns exceeds the figure. */
  it('and the candidate rule holds at both ends', () => {
    const twelfths = (from: string, to: string) =>
      proRataDaysFor(
        { fullYearDays: 20, year: YEAR, portion: { from, to } },
        BY_COMPLETED_TWELFTHS,
      );

    expect(twelfths('2026-01-01', '2026-12-31')).toBe(20);
    expect(twelfths('2026-12-15', '2026-12-31')).toBe(0);
    expect(twelfths('2026-01-01', '2026-01-31')).toBe(1.67);
  });

  /* Every rule says what it does, in words that can go beside a figure on a screen. A
     rule with no sentence would be a name nobody outside this file could explain. */
  it('and every rule can say what it does', () => {
    for (const rule of PRO_RATA_RULES) {
      expect(rule.name, rule.name).toMatch(/^[a-z-]+$/);
      expect(rule.says.length, rule.name).toBeGreaterThan(20);
    }
  });
});
