import { describe, expect, it } from 'vitest';
import {
  assertNotInASettledYear,
  byDate,
  DuplicateHoliday,
  type Holiday,
  HolidayInASettledYear,
  holidayOn,
  holidaysBetween,
  InvalidHoliday,
  isHoliday,
  validateHolidayChanges,
  validateNewHoliday,
  yearsWithoutHolidays,
} from '../../src/features/holiday/holiday.js';
import type { LeaveYear } from '../../src/features/leave-year/leave-year.js';

/**
 * The gazetted public holiday calendar. FR 22, §5.4. LMS 206.
 *
 * The rules are pure functions, so this is where the story is proved.
 * ../integration/holiday.test.ts shows that Ghana's 2026 calendar is on a migrated
 * database, that a settled leave year keeps its days against a writer that never
 * went near the domain, and that HR may add a day in March that nobody knew about
 * in January.
 *
 * Three properties every test below is really about.
 *
 * **A day is closed once.** Two rows for one day would be subtracted twice by
 * whatever counts them, and the request over it would come back a day cheaper than
 * it was. The gazette handles a coincidence by naming the day for both, which is a
 * name and not a second row.
 *
 * **A settled year keeps its days.** Adding, moving or clearing a holiday inside a
 * closed leave year rewrites what every working-day request over it cost, after
 * those figures were made final. It is the same rule
 * `assertDoesNotReachIntoAClosedYear` holds for entitlement figures, reached from
 * the calendar instead.
 *
 * **The calendar is a transcription, so all three verbs are ordinary.** Adding a
 * day mid year, moving one the moon decided, and removing one the gazette never
 * confirmed are the three acceptance criteria and are the same fact three times:
 * this table holds the Republic's decisions rather than Remat's.
 */

/** Four days of Ghana's 2026 calendar, which is what most tests need. */
const INDEPENDENCE = stored('1', 'Independence Day', '2026-03-06');
const EID_AL_FITR = stored('2', 'Eid al-Fitr', '2026-03-20');
const CHRISTMAS = stored('3', 'Christmas Day', '2026-12-25');
const BOXING = stored('4', 'Boxing Day', '2026-12-26');

const CALENDAR_2026 = [INDEPENDENCE, EID_AL_FITR, CHRISTMAS, BOXING];

const Y2026 = year('2026', '2026-01-01', '2026-12-31');
const Y2027 = year('2027', '2027-01-01', '2027-12-31');

/** The field a refusal blamed, which is what a form puts the message next to. */
function refusedField(build: () => unknown): string {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidHoliday);
    return (error as InvalidHoliday).field;
  }

  throw new Error('That was accepted, and should not have been.');
}

describe('a day the office was closed', () => {
  it('carries the day and the name the gazette gave it', () => {
    expect(validateNewHoliday({ name: '  Farmers’ Day  ', date: '2026-12-04' })).toEqual({
      name: 'Farmers’ Day',
      date: '2026-12-04',
    });
  });

  /* NFR DAT 03, and the example is the one that matters most on this table:
     06/03/2026 and 03/06/2026 are the same ten characters meaning two different
     days, and one of them is Independence Day. */
  it('refuses a date that is not written as one', () => {
    expect(
      refusedField(() => validateNewHoliday({ name: 'Independence Day', date: '06/03/2026' })),
    ).toBe('date');

    expect(refusedField(() => validateNewHoliday({ name: 'Nonsense', date: '2026-02-30' }))).toBe(
      'date',
    );
  });

  it('refuses a day with no name, and one longer than the record holds', () => {
    expect(refusedField(() => validateNewHoliday({ name: '   ', date: '2026-12-25' }))).toBe(
      'name',
    );

    expect(
      refusedField(() => validateNewHoliday({ name: 'x'.repeat(81), date: '2026-12-25' })),
    ).toBe('name');
  });

  /* No rule about what a name may say. The gazette names a day for whatever falls
     on it, and a system that refused two feasts in one name would be refusing the
     sentence that was actually printed. */
  it('takes a name that holds two feasts, because the gazette prints one', () => {
    expect(
      validateNewHoliday({ name: 'Independence Day and Eid al-Fitr', date: '2030-03-06' }).name,
    ).toBe('Independence Day and Eid al-Fitr');
  });
});

