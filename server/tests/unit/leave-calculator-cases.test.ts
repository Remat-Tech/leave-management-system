import { afterEach, describe, expect, it } from 'vitest';
import type { Holiday } from '../../src/features/holiday/holiday.js';
import {
  costsADay,
  countLeaveDays,
  type FreeDay,
  type LeavePeriod,
} from '../../src/features/leave-calculator/leave-calculator.js';
import {
  assertItCostsSomething,
  LeaveCountsNoDays,
} from '../../src/features/leave-request/leave-request.js';
import { type LeaveType, validateNewLeaveType } from '../../src/features/leave-type/leave-type.js';
import { type CalendarDate, calendarDaysBetween, eachDay } from '../../src/shared/time.js';
import {
  MONDAY_TO_FRIDAY,
  type Weekday,
  type WorkPattern,
} from '../../src/features/work-pattern/work-pattern.js';

/**
 * The case list of §7.3, worked. LMS 208.
 *
 * ./leave-calculator.test.ts proves the rules: one walk with one branch, the branch
 * on the counting basis and never on the code, a period costing nothing answered as
 * nought. This file proves the *answers*, and it exists because those are different
 * things.
 * A calculator can obey every rule in its own description and still be a day out
 * over Christmas, and the person who finds out is the one whose leave was a day
 * shorter than they thought.
 *
 * So the whole of it is one table. Every row carries the period, the week the
 * person works, the calendar in force, the arithmetic written out in words, and
 * both answers — what it costs as annual leave and what the same days cost as
 * maternity leave. A reader can check any row against a wall calendar without
 * running anything, which is the only kind of test that settles an argument about a
 * number.
 *
 * ## The awkward cases, and why each is in the story
 *
 *   **A single day.** The most common request there is: somebody taking Friday off
 *   writes the same date twice. Three of them are here, because the interesting
 *   single days are a working day, a weekend day and a public holiday, and only the
 *   first costs anything.
 *
 *   **A holiday that lands on a weekend.** Boxing Day 2026 is a Saturday. A
 *   calculator that counted weekdays and then subtracted the holidays inside the
 *   period would take that day off twice and hand back a fortnight a day cheaper
 *   than it is.
 *
 *   **A part timer's midweek day.** Rows nine and ten are the same week with the
 *   same holiday in it, priced for somebody who works Wednesdays and somebody who
 *   does not. Both cost four days and the reasons differ, which is the distinction
 *   FR 25's recalculation turns on.
 *
 *   **The year end.** Thirty first of December into the first of January, which is
 *   where a leave *year* boundary and a calendar year boundary sit on top of each
 *   other. This counts straight through; splitting a period across two leave years
 *   is the ledger's problem and is LMS 210, not this function's.
 *
 *   **February.** The whole of the leap one and the whole of the ordinary one, and
 *   the three days either side of the twenty ninth. The leap year costs exactly one
 *   day more, both ways, which is the story's own "does not quietly cost me a day".
 *
 * ## What the table is asked beyond its own rows
 *
 * Three sweeps, each of which would catch a class of error no single row can.
 *
 *   **Invariants.** Every counted day plus every free day is the whole period, for
 *   every row. A day that fell out of the walk entirely would satisfy any single
 *   expected number somebody wrote down wrongly, and cannot satisfy this.
 *
 *   **The process timezone.** The entire table is run again in four zones, two of
 *   them west of Greenwich. Accra is UTC+0 all year, so a suite written only here
 *   would pass with every conversion in ../../src/shared/time.ts deleted — and the
 *   symptom would be exactly the story's: everybody's weekend a day out, quietly.
 *   The two western zones are the ones that catch it, for a reason set out where
 *   the sweep is.
 *
 *   **Additivity.** A year counted whole is a year counted month by month. Any off
 *   by one at a period boundary shows up as a disagreement between the two.
 */

const ORIGINAL_TIMEZONE = process.env.TZ;

afterEach(() => {
  process.env.TZ = ORIGINAL_TIMEZONE;
});

/* The two weeks the table is priced against. FR 23.

   Abena Sarpong's is not "weekends off with a day missing" — it is the pattern the
   seed has carried since LMS 106 with the reason written beside it: a bug that
   assumes Saturday and Sunday are the only non working days passes every test that
   only ever uses the standard week. */
const STANDARD = pattern('Standard Mon-Fri', MONDAY_TO_FRIDAY);
const FOUR_DAYS = pattern('Part time, Wednesdays off', [1, 2, 4, 5]);

