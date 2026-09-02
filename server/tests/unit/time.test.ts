import { afterEach, describe, expect, it } from 'vitest';
import {
  calendarDateIn,
  calendarDaysBetween,
  dayAfter,
  dayBefore,
  DEFAULT_DISPLAY_TIMEZONE,
  displayTimezone,
  eachDay,
  formatInstant,
  isCalendarDate,
  isKnownTimeZone,
  isoWeekdayOf,
  withoutMidnight,
  type CalendarDate,
} from '../../src/shared/time.js';

/**
 * Dates, instants, and the line between them. NFR DAT 03. LMS 114.
 *
 * The half of the story that needs no database. The other half — that the
 * columns are the right types and that every session speaks UTC — is
 * ../integration/time.test.ts, because it is about a real server's settings and
 * nothing here could tell the difference.
 *
 * Everything below is arranged in zones that are hours from Accra and on the
 * wrong side of midnight, and that is the point rather than showing off. Accra is
 * UTC+0 all year and observes no daylight saving, so a suite written against the
 * company's own zone would pass with every conversion in this file deleted.
 */

/* Half past eleven at night in Accra on the twenty eighth of August. Already the
   twenty ninth in Tokyo, still the twenty eighth in New York, and the whole of
   the story in one instant: three answers, one moment, no disagreement. */
const LATE_ON_THE_TWENTY_EIGHTH = new Date('2026-08-28T23:30:00Z');

const ORIGINAL_TIMEZONE = process.env.TZ;

afterEach(() => {
  process.env.TZ = ORIGINAL_TIMEZONE;
});

