import { describe, expect, it } from 'vitest';
import * as leaveYearDomain from '../../src/domain/leave-year.js';
import {
  assertFitsAmong,
  assertMayBeChanged,
  assertMayBeClosed,
  byStartDate,
  coversDay,
  DuplicateLeaveYearLabel,
  earliestOpenDayOf,
  InvalidLeaveYear,
  type LeaveYear,
  LeaveYearAlreadyClosed,
  LeaveYearLeavesAGap,
  LeaveYearNotFinished,
  OverlappingLeaveYears,
  validateLeaveYearChanges,
  validateNewLeaveYear,
  yearFor,
} from '../../src/domain/leave-year.js';

/**
 * The leave year, and what closing one means. §5.4. LMS 205.
 *
 * The rules are pure functions, so this is where the story is proved.
 * ../integration/leave-year.test.ts shows that 2026 and 2027 are on a migrated
 * database, that the database holds the same rules as constraints and refuses a
 * reopening on the owner connection, and that closing one moves the boundary the
 * entitlement rules are judged against.
 *
 * Two properties every test below is really about.
 *
 * **A day is in exactly one leave year, or none.** Overlaps and gaps are the same
 * defect from opposite sides and are checked together, because a rule that
 * prevented one and not the other would leave {@link yearFor} answering "whichever
 * row came first" or "nothing at all" — and the second is the one that fails
 * silently, months later, in somebody's balance.
 *
 * **Closing is one way.** There is no reopen in the domain, in the service, in the
 * privileges or in the database, and the tests that would prove one works are
 * deliberately absent. What is here instead is that closing refuses a year still
 * running, refuses to happen twice, and that a closed year may be renamed and
 * nothing else.
 */

/** 2026 and 2027 as the migration seeds them, which is what most tests need. */
const Y2026 = stored({ label: '2026', startDate: '2026-01-01', endDate: '2026-12-31' });
const Y2027 = stored({ label: '2027', startDate: '2027-01-01', endDate: '2027-12-31' });

/** The field a refusal blamed, which is what a form puts the message next to. */
function refusedField(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidLeaveYear);
    return (error as InvalidLeaveYear).field;
  }

  throw new Error('That was accepted, and should not have been.');
}

describe('a new leave year', () => {
  it('carries the days it covers and the name people call it', () => {
    expect(
      validateNewLeaveYear({ label: '  2028  ', startDate: '2028-01-01', endDate: '2028-12-31' }),
    ).toEqual({ label: '2028', startDate: '2028-01-01', endDate: '2028-12-31' });
  });

  /* Both ends are inside the year, which is how a person says it: 2026 runs to
     the thirty first of December, not to "the first of January 2027, exclusive". */
  it('covers both of the days it names', () => {
    expect(coversDay(Y2026, '2026-01-01')).toBe(true);
    expect(coversDay(Y2026, '2026-12-31')).toBe(true);
    expect(coversDay(Y2026, '2025-12-31')).toBe(false);
    expect(coversDay(Y2026, '2027-01-01')).toBe(false);
  });

  /* A year that ends before it starts covers no day at all, so every reading of
     it is "this year is nothing". One day is a typo in the same family. */
  it('refuses a year that does not run forwards', () => {
    expect(
      refusedField(() =>
        validateNewLeaveYear({ label: '2028', startDate: '2028-12-31', endDate: '2028-01-01' }),
      ),
    ).toBe('endDate');

    expect(
      refusedField(() =>
        validateNewLeaveYear({ label: 'a day', startDate: '2028-01-01', endDate: '2028-01-01' }),
      ),
    ).toBe('endDate');
  });

  /* NFR DAT 03 and the README's own example. 31/07/2026 and 07/31/2026 are the
     same eleven characters meaning two different days, so neither is a date. */
  it('refuses a date that is not written as one', () => {
    expect(
      refusedField(() =>
        validateNewLeaveYear({ label: '2028', startDate: '01/01/2028', endDate: '2028-12-31' }),
      ),
    ).toBe('startDate');

    expect(
      refusedField(() =>
        validateNewLeaveYear({ label: '2028', startDate: '2028-02-30', endDate: '2028-12-31' }),
      ),
    ).toBe('startDate');
  });

  it('refuses a year with no name, and one longer than the record holds', () => {
    expect(
      refusedField(() =>
        validateNewLeaveYear({ label: '   ', startDate: '2028-01-01', endDate: '2028-12-31' }),
      ),
    ).toBe('label');

    expect(
      refusedField(() =>
        validateNewLeaveYear({
          label: 'x'.repeat(41),
          startDate: '2028-01-01',
          endDate: '2028-12-31',
        }),
      ),
    ).toBe('label');
  });

  /* The label is a column rather than arithmetic on the start date, because that
     arithmetic is right for a January to December year and wrong for one running
     April to March, where the year everybody says out loud is '2026/27'. */
  it('takes a name that is not the year the start date falls in', () => {
    expect(
      validateNewLeaveYear({ label: '2026/27', startDate: '2026-04-01', endDate: '2027-03-31' })
        .label,
    ).toBe('2026/27');
  });
});