/** Annual leave and maternity leave, differing in the one field that matters. */
const ANNUAL = leaveType('ANNUAL_CASE', 'Annual leave', 'WORKING_DAYS');
const MATERNITY = leaveType('MATERNITY_CASE', 'Maternity leave', 'CALENDAR_DAYS');

const INDEPENDENCE_DAY = holiday('Independence Day', '2026-03-06');
const MOURNING = holiday('Day of national mourning', '2026-03-11');
const CHRISTMAS_DAY = holiday('Christmas Day', '2026-12-25');
const BOXING_DAY = holiday('Boxing Day', '2026-12-26');
const NEW_YEAR = holiday("New Year's Day", '2027-01-01');

/**
 * One worked example.
 *
 * `sum` is the arithmetic in words and goes in the test's name, so a failure reads
 * as "a range containing a public holiday — five weekdays, less Independence Day"
 * rather than as two numbers that disagree.
 */
interface Case {
  name: string;
  sum: string;
  period: LeavePeriod;
  pattern: WorkPattern;
  calendar: Holiday[];
  /** What it costs as annual leave, or 'nothing' where the count is refused. */
  asAnnual: number | 'nothing';
  /** What the same days cost as maternity leave. Always the whole period. */
  asMaternity: number;
  /** The days that cost nothing as annual leave, in the order they fall. */
  free: FreeDay[];
}

