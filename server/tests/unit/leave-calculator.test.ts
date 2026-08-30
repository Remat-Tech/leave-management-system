import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Holiday } from '../../src/domain/holiday.js';
import {
  costsADay,
  countLeaveDays,
  InvalidLeavePeriod,
  LeaveCountsNoDays,
  validateLeavePeriod,
} from '../../src/domain/leave-calculator.js';
import { type LeaveType, validateNewLeaveType } from '../../src/domain/leave-type.js';
import { MONDAY_TO_FRIDAY, type WorkPattern, type Weekday } from '../../src/domain/work-pattern.js';

/**
 * How many days a period of leave costs. FR 21, FR 22, §7.3. LMS 207.
 *
 * The calculator is a pure function, so this file is the whole of the story. There
 * is an integration suite beside it — ../integration/leave-calculator.test.ts —
 * and what it proves is narrower on purpose: that the service reads a real working
 * pattern and the real seeded gazette, and that a fortnight over the real Christmas
 * comes out at the number a person would get counting off a wall calendar. Every
 * rule about what a day costs is decided here.
 *
 * Four properties every test below is really about, and they are the story's own
 * criteria.
 *
 * **The branch is on the counting basis, never on the type code.** Design principle
 * 5: "If either is written as an `if` on a type code, every future leave type
 * becomes a code change." So two types that differ only in their code count
 * identically, a type with a code nobody has ever seen counts correctly, and the
 * source is asked whether it names one.
 *
 * **A working-day type skips weekends and holidays; a calendar-day type skips
 * nothing.** The same period, the same pattern, the same calendar, two numbers —
 * which is FR 22's "expressed as a continuous period of absence rather than an
 * allowance of workdays" made arithmetic.
 *
 * **Nothing at all is refused rather than returned.** Zero days is leave that
 * deducts nothing, waits in a queue for nothing and shows on a calendar as an
 * absence nobody paid for. There is no sensible thing for any caller to do with it.
 *
 * **It reads nothing.** No database, no clock, no environment. Every fact it needs
 * is an argument, and the two that come from tables — the pattern and the calendar
 * — are built here by hand.
 */

/* Christmas 2026 and the days around it, which is the case this whole calculator
   is most often asked about and the one where every rule fires at once.

   The twenty first is a Monday. Christmas Day is the Friday, Boxing Day is the
   Saturday after it, and New Year's Day 2027 is the following Friday. So a
   fortnight off over the holidays contains a holiday that costs nothing because it
   is a holiday, and a holiday that costs nothing because it is a Saturday, and the
   difference between those two matters to FR 25. */
const CHRISTMAS_FORTNIGHT = { from: '2026-12-21', to: '2027-01-01' };

const CHRISTMAS_CALENDAR: Holiday[] = [
  holiday('1', 'Christmas Day', '2026-12-25'),
  holiday('2', 'Boxing Day', '2026-12-26'),
  holiday('3', "New Year's Day", '2027-01-01'),
];

/** The standard week, and Abena Sarpong's, who does not work Wednesdays. FR 23. */
const STANDARD = pattern('Standard Mon-Fri', MONDAY_TO_FRIDAY);
const FOUR_DAYS = pattern('Four days', [1, 2, 4, 5]);
const EVERY_DAY = pattern('Seven days', [1, 2, 3, 4, 5, 6, 7]);

/** Annual leave and maternity leave, which differ in the one field that matters. */
const ANNUAL = leaveType({ code: 'ANNUAL_TEST', name: 'Annual leave' });
const MATERNITY = leaveType({
  code: 'MATERNITY_TEST',
  name: 'Maternity leave',
  countingBasis: 'CALENDAR_DAYS',
  entitlementBasis: 'EVENT',
});