describe('changing one', () => {
  /* The rule spans both dates and a change usually mentions one of them, so it is
     judged against the record as it will be rather than as it was given. */
  it('judges a moved end date against the start already on the row', () => {
    expect(refusedField(() => validateLeaveYearChanges({ endDate: '2025-06-01' }, Y2026))).toBe(
      'endDate',
    );

    expect(validateLeaveYearChanges({ endDate: '2027-01-31' }, Y2026)).toEqual({
      endDate: '2027-01-31',
    });
  });

  it('returns only the fields a change actually named', () => {
    expect(validateLeaveYearChanges({ label: 'Leave year 2026' }, Y2026)).toEqual({
      label: 'Leave year 2026',
    });
  });
});

describe('which year a day is in', () => {
  const YEARS = [Y2026, Y2027];

  it('finds the one year that covers it', () => {
    expect(yearFor(YEARS, '2026-07-31')?.label).toBe('2026');
    expect(yearFor(YEARS, '2027-01-01')?.label).toBe('2027');
  });

  /* Undefined is an answer rather than a failure, and it is the honest one: this
     system holds no leave year before 2026 and none past whatever HR has defined,
     and a day outside that is a question about a year nobody has decided on. */
  it('answers nothing for a day outside every year, rather than guessing', () => {
    expect(yearFor(YEARS, '2025-12-31')).toBeUndefined();
    expect(yearFor(YEARS, '2028-01-01')).toBeUndefined();
    expect(yearFor([], '2026-07-31')).toBeUndefined();
  });

  it('reads the years in the order they run', () => {
    expect([Y2027, Y2026].sort(byStartDate).map((year) => year.label)).toEqual(['2026', '2027']);
  });
});