const CASES: Case[] = [
  {
    name: 'a single working day',
    sum: 'one Tuesday',
    period: { from: '2026-03-03', to: '2026-03-03' },
    pattern: STANDARD,
    calendar: [],
    asAnnual: 1,
    asMaternity: 1,
    free: [],
  },
  {
    name: 'a single day that is a weekend',
    sum: 'one Saturday, which is not worked',
    period: { from: '2026-03-07', to: '2026-03-07' },
    pattern: STANDARD,
    calendar: [],
    asAnnual: 'nothing',
    asMaternity: 1,
    free: [notWorked('2026-03-07')],
  },
  {
    name: 'a single day that is a public holiday',
    sum: 'one Friday, and it is Independence Day',
    period: { from: '2026-03-06', to: '2026-03-06' },
    pattern: STANDARD,
    calendar: [INDEPENDENCE_DAY],
    asAnnual: 'nothing',
    asMaternity: 1,
    free: [onHoliday('2026-03-06', 'Independence Day')],
  },
  {
    name: 'a range crossing a weekend',
    sum: 'Friday to Monday: four days, two of them worked',
    period: { from: '2026-03-06', to: '2026-03-09' },
    pattern: STANDARD,
    calendar: [],
    asAnnual: 2,
    asMaternity: 4,
    free: [notWorked('2026-03-07'), notWorked('2026-03-08')],
  },
  {
    name: 'a fortnight crossing two weekends',
    sum: 'fourteen days, ten of them weekdays',
    period: { from: '2026-03-02', to: '2026-03-15' },
    pattern: STANDARD,
    calendar: [],
    asAnnual: 10,
    asMaternity: 14,
    free: [
      notWorked('2026-03-07'),
      notWorked('2026-03-08'),
      notWorked('2026-03-14'),
      notWorked('2026-03-15'),
    ],
  },
  {
    name: 'a range containing a public holiday',
    sum: 'five weekdays, less Independence Day on the Friday',
    period: { from: '2026-03-02', to: '2026-03-06' },
    pattern: STANDARD,
    calendar: [INDEPENDENCE_DAY],
    asAnnual: 4,
    asMaternity: 5,
    free: [onHoliday('2026-03-06', 'Independence Day')],
  },
  {
    /* The case a calculator that subtracted holidays from a weekday count gets
       wrong. Boxing Day is a Saturday in 2026, so it is already free and must not
       be taken off a second time. */
    name: 'a range containing a holiday that lands on a weekend',
    sum: 'Thursday to Monday: three weekdays, less Christmas Day; Boxing Day was a Saturday',
    period: { from: '2026-12-24', to: '2026-12-28' },
    pattern: STANDARD,
    calendar: [CHRISTMAS_DAY, BOXING_DAY],
    asAnnual: 2,
    asMaternity: 5,
    free: [
      onHoliday('2026-12-25', 'Christmas Day'),
      notWorked('2026-12-26'),
      notWorked('2026-12-27'),
    ],
  },
  {
    name: 'a range that is entirely weekend and holiday',
    sum: 'Christmas Day and the weekend after it, and nothing else',
    period: { from: '2026-12-25', to: '2026-12-27' },
    pattern: STANDARD,
    calendar: [CHRISTMAS_DAY, BOXING_DAY],
    asAnnual: 'nothing',
    asMaternity: 3,
    free: [
      onHoliday('2026-12-25', 'Christmas Day'),
      notWorked('2026-12-26'),
      notWorked('2026-12-27'),
    ],
  },
  {
    name: 'a part time pattern excluding a midweek day',
    sum: 'a whole week, of which she works four days',
    period: { from: '2026-03-09', to: '2026-03-15' },
    pattern: FOUR_DAYS,
    calendar: [],
    asAnnual: 4,
    asMaternity: 7,
    free: [notWorked('2026-03-11'), notWorked('2026-03-14'), notWorked('2026-03-15')],
  },
  {
    /* Paired with the row below it. Same week, same holiday, same four days — and
       the reasons differ, which is what FR 25's recalculation reads. */
    name: 'a midweek holiday on the day a part timer does not work',
    sum: 'four working days, and the Wednesday holiday gives her nothing back',
    period: { from: '2026-03-09', to: '2026-03-13' },
    pattern: FOUR_DAYS,
    calendar: [MOURNING],
    asAnnual: 4,
    asMaternity: 5,
    free: [notWorked('2026-03-11')],
  },
  {
    name: 'the same midweek holiday for somebody who works Wednesdays',
    sum: 'five weekdays, less the Wednesday holiday',
    period: { from: '2026-03-09', to: '2026-03-13' },
    pattern: STANDARD,
    calendar: [MOURNING],
    asAnnual: 4,
    asMaternity: 5,
    free: [onHoliday('2026-03-11', 'Day of national mourning')],
  },
  {
    name: 'a range spanning 31 December into 1 January',
    sum: 'five weekdays across the year end, less New Year’s Day',
    period: { from: '2026-12-28', to: '2027-01-01' },
    pattern: STANDARD,
    calendar: [NEW_YEAR],
    asAnnual: 4,
    asMaternity: 5,
    free: [onHoliday('2027-01-01', "New Year's Day")],
  },
  {
    /* The same year end with 2027's gazette not yet transcribed, which is the state
       a database is in on the day it goes live. New Year's Day is an ordinary
       Friday and costs a day; see ../../src/features/holiday/holiday.ts for why an empty year
       is the honest one. */
    name: 'the same year end, with no calendar entered for the new year',
    sum: 'five weekdays, and nothing in the calendar to give any of them back',
    period: { from: '2026-12-28', to: '2027-01-01' },
    pattern: STANDARD,
    calendar: [CHRISTMAS_DAY],
    asAnnual: 5,
    asMaternity: 5,
    free: [],
  },
  {
    name: 'the whole of a leap February',
    sum: 'twenty nine days, twenty one of them weekdays',
    period: { from: '2028-02-01', to: '2028-02-29' },
    pattern: STANDARD,
    calendar: [],
    asAnnual: 21,
    asMaternity: 29,
    free: [
      '2028-02-05',
      '2028-02-06',
      '2028-02-12',
      '2028-02-13',
      '2028-02-19',
      '2028-02-20',
      '2028-02-26',
      '2028-02-27',
    ].map(notWorked),
  },
  {
    name: 'the whole of a February that is not a leap one',
    sum: 'twenty eight days, twenty of them weekdays — one less than the leap year, both ways',
    period: { from: '2027-02-01', to: '2027-02-28' },
    pattern: STANDARD,
    calendar: [],
    asAnnual: 20,
    asMaternity: 28,
    free: [
      '2027-02-06',
      '2027-02-07',
      '2027-02-13',
      '2027-02-14',
      '2027-02-20',
      '2027-02-21',
      '2027-02-27',
      '2027-02-28',
    ].map(notWorked),
  },
  {
    name: 'a range spanning the leap day itself',
    sum: 'Monday the twenty eighth, the twenty ninth, and the first of March',
    period: { from: '2028-02-28', to: '2028-03-01' },
    pattern: STANDARD,
    calendar: [],
    asAnnual: 3,
    asMaternity: 3,
    free: [],
  },
  {
    /* The same three dates in a year with no twenty ninth of February, which is two
       days rather than three — and the day that vanishes is a Sunday, so it costs
       nothing either way. The leap day is the one that costs. */
    name: 'the same dates in a year that has no leap day',
    sum: 'Sunday the twenty eighth and Monday the first: two days, one worked',
    period: { from: '2027-02-28', to: '2027-03-01' },
    pattern: STANDARD,
    calendar: [],
    asAnnual: 1,
    asMaternity: 2,
    free: [notWorked('2027-02-28')],
  },
];