describe('a working day type, which skips weekends and holidays', () => {
  /**
   * The headline, and the sentence a person has to accept: twelve days off over
   * Christmas cost eight.
   *
   * Twelve calendar days from the Monday to the Friday. Four of them are free —
   * Christmas Day, the Saturday and Sunday after it, and New Year's Day — and the
   * remaining eight are what comes off the balance.
   */
  it('counts the working days, and names the days that were free', () => {
    const count = countLeaveDays(ANNUAL, CHRISTMAS_FORTNIGHT, STANDARD, CHRISTMAS_CALENDAR);

    expect(count.days).toBe(8);
    expect(count.calendarDays).toBe(12);
    expect(count.free).toEqual([
      { date: '2026-12-25', because: 'PUBLIC_HOLIDAY', name: 'Christmas Day' },
      { date: '2026-12-26', because: 'NOT_A_WORKING_DAY', name: null },
      { date: '2026-12-27', because: 'NOT_A_WORKING_DAY', name: null },
      { date: '2027-01-01', because: 'PUBLIC_HOLIDAY', name: "New Year's Day" },
    ]);
  });

  /**
   * Boxing Day 2026 is a Saturday, and it is reported as a day not worked rather
   * than as a public holiday.
   *
   * The order is the answer rather than an optimisation. For somebody on a Monday
   * to Friday week that Saturday was never going to cost anything and the gazette
   * had nothing to do with it — and it is what makes FR 25 come out right, since a
   * holiday declared on a day somebody does not work gives back nothing.
   */
  it('blames the pattern before the calendar, where a holiday falls on a day off', () => {
    const boxingDay = countLeaveDays(
      ANNUAL,
      { from: '2026-12-26', to: '2026-12-28' },
      STANDARD,
      CHRISTMAS_CALENDAR,
    );

    expect(boxingDay.free).toEqual([
      { date: '2026-12-26', because: 'NOT_A_WORKING_DAY', name: null },
      { date: '2026-12-27', because: 'NOT_A_WORKING_DAY', name: null },
    ]);
    expect(boxingDay.days).toBe(1);
  });

  /* A week off costs a part timer four days rather than five — the sentence
     ../../src/domain/work-pattern.ts opens with, finally counted. */
  it('costs a part timer only the days they work', () => {
    const week = { from: '2026-03-02', to: '2026-03-08' };

    expect(countLeaveDays(ANNUAL, week, STANDARD, []).days).toBe(5);
    expect(countLeaveDays(ANNUAL, week, FOUR_DAYS, []).days).toBe(4);
  });

  /* And a public holiday on a Wednesday costs her nothing, which is the other half
     of that sentence. It is free either way; what changes is which reason. */
  it('gives a part timer nothing back for a holiday on a day they do not work', () => {
    const wednesday = [holiday('9', 'Day of national mourning', '2026-03-04')];
    const week = { from: '2026-03-02', to: '2026-03-08' };

    const hers = countLeaveDays(ANNUAL, week, FOUR_DAYS, wednesday);
    const theirs = countLeaveDays(ANNUAL, week, STANDARD, wednesday);

    expect(hers.days).toBe(4);
    expect(theirs.days).toBe(4);
    expect(hers.free.find((day) => day.date === '2026-03-04')?.because).toBe('NOT_A_WORKING_DAY');
    expect(theirs.free.find((day) => day.date === '2026-03-04')?.because).toBe('PUBLIC_HOLIDAY');
  });

  /* A pattern that works every day makes a working day type count like a calendar
     day one, which is the arithmetic agreeing with itself from both directions. */
  it('counts every day for somebody who works every day, with no holidays about', () => {
    expect(countLeaveDays(ANNUAL, CHRISTMAS_FORTNIGHT, EVERY_DAY, []).days).toBe(12);
  });

  it('ignores holidays outside the period it was asked about', () => {
    const march = { from: '2026-03-02', to: '2026-03-06' };

    expect(countLeaveDays(ANNUAL, march, STANDARD, CHRISTMAS_CALENDAR).days).toBe(5);
  });

  /* One day is a period, and it is the most common request there is: somebody
     taking Friday off has written the same date twice. */
  it('counts a single day off as one day', () => {
    expect(
      countLeaveDays(ANNUAL, { from: '2026-03-06', to: '2026-03-06' }, STANDARD, []).days,
    ).toBe(1);
  });
});