describe('a day is in exactly one year, or none', () => {
  const YEARS = [Y2026, Y2027];

  it('accepts a year that carries straight on from the last', () => {
    expect(() =>
      assertFitsAmong({ startDate: '2028-01-01', endDate: '2028-12-31' }, YEARS),
    ).not.toThrow();
  });

  it('accepts a year that carries straight into the first', () => {
    expect(() =>
      assertFitsAmong({ startDate: '2025-01-01', endDate: '2025-12-31' }, YEARS),
    ).not.toThrow();
  });

  it('accepts the very first year, which has nothing on either side', () => {
    expect(() =>
      assertFitsAmong({ startDate: '2026-01-01', endDate: '2026-12-31' }, []),
    ).not.toThrow();
  });

  /* A day in two years draws its balance from two allowances, and every report of
     it is a choice about which to believe. */
  it('refuses a year that shares even one day with another', () => {
    expect(() =>
      assertFitsAmong({ startDate: '2026-12-31', endDate: '2027-06-30' }, YEARS),
    ).toThrow(OverlappingLeaveYears);

    expect(() =>
      assertFitsAmong({ startDate: '2026-06-01', endDate: '2026-06-30' }, YEARS),
    ).toThrow(OverlappingLeaveYears);
  });

  /* And names the year it collided with, because "those dates overlap" is not
     actionable and "they overlap 2026, which runs to the thirty first of
     December" is. */
  it('says which year the days it wanted are already in', () => {
    try {
      assertFitsAmong({ startDate: '2026-06-01', endDate: '2026-06-30' }, YEARS);
      throw new Error('That was accepted, and should not have been.');
    } catch (error) {
      expect(error).toBeInstanceOf(OverlappingLeaveYears);
      expect((error as Error).message).toContain('2026');
      expect((error as Error).message).toContain('2026-12-31');
    }
  });

  /* The quiet failure. A day in no year means leave drawing on a balance nobody
     opened, and the rollover of FR 36 with nothing to carry into. */
  it('refuses a year that would leave days in no year at all', () => {
    expect(() =>
      assertFitsAmong({ startDate: '2029-01-01', endDate: '2029-12-31' }, YEARS),
    ).toThrow(LeaveYearLeavesAGap);
  });

  it('names both ends of the gap it would leave', () => {
    try {
      assertFitsAmong({ startDate: '2029-01-01', endDate: '2029-12-31' }, YEARS);
      throw new Error('That was accepted, and should not have been.');
    } catch (error) {
      expect(error).toBeInstanceOf(LeaveYearLeavesAGap);
      expect((error as Error).message).toContain('2028-01-01');
      expect((error as Error).message).toContain('2028-12-31');
    }
  });

  /* Checked from both sides, which is what makes the order years are created in
     irrelevant: a year inserted before an existing one is judged against the one
     that now follows it. */
  it('refuses a gap on the side the new year was inserted before', () => {
    expect(() =>
      assertFitsAmong({ startDate: '2024-01-01', endDate: '2024-12-31' }, YEARS),
    ).toThrow(LeaveYearLeavesAGap);
  });

  /* A year always overlaps itself, so judging one against its own row would refuse
     every correction. The service passes every year but this one. */
  it('lets a year be moved when it is judged against the others rather than itself', () => {
    expect(() =>
      assertFitsAmong({ startDate: '2027-01-01', endDate: '2027-06-30' }, [Y2026]),
    ).not.toThrow();
  });

  /* The leap day, because a year boundary is exactly where day arithmetic is most
     likely to be wrong and 2028 is the next leap year. */
  it('reads the day after the twenty ninth of February as the first of March', () => {
    const leap = stored({ label: '2028', startDate: '2028-01-01', endDate: '2028-02-29' });

    expect(() =>
      assertFitsAmong({ startDate: '2028-03-01', endDate: '2028-12-31' }, [leap]),
    ).not.toThrow();

    expect(() =>
      assertFitsAmong({ startDate: '2028-03-02', endDate: '2028-12-31' }, [leap]),
    ).toThrow(LeaveYearLeavesAGap);
  });
});

describe('closing a year', () => {
  /* The mistake that actually happens: it is the third of January, somebody is
     tidying up, and the year they reach for is the one that started two days ago.
     A year still running has requests in flight. */
  it('refuses one that has not finished yet', () => {
    expect(() => assertMayBeClosed(Y2026, '2026-06-30')).toThrow(LeaveYearNotFinished);
    expect(() => assertMayBeClosed(Y2026, '2026-12-31')).toThrow(LeaveYearNotFinished);
  });

  /* And allows it from the day after it ends. Whether it *should* be closed then
     is HR's judgement — FR 18 lets an absence be recorded a week late, so they
     will wait — and a fixed number of days here would be a policy nobody asked
     for. */
  it('allows one from the day after it ends', () => {
    expect(() => assertMayBeClosed(Y2026, '2027-01-01')).not.toThrow();
  });

  /* Closing twice is somebody expecting something to happen, and the honest
     answer is that it happened already. */
  it('refuses one that is already closed', () => {
    expect(() => assertMayBeClosed(closed(Y2026), '2027-06-30')).toThrow(LeaveYearAlreadyClosed);
  });

  it('says how far off the year is, so the message is actionable', () => {
    try {
      assertMayBeClosed(Y2026, '2026-06-30');
      throw new Error('That was allowed, and should not have been.');
    } catch (error) {
      expect(error).toBeInstanceOf(LeaveYearNotFinished);
      expect((error as LeaveYearNotFinished).endDate).toBe('2026-12-31');
      expect((error as Error).message).toContain('2026-06-30');
    }
  });
});