/**
 * What a case costs as annual leave.
 *
 * A plain call since LMS 303: the calculator answers every row, nought included, and
 * carries the free days it did not charge for whether or not it charged for anything.
 * This used to catch `LeaveCountsNoDays` and read it as a zero, which is exactly the
 * shape of handling the split removed.
 */
function priceAsAnnual(worked: Case): { days: number; free: FreeDay[]; calendarDays: number } {
  return countLeaveDays(ANNUAL, worked.period, worked.pattern, worked.calendar);
}

/** The table's expected total, as a number, so a period costing nothing compares. */
function expected(worked: Case): number {
  return worked.asAnnual === 'nothing' ? 0 : worked.asAnnual;
}

describe('the case list of §7.3, priced as annual leave', () => {
  it.each(CASES)('$name — $sum', (worked) => {
    const priced = priceAsAnnual(worked);

    expect(priced.days).toBe(expected(worked));
    expect(priced.free).toEqual(worked.free);
  });

  /* And a period that costs nothing is refused when it is *asked for*, which is the
     submission validator's rule read against the same table. The calculator's nought
     and the refusal are two halves of one behaviour and the table proves both. */
  it.each(CASES.filter((worked) => worked.asAnnual === 'nothing'))(
    '$name cannot be asked for as annual leave',
    (worked) => {
      expect(() => assertItCostsSomething(ANNUAL, worked.period, priceAsAnnual(worked))).toThrow(
        LeaveCountsNoDays,
      );
    },
  );

  /* Every other row may be asked for, which is the other half of that and is what
     stops the filter above quietly matching everything. */
  it.each(CASES.filter((worked) => worked.asAnnual !== 'nothing'))(
    '$name costs something, and may be asked for',
    (worked) => {
      expect(priceAsAnnual(worked).days).toBeGreaterThan(0);
      expect(() =>
        assertItCostsSomething(ANNUAL, worked.period, priceAsAnnual(worked)),
      ).not.toThrow();
    },
  );
});

describe('the case list of §7.3, priced as maternity leave', () => {
  /* Every row, the same days, the other counting basis. FR 22: a continuous period
     of absence rather than an allowance of workdays, so nothing inside it is free —
     not a weekend, not a public holiday, and not a part timer's Wednesday. */
  it.each(CASES)('$name costs every day it spans', (worked) => {
    const count = countLeaveDays(MATERNITY, worked.period, worked.pattern, worked.calendar);

    expect(count.days).toBe(worked.asMaternity);
    expect(count.free).toEqual([]);
  });

  /**
   * The story's sixth case, said once in full: the same range, two types, two
   * totals, and nothing between them but a column.
   *
   * A fortnight over Christmas is nine working days and twelve continuous ones. If
   * these two numbers were ever equal for a period containing a weekend, the
   * counting basis would have stopped being read.
   */
  it('gives a different total to the same range under the two bases', () => {
    const christmas = { from: '2026-12-21', to: '2027-01-01' };
    const calendar = [CHRISTMAS_DAY, BOXING_DAY];

    const asAnnual = countLeaveDays(ANNUAL, christmas, STANDARD, calendar);
    const asMaternity = countLeaveDays(MATERNITY, christmas, STANDARD, calendar);

    expect(asAnnual.days).toBe(9);
    expect(asMaternity.days).toBe(12);
    expect(asAnnual.calendarDays).toBe(asMaternity.calendarDays);
  });
});