describe('a calendar day type, which counts every day', () => {
  /**
   * FR 22: maternity and paternity count calendar days, "since they are expressed
   * as a continuous period of absence rather than an allowance of workdays".
   *
   * The same period, the same pattern and the same calendar as the headline case
   * above, and four more days — which is the whole of what the counting basis is
   * for.
   */
  it('counts the weekends and the holidays inside it', () => {
    const count = countLeaveDays(MATERNITY, CHRISTMAS_FORTNIGHT, STANDARD, CHRISTMAS_CALENDAR);

    expect(count.days).toBe(12);
    expect(count.calendarDays).toBe(12);
    expect(count.free).toEqual([]);
  });

  /* The working pattern is not consulted at all — FR 21 — so a part timer's four
     day week makes no difference to a hundred and twenty days of maternity leave. */
  it('gives the same answer whatever week the person works', () => {
    for (const week of [STANDARD, FOUR_DAYS, EVERY_DAY]) {
      expect(countLeaveDays(MATERNITY, CHRISTMAS_FORTNIGHT, week, CHRISTMAS_CALENDAR).days).toBe(
        12,
      );
    }
  });

  /* And it can never cost nothing, which is why LeaveCountsNoDays is a
     working-day-type refusal in practice: a period always holds at least one day
     and every one of them counts. */
  it('costs at least a day, even over a weekend nobody works', () => {
    expect(
      countLeaveDays(MATERNITY, { from: '2026-12-26', to: '2026-12-27' }, STANDARD, []).days,
    ).toBe(2);
  });
});