describe('a closed year is history', () => {
  const settled = closed(Y2026);

  /* The lock. Moving the days a closed year covered is reopening it by another
     route: every figure in it was calculated against those days. */
  it('refuses a change to the days it covered', () => {
    expect(() => assertMayBeChanged(settled, { endDate: '2027-01-31' })).toThrow(
      LeaveYearAlreadyClosed,
    );
    expect(() => assertMayBeChanged(settled, { startDate: '2025-12-01' })).toThrow(
      LeaveYearAlreadyClosed,
    );
  });

  /* And allows a better name, which is the same exemption an entitlement rule in
     effect makes for its note. Calling a year '2026' or 'Leave year 2026' does not
     change what anybody was owed in it. */
  it('allows it to be called something better', () => {
    expect(() => assertMayBeChanged(settled, { label: 'Leave year 2026' })).not.toThrow();
  });

  it('leaves an open year alone entirely', () => {
    expect(() => assertMayBeChanged(Y2026, { startDate: '2026-02-01' })).not.toThrow();
  });

  /* There is no reopen to test, here or anywhere else, and that is the story
     rather than a gap in it: a decision the person who made it can undo is not a
     lock. The domain exports nothing that could express one, the service has no
     method, and `keep_a_closed_leave_year_closed()` refuses it on every
     connection — which is what ../integration/leave-year.test.ts proves. */
  it('offers nothing anywhere that could undo it', () => {
    expect(Object.keys(leaveYearDomain).filter((name) => /reopen|unclose/i.test(name))).toEqual([]);
  });
});

describe('the boundary a closed year sets', () => {
  /* What EarliestOpenDay has been asking for since LMS 203 and getting
     NOTHING_IS_CLOSED_YET for. Null keeps meaning exactly what it meant then. */
  it('is nothing at all while no year has been closed', () => {
    expect(earliestOpenDayOf([Y2026, Y2027])).toBeNull();
    expect(earliestOpenDayOf([])).toBeNull();
  });

  it('is the day after the closed year ends', () => {
    expect(earliestOpenDayOf([closed(Y2026), Y2027])).toBe('2027-01-01');
  });

  it('moves on as each year is closed', () => {
    expect(earliestOpenDayOf([closed(Y2026), closed(Y2027)])).toBe('2028-01-01');
  });

  /* The latest closed year rather than the earliest open one, which only shows if
     somebody closes 2027 while 2026 is still open. Nothing refuses that, and
     reading the latest closed end means the boundary is the safe one either way. */
  it('reads the latest closed year even when an earlier one is still open', () => {
    expect(earliestOpenDayOf([Y2026, closed(Y2027)])).toBe('2028-01-01');
  });

  /* The arithmetic that is easiest to get wrong, on the one boundary every year
     has. */
  it('crosses the year end correctly', () => {
    const short = closed(stored({ label: 'x', startDate: '2028-01-01', endDate: '2028-02-29' }));

    expect(earliestOpenDayOf([short])).toBe('2028-03-01');
  });
});

/** A stored record, with the fields a test is not about held still. */
function stored(input: { label: string; startDate: string; endDate: string }): LeaveYear {
  return {
    id: '1',
    ...validateNewLeaveYear(input),
    isClosed: false,
    closedAt: null,
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
  };
}

/** The same year, settled. Only the database may actually do this. */
function closed(year: LeaveYear): LeaveYear {
  return { ...year, isClosed: true, closedAt: new Date('2027-01-04T09:00:00Z') };
}

/* DuplicateLeaveYearLabel is raised by the repository from the unique index
   rather than by anything here — checking first and writing afterwards is a race
   — so what is asserted of it is that it says which name was taken. */
describe('two years under one name', () => {
  it('says which name it was', () => {
    expect(new DuplicateLeaveYearLabel('2026').message).toContain('2026');
  });
});