describe('what holds for every case in the table', () => {
  /**
   * Every day of the period is either counted or named as free.
   *
   * The invariant no single expected number can stand in for. A day dropped out of
   * the walk entirely — the last one, say, or the twenty ninth of February —
   * satisfies whatever total somebody wrote down beside it if they made the same
   * mistake twice, and cannot satisfy this.
   */
  it.each(CASES)('$name accounts for every day it spans', (worked) => {
    const priced = priceAsAnnual(worked);

    expect(priced.days + priced.free.length).toBe(priced.calendarDays);
    expect(priced.calendarDays).toBe(calendarDaysBetween(worked.period.from, worked.period.to));
  });

  /* The same period under the other basis spans the same days and none of them are
     free, which is the shortest statement of what a calendar day type is. */
  it.each(CASES)('$name spans the same days under either basis', (worked) => {
    const asMaternity = countLeaveDays(MATERNITY, worked.period, worked.pattern, worked.calendar);

    expect(asMaternity.days).toBe(asMaternity.calendarDays);
    expect(asMaternity.calendarDays).toBe(priceAsAnnual(worked).calendarDays);
  });

  /* Continuous leave is never cheaper than working day leave over the same days,
     which is the direction FR 22 puts them in and is worth asserting as a shape
     rather than only as seventeen separate numbers. */
  it.each(CASES)('$name never costs more as annual leave than as maternity leave', (worked) => {
    expect(expected(worked)).toBeLessThanOrEqual(worked.asMaternity);
  });

  /* And the primitive agrees with the aggregate on every day of every row. FR 25
     asks `costsADay` about one newly declared holiday rather than recounting a
     fortnight, so the two must never be able to disagree. */
  it.each(CASES)('$name is the same counted one day at a time', (worked) => {
    const byDay = [...eachDay(worked.period.from, worked.period.to)].filter((day) =>
      costsADay(ANNUAL, day, worked.pattern, worked.calendar),
    ).length;

    expect(byDay).toBe(expected(worked));
  });
});

describe('the answer does not move with the process timezone', () => {
  /**
   * The whole table again, in zones hours from Accra and on the wrong side of
   * midnight.
   *
   * This is the story's own fear — "does not quietly cost me a day" — and it is the
   * one that would never be caught here otherwise. Accra is UTC+0 all year and
   * observes no daylight saving, so a calculator built on a local `Date` gives every
   * one of the answers above and is wrong on the server it is deployed to. The
   * symptom is everybody's weekend shifted by a day, in a system where nobody
   * recounts.
   *
   * **The two western zones are the ones that bite, and it is worth knowing which.**
   * Every date in ../../src/shared/time.ts is built at UTC midnight, which is still
   * the same day everywhere east of Greenwich and the day *before* everywhere west
   * of it. So a `getDay()` written where a `getUTCDay()` belongs passes in Tokyo and
   * Kiritimati and fails in New York and Niue — and a sweep that only ran eastward
   * would report a clean bill of health for exactly the bug it was written to find.
   * The eastern two are kept because they cost nothing and because the opposite
   * mistake, a date built at *local* midnight and read back at UTC, fails there and
   * nowhere else.
   */
  it.each(['Pacific/Kiritimati', 'Pacific/Niue', 'America/New_York', 'Asia/Tokyo'])(
    'gives the whole table the same answers with the process set to %s',
    (zone) => {
      process.env.TZ = zone;

      for (const worked of CASES) {
        const priced = priceAsAnnual(worked);

        expect(priced.days, `${worked.name} counted wrongly in ${zone}`).toBe(expected(worked));
        expect(priced.free, `${worked.name} named the wrong free days in ${zone}`).toEqual(
          worked.free,
        );

        expect(
          countLeaveDays(MATERNITY, worked.period, worked.pattern, worked.calendar).days,
          `${worked.name} counted wrongly as maternity leave in ${zone}`,
        ).toBe(worked.asMaternity);
      }
    },
  );
});