describe('the branch is on the counting basis, never on the type code', () => {
  /**
   * Design principle 5, stated as arithmetic. Two types identical but for their
   * code count identically; a type with a code nothing has ever heard of counts
   * correctly, which is the property that makes FR 31 true — HR adds a type next
   * year and it counts the moment the row exists.
   */
  it('counts a type nobody has heard of by its basis alone', () => {
    const invented = leaveType({
      code: 'STUDY_2031',
      name: 'Study leave',
      countingBasis: 'WORKING_DAYS',
    });
    const inventedContinuous = leaveType({
      code: 'SABBATICAL_2031',
      name: 'Sabbatical',
      countingBasis: 'CALENDAR_DAYS',
      entitlementBasis: 'EVENT',
    });

    expect(countLeaveDays(invented, CHRISTMAS_FORTNIGHT, STANDARD, CHRISTMAS_CALENDAR).days).toBe(
      8,
    );
    expect(
      countLeaveDays(inventedContinuous, CHRISTMAS_FORTNIGHT, STANDARD, CHRISTMAS_CALENDAR).days,
    ).toBe(12);
  });

  it('gives the same answer to two types that differ only in their code', () => {
    const renamed = leaveType({ code: 'ANNUAL_RENAMED', name: 'Annual leave' });

    expect(countLeaveDays(renamed, CHRISTMAS_FORTNIGHT, STANDARD, CHRISTMAS_CALENDAR)).toEqual(
      countLeaveDays(ANNUAL, CHRISTMAS_FORTNIGHT, STANDARD, CHRISTMAS_CALENDAR),
    );
  });

  /**
   * And the source never reads `code` at all.
   *
   * ../unit/migrations.test.ts asks the whole tree whether it names one of the
   * seven seeded codes; this is narrower and catches what that one cannot — a
   * branch on `type.code` against a code that is not seeded, which is exactly what
   * an eighth leave type would tempt somebody into writing.
   *
   * Comments are stripped first, because the file explains at length why a code
   * may not be read and would otherwise fail its own rule.
   */
  it('does not so much as mention the code field', () => {
    const source = readFileSync(
      join(process.cwd(), 'server', 'src', 'domain', 'leave-calculator.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

    expect(source).not.toMatch(/\.code\b/);
    expect(source).not.toMatch(/countingBasis\s*===/);
  });
});

describe('leave that costs nothing is refused rather than returned', () => {
  /**
   * The story's fourth criterion, and the reason is what every caller downstream
   * would otherwise have to invent: a request worth no days deducts nothing from a
   * balance, waits in an approval queue for a decision that changes nothing, and
   * shows on a team calendar as an absence nobody paid for.
   */
  it('refuses a weekend booked as annual leave', () => {
    expect(() =>
      countLeaveDays(ANNUAL, { from: '2026-12-26', to: '2026-12-27' }, STANDARD, []),
    ).toThrow(LeaveCountsNoDays);
  });

  it('refuses a single public holiday booked as annual leave', () => {
    expect(() =>
      countLeaveDays(
        ANNUAL,
        { from: '2026-12-25', to: '2026-12-25' },
        STANDARD,
        CHRISTMAS_CALENDAR,
      ),
    ).toThrow(LeaveCountsNoDays);
  });

  /**
   * The message names the days rather than only the verdict, because the person
   * looking at it has typed two dates they believe in. It also names the way out:
   * somebody who really did mean to record the whole period has chosen the wrong
   * kind of leave, not the wrong dates.
   */
  it('names the free days and the kind of leave, so the message is actionable', () => {
    try {
      countLeaveDays(
        ANNUAL,
        { from: '2026-12-26', to: '2026-12-27' },
        STANDARD,
        CHRISTMAS_CALENDAR,
      );
      throw new Error('That was counted, and should not have been.');
    } catch (error) {
      expect(error).toBeInstanceOf(LeaveCountsNoDays);
      expect((error as LeaveCountsNoDays).free.length).toBe(2);
      expect((error as LeaveCountsNoDays).period).toEqual({
        from: '2026-12-26',
        to: '2026-12-27',
      });
      expect((error as Error).message).toContain('Annual leave');
      expect((error as Error).message).toContain('2026-12-26');
      expect((error as Error).message).toContain('counts every day');
    }
  });

  /* It carries the type so a screen can offer the alternative rather than only
     describing it. */
  it('says which leave type refused it', () => {
    try {
      countLeaveDays(ANNUAL, { from: '2026-12-26', to: '2026-12-27' }, STANDARD, []);
      throw new Error('That was counted, and should not have been.');
    } catch (error) {
      expect((error as LeaveCountsNoDays).leaveTypeId).toBe(ANNUAL.id);
    }
  });

  /* And a long run of nothing is summarised rather than listed, because a refusal
     naming sixty days is a refusal nobody reads to the end of. */
  it('does not list every day of a long period that counts nothing', () => {
    const nobodyWorks = pattern('Nobody works', [7]);

    try {
      countLeaveDays(ANNUAL, { from: '2026-03-02', to: '2026-03-06' }, nobodyWorks, []);
      throw new Error('That was counted, and should not have been.');
    } catch (error) {
      expect((error as Error).message).toContain('and 1 more');
    }
  });
});

describe('two dates that are not a period', () => {
  /* Refused rather than counted as nothing, and the two are worth telling apart: a
     period covering no day is a mistake in the dates, and a period whose days are
     all free is a mistake about the kind of leave. One message for both would send
     half the people who hit it to correct the wrong field. */
  it('refuses one that runs backwards, against the field that is wrong', () => {
    expect(refusedField(() => validateLeavePeriod({ from: '2026-12-27', to: '2026-12-24' }))).toBe(
      'to',
    );
  });

  it('refuses a date that is not written as one', () => {
    expect(refusedField(() => validateLeavePeriod({ from: '25/12/2026', to: '2026-12-27' }))).toBe(
      'from',
    );
    expect(refusedField(() => validateLeavePeriod({ from: '2026-12-24', to: '2026-02-30' }))).toBe(
      'to',
    );
  });

  /**
   * A guard against a typed year rather than a policy about leave, and the same
   * distinction `requireWindow` in ../../src/domain/leave-type.ts draws when it
   * refuses a notice window of 365 days with "check the unit".
   *
   * Deliberately generous: two years is far longer than any absence this system
   * knows about, so refusing a real request is not a risk, and walking three
   * thousand days would be a hang rather than an answer.
   */
  it('refuses a period long enough to be a mistyped year', () => {
    expect(refusedField(() => validateLeavePeriod({ from: '2026-01-01', to: '3026-01-01' }))).toBe(
      'to',
    );

    expect(() => validateLeavePeriod({ from: '2026-01-01', to: '2027-12-31' })).not.toThrow();
  });

  it('refuses them from the counting function too, not only when asked first', () => {
    expect(() =>
      countLeaveDays(ANNUAL, { from: '2026-12-27', to: '2026-12-24' }, STANDARD, []),
    ).toThrow(InvalidLeavePeriod);
  });

  it('hands back the two days it accepted, so a caller can read rows against them', () => {
    expect(validateLeavePeriod(CHRISTMAS_FORTNIGHT)).toEqual(CHRISTMAS_FORTNIGHT);
  });
});

describe('whether one day costs a day', () => {
  /**
   * The primitive, exported beside the aggregate because FR 25 wants exactly it: a
   * holiday declared inside an already approved request gives a day back only if
   * that day was costing the person something. Asking that of one day should not
   * mean recounting a fortnight.
   */
  it('is what FR 25 asks about a newly declared holiday', () => {
    const declared = [holiday('9', 'Day of national mourning', '2026-03-04')];

    // A Wednesday. Worked by the standard week, not worked by Abena's.
    expect(costsADay(ANNUAL, '2026-03-04', STANDARD, [])).toBe(true);
    expect(costsADay(ANNUAL, '2026-03-04', STANDARD, declared)).toBe(false);
    expect(costsADay(ANNUAL, '2026-03-04', FOUR_DAYS, [])).toBe(false);
    expect(costsADay(ANNUAL, '2026-03-04', FOUR_DAYS, declared)).toBe(false);
  });

  it('is always true for a type that counts calendar days', () => {
    expect(costsADay(MATERNITY, '2026-12-25', STANDARD, CHRISTMAS_CALENDAR)).toBe(true);
    expect(costsADay(MATERNITY, '2026-12-27', FOUR_DAYS, CHRISTMAS_CALENDAR)).toBe(true);
  });

  it('agrees with the count it is the primitive of', () => {
    const week = { from: '2026-12-21', to: '2026-12-27' };
    const byDay = [...Array(7).keys()].filter((offset) =>
      costsADay(ANNUAL, `2026-12-${21 + offset}`, STANDARD, CHRISTMAS_CALENDAR),
    ).length;

    expect(byDay).toBe(countLeaveDays(ANNUAL, week, STANDARD, CHRISTMAS_CALENDAR).days);
  });
});

describe('it reads nothing at all', () => {
  /* No database, no clock, no environment. The two facts that come from tables are
     arguments, which is the story's fifth criterion and the thing that lets every
     case above be arithmetic. */
  it('imports nothing that could reach a database or a clock', () => {
    /* Comments stripped first, and every `from '...'` taken rather than only the
       ones that fit on a line: an import list is exactly the kind of thing the
       formatter rewraps, and a test that only sees the short ones would quietly
       stop noticing the long one somebody added. */
    const source = readFileSync(
      join(process.cwd(), 'server', 'src', 'domain', 'leave-calculator.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

    const imports = [...source.matchAll(/from '([^']+)';/g)].map(([, from]) => from);

    expect(imports.sort()).toEqual([
      './holiday.js',
      './leave-type.js',
      './time.js',
      './work-pattern.js',
    ]);
  });

  /* And gives the same answer twice, which is what makes FR 25's recalculation
     safe to run: the number only moves when the calendar or the pattern does. */
  it('gives the same answer to the same question', () => {
    const once = countLeaveDays(ANNUAL, CHRISTMAS_FORTNIGHT, STANDARD, CHRISTMAS_CALENDAR);
    const twice = countLeaveDays(ANNUAL, CHRISTMAS_FORTNIGHT, STANDARD, CHRISTMAS_CALENDAR);

    expect(once).toEqual(twice);
  });

  it('changes nothing it was given', () => {
    const calendar = [...CHRISTMAS_CALENDAR];
    const week = { ...CHRISTMAS_FORTNIGHT };

    countLeaveDays(ANNUAL, week, STANDARD, calendar);

    expect(calendar).toEqual(CHRISTMAS_CALENDAR);
    expect(week).toEqual(CHRISTMAS_FORTNIGHT);
  });
});

/* ------------------------------------------------------------------ fixtures */

/** The field a refusal blamed, which is what a form puts the message next to. */
function refusedField(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidLeavePeriod);
    return (error as InvalidLeavePeriod).field;
  }

  throw new Error('That was accepted, and should not have been.');
}

/** A stored leave type, with the fields a test is not about held still. */
function leaveType(
  overrides: Partial<Parameters<typeof validateNewLeaveType>[0]> & { code: string; name: string },
): LeaveType {
  return {
    id: overrides.code,
    ...validateNewLeaveType({
      countingBasis: 'WORKING_DAYS',
      entitlementBasis: 'QUOTA',
      ...overrides,
    }),
    deductsFromAnnual: false,
    isActive: true,
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
  };
}

/** A stored working pattern. FR 23. */
function pattern(name: string, workingDays: readonly Weekday[]): WorkPattern {
  return {
    id: name,
    name,
    workingDays: [...workingDays],
    isDefault: false,
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
  };
}

/** A stored public holiday. FR 22. */
function holiday(id: string, name: string, date: string): Holiday {
  return {
    id,
    name,
    date,
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
  };
}
