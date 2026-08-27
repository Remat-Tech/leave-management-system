import { describe, expect, it } from 'vitest';
import {
  assertCanDelete,
  DefaultWorkPatternRequired,
  InvalidWorkPattern,
  MONDAY_TO_FRIDAY,
  validateNewWorkPattern,
  validateWorkPatternChanges,
  weekOf,
  workingDaysOf,
  workingDaysPerWeek,
  type WorkPattern,
  WorkPatternInUse,
  worksOn,
} from '../../src/domain/work-pattern.js';

/**
 * The rules for a working pattern, checked without a database. FR 23, LMS 106.
 *
 * The database holds the same rules as a CHECK, a unique index and two deferred
 * triggers, and refuses the same patterns; that is asserted in the integration
 * suite. What is asserted here is that the refusal happens before the write and
 * says which field was wrong, and that a week means the same thing whichever
 * direction it is read in — the list somebody types and the seven rows it is
 * stored as.
 */

const STANDARD: WorkPattern = {
  id: '1',
  name: 'Standard Mon-Fri',
  workingDays: [1, 2, 3, 4, 5],
  isDefault: true,
  createdAt: new Date('2026-08-27T09:00:00Z'),
  updatedAt: new Date('2026-08-27T09:00:00Z'),
};

/** Abena Sarpong's week: Monday, Tuesday, Thursday, Friday. */
const PART_TIME: WorkPattern = {
  ...STANDARD,
  id: '2',
  name: 'Part time, Wednesdays off',
  workingDays: [1, 2, 4, 5],
  isDefault: false,
};