describe('counting a year, whole and in pieces', () => {
  /* Every month of 2026, so that a year can be counted twelve times and once. */
  const MONTHS: LeavePeriod[] = [
    { from: '2026-01-01', to: '2026-01-31' },
    { from: '2026-02-01', to: '2026-02-28' },
    { from: '2026-03-01', to: '2026-03-31' },
    { from: '2026-04-01', to: '2026-04-30' },
    { from: '2026-05-01', to: '2026-05-31' },
    { from: '2026-06-01', to: '2026-06-30' },
    { from: '2026-07-01', to: '2026-07-31' },
    { from: '2026-08-01', to: '2026-08-31' },
    { from: '2026-09-01', to: '2026-09-30' },
    { from: '2026-10-01', to: '2026-10-31' },
    { from: '2026-11-01', to: '2026-11-30' },
    { from: '2026-12-01', to: '2026-12-31' },
  ];

  const WHOLE_YEAR: LeavePeriod = { from: '2026-01-01', to: '2026-12-31' };
  const CALENDAR = [INDEPENDENCE_DAY, MOURNING, CHRISTMAS_DAY, BOXING_DAY];

  /**
   * A year counted whole is a year counted month by month.
   *
   * Additivity is the property that catches an off by one at a period boundary,
   * which is the error this whole file exists for. Counting twelve periods puts
   * twenty two more boundaries in the way than counting one, so a walk that dropped
   * a first or a last day would disagree with itself by twelve.
   */
  it('adds up the same either way', () => {
    const whole = countLeaveDays(ANNUAL, WHOLE_YEAR, STANDARD, CALENDAR);
    const monthly = MONTHS.map(
      (month) => countLeaveDays(ANNUAL, month, STANDARD, CALENDAR).days,
    ).reduce((total, days) => total + days, 0);

    expect(monthly).toBe(whole.days);
  });

  /* And an absolute anchor, so that the two halves agreeing is not the two halves
     being wrong together. 2026 has 365 days and starts on a Thursday, which makes
     53 Thursdays and 52 of everything else: 261 weekdays, 104 weekend days. */
  it('is 261 weekdays in 2026, before any holidays come off', () => {
    const count = countLeaveDays(ANNUAL, WHOLE_YEAR, STANDARD, []);

    expect(count.days).toBe(261);
    expect(count.calendarDays).toBe(365);
    expect(count.free.length).toBe(104);
  });

  /* Three of the four holidays fall on a weekday, so three days come off. Boxing
     Day 2026 is the Saturday and was free already. */
  it('takes off only the holidays that fall on a day somebody works', () => {
    expect(countLeaveDays(ANNUAL, WHOLE_YEAR, STANDARD, CALENDAR).days).toBe(261 - 3);
  });

  /* The same year for a part timer: 209 days, and the Wednesday holiday is one of
     the fifty two Wednesdays she already had off. */
  it('is 209 days for somebody who does not work Wednesdays', () => {
    expect(countLeaveDays(ANNUAL, WHOLE_YEAR, FOUR_DAYS, []).days).toBe(209);
    expect(countLeaveDays(ANNUAL, WHOLE_YEAR, FOUR_DAYS, CALENDAR).days).toBe(209 - 2);
  });

  /* And a whole year of maternity leave is a whole year, which is the shortest
     statement of what a calendar day type is. */
  it('is every day of the year under a calendar day type', () => {
    expect(countLeaveDays(MATERNITY, WHOLE_YEAR, STANDARD, CALENDAR).days).toBe(365);
  });
});

describe('a calendar handed over in any order', () => {
  /* `holidayOn` looks a day up rather than scanning in order, and the free list is
     built by the walk rather than by the calendar — so the answer cannot depend on
     how the rows arrived. Worth asserting because the repository orders them today
     and nothing forces it to tomorrow. */
  it('gives the same answer shuffled as sorted', () => {
    const period = { from: '2026-12-21', to: '2027-01-01' };
    const sorted = [CHRISTMAS_DAY, BOXING_DAY, NEW_YEAR];
    const shuffled = [NEW_YEAR, CHRISTMAS_DAY, BOXING_DAY];

    expect(countLeaveDays(ANNUAL, period, STANDARD, shuffled)).toEqual(
      countLeaveDays(ANNUAL, period, STANDARD, sorted),
    );
  });

  /* And the free days come back in the order they fall, whatever order the calendar
     was in, because that list is read by a person. */
  it('names the free days in the order they fall', () => {
    const count = countLeaveDays(ANNUAL, { from: '2026-12-21', to: '2027-01-01' }, STANDARD, [
      NEW_YEAR,
      BOXING_DAY,
      CHRISTMAS_DAY,
    ]);

    expect(count.free.map((day) => day.date)).toEqual([
      '2026-12-25',
      '2026-12-26',
      '2026-12-27',
      '2027-01-01',
    ]);
  });
});

/* ------------------------------------------------------------------ fixtures */

function notWorked(date: CalendarDate): FreeDay {
  return { date, because: 'NOT_A_WORKING_DAY', name: null };
}

function onHoliday(date: CalendarDate, name: string): FreeDay {
  return { date, because: 'PUBLIC_HOLIDAY', name };
}

/** A stored leave type, with every field but the counting basis held still. */
function leaveType(code: string, name: string, countingBasis: 'WORKING_DAYS' | 'CALENDAR_DAYS') {
  return {
    id: code,
    ...validateNewLeaveType({
      code,
      name,
      countingBasis,
      entitlementBasis: countingBasis === 'WORKING_DAYS' ? 'QUOTA' : 'EVENT',
    }),
    deductsFromAnnual: false,
    isActive: true,
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
  } satisfies LeaveType;
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
function holiday(name: string, date: CalendarDate): Holiday {
  return {
    id: date,
    name,
    date,
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
  };
}