describe('changing one', () => {
  /* Both fields, which is the difference from every other configuration record
     here. A leave type may not change its code and a closed year may only be
     relabelled, because those hold decisions whose history matters. This holds a
     transcription, and one of the wrong day is simply wrong. */
  it('moves the day as readily as it renames it', () => {
    expect(validateHolidayChanges({ date: '2026-03-21' })).toEqual({ date: '2026-03-21' });
    expect(validateHolidayChanges({ name: 'Eid ul-Fitr' })).toEqual({ name: 'Eid ul-Fitr' });
  });

  it('returns only the fields a change actually named', () => {
    expect(validateHolidayChanges({})).toEqual({});
  });

  it('refuses a move to something that is not a day', () => {
    expect(refusedField(() => validateHolidayChanges({ date: '21/03/2026' }))).toBe('date');
  });
});

describe('reading the calendar', () => {
  it('says whether the office was closed on a day', () => {
    expect(isHoliday(CALENDAR_2026, '2026-12-25')).toBe(true);
    expect(isHoliday(CALENDAR_2026, '2026-12-24')).toBe(false);
    expect(isHoliday([], '2026-12-25')).toBe(false);
  });

  /* A screen explaining why nine days cost seven needs the names: "the twenty
     fifth and twenty sixth of December" is an answer and "two public holidays" is
     not. */
  it('names the day, so a day count can explain itself', () => {
    expect(holidayOn(CALENDAR_2026, '2026-03-06')?.name).toBe('Independence Day');
    expect(holidayOn(CALENDAR_2026, '2026-03-07')).toBeUndefined();
  });

  /* Inclusive at both ends, because a leave request's last day is a day somebody
     is away. A half open range would drop a Christmas Day a request ended on,
     which is the one day of the year it is most expensive to drop. */
  it('reads a stretch of days inclusive at both ends', () => {
    expect(holidaysBetween(CALENDAR_2026, '2026-12-25', '2026-12-26').map((h) => h.name)).toEqual([
      'Christmas Day',
      'Boxing Day',
    ]);

    expect(holidaysBetween(CALENDAR_2026, '2026-12-20', '2026-12-25').map((h) => h.name)).toEqual([
      'Christmas Day',
    ]);

    expect(holidaysBetween(CALENDAR_2026, '2026-06-01', '2026-06-30')).toEqual([]);
  });

  it('reads them in the order they fall, whatever order they were held in', () => {
    expect([CHRISTMAS, INDEPENDENCE, BOXING].sort(byDate).map((h) => h.date)).toEqual([
      '2026-03-06',
      '2026-12-25',
      '2026-12-26',
    ]);
  });
});

describe('a leave year nobody has entered a calendar for', () => {
  /* The guard on the migration's decision to seed 2026 alone. Two of Ghana's
     fourteen holidays are fixed by the Minister after the moon is sighted, so a
     seeded 2027 would be a calendar that is nearly right — believed silently,
     wrong twice — where an empty one is a screen with nothing on it. */
  it('is named, so an empty year is a question rather than a surprise', () => {
    expect(yearsWithoutHolidays([Y2026, Y2027], CALENDAR_2026).map((y) => y.label)).toEqual([
      '2027',
    ]);
  });

  it('is not named once somebody has entered even one day of it', () => {
    const boxingDay2027 = stored('5', 'Boxing Day', '2027-12-26');

    expect(yearsWithoutHolidays([Y2026, Y2027], [...CALENDAR_2026, boxingDay2027])).toEqual([]);
  });

  it('is every year on a database where the calendar is empty', () => {
    expect(yearsWithoutHolidays([Y2026, Y2027], []).map((y) => y.label)).toEqual(['2026', '2027']);
  });

  /* A holiday outside every leave year says nothing about any of them. Somebody
     getting ahead on 2029 has not given 2027 a calendar. */
  it('is unmoved by a holiday in a year nobody has drawn yet', () => {
    const ahead = stored('6', 'Christmas Day', '2029-12-25');

    expect(yearsWithoutHolidays([Y2027], [ahead]).map((y) => y.label)).toEqual(['2027']);
  });
});

