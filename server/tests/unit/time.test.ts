import { afterEach, describe, expect, it } from 'vitest';
import {
  calendarDateIn,
  DEFAULT_DISPLAY_TIMEZONE,
  displayTimezone,
  formatInstant,
  isCalendarDate,
  isKnownTimeZone,
  withoutMidnight,
  type CalendarDate,
} from '../../src/domain/time.js';

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