function refusal(fn: () => unknown): InvalidWorkPattern {
  try {
    fn();
  } catch (error) {
    if (error instanceof InvalidWorkPattern) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the working pattern to be refused, but it was accepted.');
}

describe('creating a working pattern', () => {
  it('keeps the name and the days it was given', () => {
    expect(
      validateNewWorkPattern({ name: 'Part time, Wednesdays off', workingDays: [1, 2, 4, 5] }),
    ).toEqual({ name: 'Part time, Wednesdays off', workingDays: [1, 2, 4, 5] });
  });

  it('trims the whitespace a copied and pasted name arrives with', () => {
    expect(validateNewWorkPattern({ name: '  Nights  ', workingDays: [1] }).name).toBe('Nights');
  });

  it('puts the days in order and collapses the ones said twice', () => {
    // A caller building the list from a row of checkboxes says [5, 1, 1] and
    // means Monday and Friday. It is not an error, it is the same week.
    expect(
      validateNewWorkPattern({ name: 'Two days', workingDays: [5, 1, 1] }).workingDays,
    ).toEqual([1, 5]);
  });

  it('refuses a pattern with no name, and says which field', () => {
    expect(refusal(() => validateNewWorkPattern({ name: '  ', workingDays: [1] })).field).toBe(
      'name',
    );
  });

  it('refuses a name longer than the column holds', () => {
    const error = refusal(() => validateNewWorkPattern({ name: 'a'.repeat(81), workingDays: [1] }));

    expect(error.field).toBe('name');
    expect(error.message).toMatch(/80 characters/);
  });

  it('refuses a week with no working day in it', () => {
    /* Somebody who works no day takes no leave, has no entitlement to pro rate
       and appears on no team calendar. That is employment_status, not a week. */
    const error = refusal(() => validateNewWorkPattern({ name: 'Never', workingDays: [] }));

    expect(error.field).toBe('workingDays');
    expect(error.message).toMatch(/at least one day/);
  });

  it('refuses a day that is not a day of the week', () => {
    expect(
      refusal(() => validateNewWorkPattern({ name: 'Eight days', workingDays: [1, 8] })).field,
    ).toBe('workingDays');
    expect(
      refusal(() => validateNewWorkPattern({ name: 'Half a day', workingDays: [1.5] })).field,
    ).toBe('workingDays');
  });

  it('refuses 0, rather than reading it as Sunday', () => {
    // JavaScript's getDay() counts Sunday as 0, and a caller passing its output
    // straight through has moved every day of the week by one. Accepting it
    // silently would make a Monday pattern a Sunday one.
    const error = refusal(() => validateNewWorkPattern({ name: 'Off by one', workingDays: [0] }));

    expect(error.message).toMatch(/1 \(Monday\) to 7 \(Sunday\)/);
  });

  it('refuses days that are not a list at all', () => {
    expect(
      refusal(() =>
        validateNewWorkPattern({
          name: 'Nothing said',
          workingDays: undefined as unknown as number[],
        }),
      ).field,
    ).toBe('workingDays');
  });
});

describe('editing a working pattern', () => {
  it('changes only the fields it was given', () => {
    expect(validateWorkPatternChanges({ name: 'Part time, Fridays off' })).toEqual({
      name: 'Part time, Fridays off',
    });
  });

  it('treats a change mentioning nothing as changing nothing', () => {
    expect(validateWorkPatternChanges({})).toEqual({});
  });

  it('replaces the week outright rather than adding to it', () => {
    // "Wednesdays as well" and "Wednesdays instead" are not distinguishable in a
    // list of days, so a week is always the whole week.
    expect(validateWorkPatternChanges({ workingDays: [1, 2, 3] }).workingDays).toEqual([1, 2, 3]);
  });

  it('holds a change to the same rules a new pattern is held to', () => {
    expect(refusal(() => validateWorkPatternChanges({ workingDays: [] })).field).toBe(
      'workingDays',
    );
    expect(refusal(() => validateWorkPatternChanges({ name: ' ' })).field).toBe('name');
  });
});

describe('the week a pattern works', () => {
  it('answers whether a weekday is worked', () => {
    expect(worksOn(PART_TIME, 2)).toBe(true);
    // The Wednesday that costs Abena nothing.
    expect(worksOn(PART_TIME, 3)).toBe(false);
    expect(worksOn(STANDARD, 3)).toBe(true);
    expect(worksOn(STANDARD, 6)).toBe(false);
  });

  it('counts the days a week has, which is what an entitlement is scaled by', () => {
    expect(workingDaysPerWeek(STANDARD)).toBe(5);
    expect(workingDaysPerWeek(PART_TIME)).toBe(4);
  });

  it('stores a week as seven days, not as the ones that are worked', () => {
    /* A day that is not worked is a row saying so. The alternative — no row —
       leaves "does this Saturday cost a day" to whichever join the counting
       query used, which is a decision nobody would have made on purpose. */
    const week = weekOf(PART_TIME.workingDays);

    expect(week).toHaveLength(7);
    expect(week.map((day) => day.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(week.filter((day) => day.isWorkingDay).map((day) => day.dayOfWeek)).toEqual([
      1, 2, 4, 5,
    ]);
  });

  it('reads the same week back out of those seven rows', () => {
    // Round trip, because the two directions are used by different layers and a
    // disagreement between them would be a silently wrong day count.
    expect(workingDaysOf(weekOf(PART_TIME.workingDays))).toEqual(PART_TIME.workingDays);
    expect(workingDaysOf(weekOf(MONDAY_TO_FRIDAY))).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads a week back in order however the rows arrive', () => {
    // Rows come back from the database in no guaranteed order, and a week that
    // reads "Friday, Monday" on a screen is a week somebody will re-enter.
    expect(
      workingDaysOf([
        { dayOfWeek: 5, isWorkingDay: true },
        { dayOfWeek: 1, isWorkingDay: true },
        { dayOfWeek: 3, isWorkingDay: false },
      ]),
    ).toEqual([1, 5]);
  });
});

describe('deleting a working pattern', () => {
  it('is allowed for one nobody works', () => {
    expect(() => assertCanDelete(PART_TIME, 0)).not.toThrow();
  });

  it('is refused for the default, whether or not anybody is on it', () => {
    /* A database with no default is one where no employee can be created: the
       column is NOT NULL and a caller need not name a pattern, so one has to
       stand in. */
    let thrown: unknown;
    try {
      assertCanDelete(STANDARD, 0);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DefaultWorkPatternRequired);
    expect((thrown as Error).message).toMatch(/Make another pattern the default first/);
  });

  it('is refused while somebody works it, and says how many', () => {
    let thrown: unknown;
    try {
      assertCanDelete(PART_TIME, 3);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WorkPatternInUse);
    expect((thrown as WorkPatternInUse).headcount).toBe(3);
    expect((thrown as Error).message).toMatch(/3 people/);
  });

  it('counts one person as a person', () => {
    // The message is read by somebody, so it says "1 person ... move them"
    // rather than "1 people ... move them all".
    const error = (() => {
      try {
        assertCanDelete(PART_TIME, 1);
      } catch (thrown) {
        return thrown as Error;
      }
      throw new Error('Expected a refusal.');
    })();

    expect(error.message).toMatch(/1 person/);
    expect(error.message).not.toMatch(/them all/);
  });
});