describe('a settled leave year keeps its days', () => {
  /* The rule this story inherits from LMS 205. Every request over a day in a
     closed year was counted against the calendar as it stood, and a closed year is
     never recalculated. */
  it('refuses a day inside one', () => {
    expect(() => assertNotInASettledYear('2026-12-25', '2027-01-01')).toThrow(
      HolidayInASettledYear,
    );
    expect(() => assertNotInASettledYear('2026-12-31', '2027-01-01')).toThrow(
      HolidayInASettledYear,
    );
  });

  it('allows the first day still open, and everything after it', () => {
    expect(() => assertNotInASettledYear('2027-01-01', '2027-01-01')).not.toThrow();
    expect(() => assertNotInASettledYear('2027-06-30', '2027-01-01')).not.toThrow();
  });

  /* Null means nothing has been closed, which is not the same as "no check" — it
     is the check, answered, and it is the answer on go live. */
  it('allows any day at all while no year has been closed', () => {
    expect(() => assertNotInASettledYear('2026-01-01', null)).not.toThrow();
  });

  /* The message has to be actionable, so it says which day is the earliest that
     can still be changed rather than only that this one cannot. */
  it('says the earliest day the calendar can still be changed for', () => {
    try {
      assertNotInASettledYear('2026-12-25', '2027-01-01', 'added to');
      throw new Error('That was allowed, and should not have been.');
    } catch (error) {
      expect(error).toBeInstanceOf(HolidayInASettledYear);
      expect((error as HolidayInASettledYear).earliestOpenDay).toBe('2027-01-01');
      expect((error as Error).message).toContain('added to');
      expect((error as Error).message).toContain('2027-01-01');
    }
  });

  /* Both ends of a move are asked separately by the service, because dragging a
     day out of a settled year and dropping one into it are two different wrongs —
     and a check on the new date alone would permit the first, which is the more
     likely of the two because it looks like tidying up. */
  it('refuses the day a holiday is being moved off, not only the one it moves to', () => {
    expect(() => assertNotInASettledYear('2026-05-27', '2027-01-01', 'moved for')).toThrow(
      HolidayInASettledYear,
    );
    expect(() => assertNotInASettledYear('2027-05-17', '2027-01-01', 'moved to')).not.toThrow();
  });
});

/* DuplicateHoliday is raised by the repository from the unique index rather than
   by anything here — checking first and writing afterwards is a race — so what is
   asserted of it is that it says which day was taken and what to do instead. */
describe('a second holiday on one day', () => {
  it('says which day it was, and that renaming is the answer', () => {
    const refusal = new DuplicateHoliday('2026-03-06', 'Independence Day');

    expect(refusal.date).toBe('2026-03-06');
    expect(refusal.message).toContain('2026-03-06');
    expect(refusal.message).toContain('Independence Day');
    expect(refusal.message).toMatch(/[Rr]ename/);
  });

  it('still names the day when nothing told it what was already there', () => {
    expect(new DuplicateHoliday('2026-03-06').message).toContain('2026-03-06');
  });
});

/** A stored record, with the fields a test is not about held still. */
function stored(id: string, name: string, date: string): Holiday {
  return {
    id,
    ...validateNewHoliday({ name, date }),
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
  };
}

/** A leave year, for the two readings that are about the years around a calendar. */
function year(label: string, startDate: string, endDate: string): LeaveYear {
  return {
    id: label,
    label,
    startDate,
    endDate,
    isClosed: false,
    closedAt: null,
    createdAt: new Date('2026-01-05T00:00:00Z'),
    updatedAt: new Date('2026-01-05T00:00:00Z'),
  };
}