describe('a calendar date', () => {
  it.each(['2026-01-01', '2026-07-31', '2028-02-29', '1999-12-31'])('%s is one', (value) => {
    expect(isCalendarDate(value)).toBe(true);
  });

  it.each([
    ['31/07/2026', 'the other way round, which is a different day'],
    ['07/31/2026', 'the American way round, which is a third reading'],
    ['2026-7-1', 'unpadded, so it no longer sorts'],
    ['2026-07-31T00:00:00Z', 'an instant wearing a date'],
    ['2026-07-31 ', 'not trimmed by this function, deliberately'],
    ['yesterday', 'not a date at all'],
    ['', 'nothing'],
  ])('%s is not: %s', (value) => {
    expect(isCalendarDate(value)).toBe(false);
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-02-29'])(
    '%s has the shape and is not a day',
    (value) => {
      expect(isCalendarDate(value)).toBe(false);
    },
  );

  it('is not a Date, a number, or null', () => {
    expect(isCalendarDate(new Date('2026-07-31'))).toBe(false);
    expect(isCalendarDate(20260731)).toBe(false);
    expect(isCalendarDate(null)).toBe(false);
    expect(isCalendarDate(undefined)).toBe(false);
  });

  /* The reason the form is fixed, asserted rather than assumed: every date
     comparison in /domain is a string comparison and needs no library. */
  it('compares as a string, and the comparison is the date comparison', () => {
    const inOrder: CalendarDate[] = ['2025-12-31', '2026-01-01', '2026-01-02', '2026-10-01'];
    const shuffled = ['2026-01-02', '2026-10-01', '2025-12-31', '2026-01-01'];

    expect([...shuffled].sort()).toEqual(inOrder);
    expect('2026-09-01' < '2026-10-01').toBe(true);
  });

  /* A date does not move with the process. The whole story, in the one place a
     leaver's exit date would shift if any of this were wrong. */
  it.each(['Pacific/Kiritimati', 'Pacific/Niue', 'Africa/Accra', 'UTC'])(
    'means the same day with the process set to %s',
    (zone) => {
      process.env.TZ = zone;

      const exitDate: CalendarDate = '2026-07-31';

      expect(isCalendarDate(exitDate)).toBe(true);
      expect(exitDate).toBe('2026-07-31');
    },
  );
});

/**
 * The one piece of arithmetic this file does on a day. LMS 205.
 *
 * It exists for `earliestOpenDayOf` in ../../src/features/leave-year/leave-year.ts — the day
 * after a closed year ends — and everything worth asserting about it is a
 * boundary somebody would otherwise have written by hand and got wrong once.
 *
 * The process zone is moved under every case, because the round trip goes through
 * a `Date` and the whole claim being made is that the zone cancels. A version
 * built on local time rather than UTC passes in Accra and fails in Kiritimati,
 * which is exactly the bug this file exists to catch.
 */
describe('the day either side of a day', () => {
  it('is the next and the previous day, in the middle of a month', () => {
    expect(dayAfter('2026-07-15')).toBe('2026-07-16');
    expect(dayBefore('2026-07-15')).toBe('2026-07-14');
  });

  /* The boundary every leave year has, and the reason this function exists: 2026
     is closed, and the first day still open is the first of January 2027. */
  it('crosses the end of a year', () => {
    expect(dayAfter('2026-12-31')).toBe('2027-01-01');
    expect(dayBefore('2027-01-01')).toBe('2026-12-31');
  });

  it('crosses the end of a month', () => {
    expect(dayAfter('2026-01-31')).toBe('2026-02-01');
    expect(dayBefore('2026-04-01')).toBe('2026-03-31');
  });

  /* Month lengths and leap years are `Date`'s to know, which is the half nobody
     should write twice. 2028 is a leap year and 2027 is not. */
  it('knows which Februaries have twenty nine days', () => {
    expect(dayAfter('2028-02-28')).toBe('2028-02-29');
    expect(dayAfter('2028-02-29')).toBe('2028-03-01');
    expect(dayAfter('2027-02-28')).toBe('2027-03-01');
    expect(dayBefore('2028-03-01')).toBe('2028-02-29');
  });

  it.each(['Pacific/Kiritimati', 'Pacific/Niue', 'Asia/Tokyo', 'UTC'])(
    'ignores the process, set here to %s',
    (zone) => {
      process.env.TZ = zone;

      expect(dayAfter('2026-12-31')).toBe('2027-01-01');
      expect(dayBefore('2026-01-01')).toBe('2025-12-31');
    },
  );

  /* Refused rather than coerced. There is no sensible day after 31/07/2026, and
     returning one would be inventing which of its two readings was meant. */
  it('refuses anything that is not written as a date', () => {
    expect(() => dayAfter('31/07/2026')).toThrow(/YYYY-MM-DD/);
    expect(() => dayAfter('2026-02-30')).toThrow(/calendar date/);
    expect(() => dayBefore('')).toThrow(/calendar date/);
  });

  /* And what comes out is ten characters again, never an instant. A function that
     handed back a `Date` would put the zone straight back into the answer. */
  it('hands back a calendar date, not a moment', () => {
    expect(isCalendarDate(dayAfter('2026-12-31'))).toBe(true);
    expect(isCalendarDate(dayBefore('2026-01-01'))).toBe(true);
  });
});

describe('which day of the week a day is', () => {
  /* ISO, so that the answer can be handed straight to `worksOn` and compared with
     `work_pattern_day.day_of_week`: 1 is Monday and 7 is Sunday. JavaScript numbers
     them from 0 for Sunday, and the whole reason this function exists is that the
     conversion happens once rather than at each call site. */
  it('numbers Monday 1 and Sunday 7', () => {
    expect(isoWeekdayOf('2026-03-02')).toBe(1);
    expect(isoWeekdayOf('2026-03-03')).toBe(2);
    expect(isoWeekdayOf('2026-03-04')).toBe(3);
    expect(isoWeekdayOf('2026-03-05')).toBe(4);
    expect(isoWeekdayOf('2026-03-06')).toBe(5);
    expect(isoWeekdayOf('2026-03-07')).toBe(6);
    expect(isoWeekdayOf('2026-03-08')).toBe(7);
  });

  /* The days the seeded calendar and every weekend test below turn on. Christmas
     Day 2026 is a Friday and Boxing Day is the Saturday after it, which is the
     case the whole leave calculator is most often asked about. */
  it('agrees with the calendar on the days the system ships with', () => {
    expect(isoWeekdayOf('2026-01-01')).toBe(4);
    expect(isoWeekdayOf('2026-12-25')).toBe(5);
    expect(isoWeekdayOf('2026-12-26')).toBe(6);
    expect(isoWeekdayOf('2026-12-04')).toBe(5);
  });

  /**
   * The one that would be silently wrong, and the reason the conversion goes
   * through UTC.
   *
   * `new Date('2026-03-08').getDay()` on a host set to New York is the seventh of
   * March, a Saturday, because midnight UTC is seven in the evening there. Half a
   * company's weekend would move by a day, and nothing would announce it.
   */
  it.each(['Pacific/Kiritimati', 'Pacific/Niue', 'America/New_York', 'Asia/Tokyo'])(
    'ignores the process, set here to %s',
    (zone) => {
      process.env.TZ = zone;

      expect(isoWeekdayOf('2026-03-08')).toBe(7);
      expect(isoWeekdayOf('2026-03-09')).toBe(1);
    },
  );

  it('refuses anything that is not written as a date', () => {
    expect(() => isoWeekdayOf('08/03/2026')).toThrow(/YYYY-MM-DD/);
    expect(() => isoWeekdayOf('2026-02-30')).toThrow(/day of the week/);
  });
});

describe('the run of days from one to another', () => {
  /* Inclusive at both ends, because that is how a person writes a period of leave:
     the first day off and the last day off, both of them days they are away. */
  it('holds both of the days it names', () => {
    expect([...eachDay('2026-12-24', '2026-12-27')]).toEqual([
      '2026-12-24',
      '2026-12-25',
      '2026-12-26',
      '2026-12-27',
    ]);
  });

  it('is one day where both ends are the same day', () => {
    expect([...eachDay('2026-07-31', '2026-07-31')]).toEqual(['2026-07-31']);
  });

  it('crosses a year end and a leap February', () => {
    expect([...eachDay('2026-12-30', '2027-01-02')]).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);

    expect([...eachDay('2028-02-27', '2028-03-01')]).toEqual([
      '2028-02-27',
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
  });

  /* Nothing at all rather than a throw. A period that runs backwards is a fact
     about a leave request rather than about the calendar, and the leave calculator
     refuses it by name before ever getting here. */
  it('yields nothing where the last day is before the first', () => {
    expect([...eachDay('2026-12-27', '2026-12-24')]).toEqual([]);
  });

  it('counts a fortnight as fourteen days', () => {
    expect([...eachDay('2026-12-21', '2027-01-03')].length).toBe(14);
  });
});

describe('how many days there are between two days', () => {
  /* Two, not one. The same inclusive rule, and the number a person gets counting
     off a wall calendar. */
  it('counts both ends', () => {
    expect(calendarDaysBetween('2026-12-25', '2026-12-26')).toBe(2);
    expect(calendarDaysBetween('2026-07-31', '2026-07-31')).toBe(1);
  });

  it('counts a whole year, and a leap one', () => {
    expect(calendarDaysBetween('2026-01-01', '2026-12-31')).toBe(365);
    expect(calendarDaysBetween('2028-01-01', '2028-12-31')).toBe(366);
  });

  /* Zero for a run of days that does not exist, which is the honest count of one.
     The refusal belongs to whoever was told two dates that are not a period. */
  it('is nothing where the last day is before the first', () => {
    expect(calendarDaysBetween('2026-12-27', '2026-12-24')).toBe(0);
  });

  /**
   * Arithmetic on two UTC midnights, which is why there is no daylight saving in
   * it to round. The same subtraction over local midnights in a zone that shifts
   * gives 364.958… days for a year, and `Math.round` hides that until the one year
   * it does not.
   */
  it.each(['America/New_York', 'Europe/London', 'Pacific/Kiritimati'])(
    'ignores the process, set here to %s',
    (zone) => {
      process.env.TZ = zone;

      expect(calendarDaysBetween('2026-03-01', '2026-11-30')).toBe(275);
    },
  );

  it('refuses anything that is not written as a date', () => {
    expect(() => calendarDaysBetween('25/12/2026', '2026-12-26')).toThrow(/YYYY-MM-DD/);
  });
});

describe('midnight from a spreadsheet', () => {
  it.each([
    ['2026-09-01 00:00:00', '2026-09-01'],
    ['2026-09-01T00:00:00', '2026-09-01'],
    ['2026-09-01T00:00:00Z', '2026-09-01'],
    ['2026-09-01 00:00', '2026-09-01'],
    ['2026-09-01 00:00:00.000', '2026-09-01'],
    ['2026-09-01', '2026-09-01'],
  ])('%s is the first of September', (value, expected) => {
    expect(withoutMidnight(value)).toBe(expected);
  });

  /* A real time is not dropped, because dropping it would be deciding which day
     somebody meant. It comes back unchanged and is refused by whoever asked. */
  it.each(['2026-09-01 09:30:00', '2026-09-01T23:59:59Z', '2026-09-01 12:00'])(
    '%s keeps its time and is not a calendar date',
    (value) => {
      expect(withoutMidnight(value)).toBe(value);
      expect(isCalendarDate(withoutMidnight(value))).toBe(false);
    },
  );
});

describe('the display timezone', () => {
  it('is Accra when nothing says otherwise', () => {
    expect(displayTimezone({})).toBe(DEFAULT_DISPLAY_TIMEZONE);
    expect(displayTimezone({ DISPLAY_TIMEZONE: '' })).toBe(DEFAULT_DISPLAY_TIMEZONE);
    expect(displayTimezone({ DISPLAY_TIMEZONE: '   ' })).toBe(DEFAULT_DISPLAY_TIMEZONE);
  });

  it.each(['Europe/London', 'America/New_York', 'Asia/Tokyo', 'UTC'])(
    'can be set to %s',
    (zone) => {
      expect(displayTimezone({ DISPLAY_TIMEZONE: zone })).toBe(zone);
      expect(displayTimezone({ DISPLAY_TIMEZONE: `  ${zone}  ` })).toBe(zone);
    },
  );

  /* Refused rather than quietly falling back. A typo shown as UTC for a year is
     the failure this is here to prevent. */
  it.each(['Africa/Akkra', 'GMT+1000', 'Europe/Atlantis', 'nonsense'])('refuses %s', (zone) => {
    expect(() => displayTimezone({ DISPLAY_TIMEZONE: zone })).toThrow(/DISPLAY_TIMEZONE/);
  });

  it('says what a zone name looks like when it refuses one', () => {
    expect(() => displayTimezone({ DISPLAY_TIMEZONE: 'Accra' })).toThrow(/IANA time zone name/);
  });

  it('knows a zone from a typo', () => {
    expect(isKnownTimeZone('Africa/Accra')).toBe(true);
    expect(isKnownTimeZone('Africa/Akkra')).toBe(false);
  });
});

describe('which day an instant fell on', () => {
  it('depends on where, and this is the pair that proves it', () => {
    expect(calendarDateIn(LATE_ON_THE_TWENTY_EIGHTH, 'Africa/Accra')).toBe('2026-08-28');
    expect(calendarDateIn(LATE_ON_THE_TWENTY_EIGHTH, 'Asia/Tokyo')).toBe('2026-08-29');
    expect(calendarDateIn(LATE_ON_THE_TWENTY_EIGHTH, 'America/New_York')).toBe('2026-08-28');
  });

  it('is zero padded, so the answer is a calendar date', () => {
    const early = new Date('2026-01-05T04:00:00Z');

    expect(calendarDateIn(early, 'UTC')).toBe('2026-01-05');
    expect(isCalendarDate(calendarDateIn(early, 'UTC'))).toBe(true);
  });

  /* The answer is a fact about the instant and the zone, and about nothing else.
     A conversion that quietly read the process's zone would pass every assertion
     above on a machine set to UTC and fail on somebody's laptop. */
  it.each(['Pacific/Kiritimati', 'America/Anchorage', 'UTC'])(
    'ignores the process, set here to %s',
    (zone) => {
      process.env.TZ = zone;

      expect(calendarDateIn(LATE_ON_THE_TWENTY_EIGHTH, 'Asia/Tokyo')).toBe('2026-08-29');
      expect(calendarDateIn(LATE_ON_THE_TWENTY_EIGHTH, 'Africa/Accra')).toBe('2026-08-28');
    },
  );

  /* Half past eleven at night, UTC, on two consecutive nights. The clocks go back
     in London between them, so the same time on the second night is a different
     day from the first relative to UTC — which is the whole argument for asking
     the zone rather than adding an offset somebody wrote down once. */
  it('follows the zone across a daylight saving boundary', () => {
    const duringBritishSummerTime = new Date('2026-10-24T23:30:00Z');
    const after = new Date('2026-10-25T23:30:00Z');

    expect(calendarDateIn(duringBritishSummerTime, 'Europe/London')).toBe('2026-10-25');
    expect(calendarDateIn(duringBritishSummerTime, 'UTC')).toBe('2026-10-24');

    expect(calendarDateIn(after, 'Europe/London')).toBe('2026-10-25');
    expect(calendarDateIn(after, 'UTC')).toBe('2026-10-25');
  });
});

describe('an instant shown to somebody', () => {
  it('names the zone, so nobody assumes it is theirs', () => {
    expect(formatInstant(LATE_ON_THE_TWENTY_EIGHTH, 'Africa/Accra')).toBe(
      '28 August 2026, 23:30 GMT',
    );
  });

  it('is the same moment, said differently, in a different zone', () => {
    expect(formatInstant(LATE_ON_THE_TWENTY_EIGHTH, 'Asia/Tokyo')).toBe(
      '29 August 2026, 08:30 GMT+9',
    );
  });

  it('writes the month as a word, because 01/09 and 09/01 are two days', () => {
    expect(formatInstant(new Date('2026-09-01T09:05:00Z'), 'UTC')).toBe(
      '1 September 2026, 09:05 UTC',
    );
  });

  it('is twenty four hour, so midnight is not either end of the day', () => {
    expect(formatInstant(new Date('2026-09-01T00:00:00Z'), 'UTC')).toBe(
      '1 September 2026, 00:00 UTC',
    );
    expect(formatInstant(new Date('2026-09-01T12:00:00Z'), 'UTC')).toBe(
      '1 September 2026, 12:00 UTC',
    );
    expect(formatInstant(new Date('2026-09-01T23:59:00Z'), 'UTC')).toBe(
      '1 September 2026, 23:59 UTC',
    );
  });

  it.each(['Pacific/Kiritimati', 'America/Anchorage', 'UTC'])(
    'ignores the process, set here to %s',
    (zone) => {
      process.env.TZ = zone;

      expect(formatInstant(LATE_ON_THE_TWENTY_EIGHTH, 'Africa/Accra')).toBe(
        '28 August 2026, 23:30 GMT',
      );
    },
  );
});
