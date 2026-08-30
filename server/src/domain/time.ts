/**
 * Dates, instants, and the line between them. NFR DAT 03. LMS 114.
 *
 * The story is an employee whose leave never appears to shift by a day. That
 * sounds like one rule and is two, and almost every off by one day bug in a
 * leave system is the two being confused:
 *
 *   **An instant is a moment in time.** When somebody signed in, when a code
 *   expires, when a record was changed. It happens at the same moment everywhere
 *   and is described differently in different places. It is stored as UTC —
 *   `timestamptz`, which PostgreSQL holds as UTC whatever anybody's session says
 *   — and it is *displayed* in whatever zone the reader is in. See
 *   {@link displayTimezone}.
 *
 *   **A date is a day.** The day somebody started, the day they left, the days
 *   they are away. It has no time and no zone, because there is nothing about it
 *   for a zone to move: the thirty first of July is the thirty first of July in
 *   Accra, in London and on a laptop somebody has set to Tokyo. It is stored as
 *   `date` and carried as the ten characters `YYYY-MM-DD`. See
 *   {@link CalendarDate}.
 *
 * The rule that follows, and the only one anybody has to remember:
 *
 *   **Never turn a calendar date into an instant, and never turn an instant into
 *   a calendar date without saying where.** `new Date('2026-07-31')` is midnight
 *   UTC, which is the thirtieth of July in Accra by one hour and in New York by
 *   five, and it is how a leaver's exit date ends up a day either side of the one
 *   on their letter. There is exactly one function here that crosses between the
 *   two, {@link calendarDateIn}, and it will not do it without a zone.
 *
 * ## What is here and what is not
 *
 * `/domain` holds what a record is, as plain types and pure functions that
 * import nothing and touch nothing. Everything here obeys that: no database, no
 * network, and no clock — an instant arrives as an argument, exactly as it does
 * in ../auth/mfa.ts, so that "which day is that" can be asked about any moment
 * rather than only about now.
 *
 * {@link displayTimezone} reads the environment, and takes it as an argument for
 * the same reason `codeSettings` does. It is a function of what it is given.
 *
 * Since LMS 207 there is also the small amount of calendar arithmetic the leave
 * calculator needs — {@link isoWeekdayOf}, {@link eachDay} and
 * {@link calendarDaysBetween}. They are here rather than beside the rule that wants
 * them for the reason {@link dayAfter} is: which weekday the sixth of March falls
 * on, and how many days there are between two dates, are facts about the calendar
 * rather than about leave. Each builds a `Date` at UTC midnight and reads it back
 * at UTC, so the zone cancels rather than being avoided — the same statable
 * argument, made once, in the one file allowed to make it.
 *
 * What is *not* here is the storage half of the rule, which is not code at all:
 * the columns are `timestamptz` and `date`, the session is pinned to UTC and
 * ISO dates by the timestamps-in-utc migration and by ../db/index.ts, and
 * server/tests/integration/time.test.ts refuses a future table that gets either
 * wrong.
 */

/**
 * A calendar date, `YYYY-MM-DD`, with no time and no timezone.
 *
 * A string rather than a `Date`, and that is the whole point rather than a
 * shortcut. A `Date` is an instant and cannot hold a day without also holding a
 * moment, so storing one means picking a time nobody chose and a zone nobody
 * asked about, and reading it back somewhere else gives a different day. Ten
 * characters have no such trapdoor.
 *
 * They also compare correctly. `'2026-07-31' < '2026-08-01'` is true, and is
 * true for every pair of dates in this form, because the fields run from the
 * most significant to the least and are zero padded. That is most of why the
 * form is fixed: a date comparison is a string comparison and needs no library
 * and no conversion.
 */
export type CalendarDate = string;

/** `YYYY-MM-DD`, and nothing else. Shape only; see {@link isCalendarDate}. */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether this is a calendar date somebody could actually have been born on.
 *
 * Both halves are needed and only one of them is obvious. The shape rejects
 * `31/07/2026` and `2026-7-1`; it accepts `2026-02-31` and `2026-13-01`, which
 * match ten characters and are not days.
 *
 * The realness check round trips through UTC deliberately. A date built at UTC
 * midnight and formatted back at UTC is the same day it went in — the zone
 * cancels rather than being avoided, so this is the one place a `Date` is
 * allowed near a `CalendarDate` and it is safe for a reason that can be stated
 * rather than because it happens to work. `Date` also rolls over silently, so
 * the thirty first of February arrives back as the third of March and fails the
 * comparison, which is exactly the answer wanted.
 */
export function isCalendarDate(value: unknown): value is CalendarDate {
  if (typeof value !== 'string' || !CALENDAR_DATE.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00Z`);

  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * The day after this one. LMS 205.
 *
 * The only arithmetic this file does on a calendar date, and it is here rather
 * than beside the one rule that wants it — `earliestOpenDayOf` in
 * ./leave-year.ts, which reads the day after a closed year's last — because
 * "what comes after the thirty first of December" is a fact about the calendar
 * rather than about leave years.
 *
 * It round trips through UTC midnight for exactly the reason {@link isCalendarDate}
 * does, and it is safe for the same statable reason rather than because it
 * happens to work: a date built at UTC midnight and formatted back at UTC is the
 * day it went in, so the zone cancels rather than being avoided. Nothing here is
 * ever shown to anybody or stored as an instant — the `Date` exists for the
 * length of the expression and what comes out is ten characters again.
 *
 * `Date` also knows about leap years and month lengths, which is the half nobody
 * should write twice: the day after the twenty eighth of February 2028 is the
 * twenty ninth, and after the twenty eighth of February 2027 it is the first of
 * March.
 *
 * A value that is not a calendar date is refused rather than coerced. There is no
 * sensible day after `31/07/2026`, and returning one would be inventing which of
 * the two readings of it was meant.
 */
export function dayAfter(day: CalendarDate): CalendarDate {
  return shift(day, 1);
}

/**
 * The day before this one. LMS 205.
 *
 * The counterpart of {@link dayAfter}, and it exists because naming a gap needs
 * both ends: the days between one leave year and the next run from the day after
 * the first ends to the day before the second starts.
 */
export function dayBefore(day: CalendarDate): CalendarDate {
  return shift(day, -1);
}

/**
 * A calendar date moved by whole days, and the one place a `Date` is built from
 * one.
 *
 * Both directions go through here rather than each doing the round trip, so there
 * is one copy of the argument about why it is safe and one thing to read if it is
 * ever doubted.
 */
function shift(day: CalendarDate, days: number): CalendarDate {
  const moved = new Date(`${requireCalendarDate(day)}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);

  return moved.toISOString().slice(0, 10);
}

/**
 * Which day of the week that day is, numbered as this system numbers them.
 * LMS 207.
 *
 * ISO: 1 is Monday and 7 is Sunday, which is what `work_pattern_day.day_of_week`
 * holds and what {@link worksOn} takes. JavaScript numbers them from 0 for Sunday,
 * so the conversion is here, once, rather than at each call site — an off by one
 * in that arithmetic moves everybody's weekend by a day and does it silently.
 *
 * It round trips through UTC midnight for exactly the reason {@link dayAfter}
 * does, and is safe for the same statable reason rather than because it happens to
 * work: a date built at UTC midnight is read back at UTC, so the zone cancels. That
 * matters more here than anywhere else in this file, because a `getDay()` on a
 * local `Date` is how a Sunday in Accra becomes a Saturday on a server in New York
 * — and every leave count in the system would then be a day out for half of it.
 *
 * A value that is not a calendar date is refused rather than coerced, as
 * {@link dayAfter} refuses one: there is no weekday of `31/07/2026`, and returning
 * one would be inventing which of its two readings was meant.
 */
export function isoWeekdayOf(day: CalendarDate): number {
  if (!isCalendarDate(day)) {
    throw new Error(
      `${String(day)} is not a calendar date, so it has no day of the week. Days are ` +
        'written YYYY-MM-DD, which is the one form that means the same thing to ' +
        'everybody reading it.',
    );
  }

  /* getUTCDay() is 0 for Sunday through 6 for Saturday. Shifting by six and
     wrapping turns Sunday into 6 and Monday into 0, and the +1 makes it ISO. */
  return ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

/**
 * Every day from one to another, inclusive at both ends. LMS 207.
 *
 * What the leave calculator walks. Inclusive because that is how a person writes a
 * period of leave — the first day off and the last day off, both of them days they
 * are away — and a half open range here would silently make every request a day
 * shorter than the one somebody typed.
 *
 * A generator rather than an array, so that the caller decides what to keep. The
 * calculator keeps a count and the handful of days that cost nothing, which is
 * usually fewer than six entries for a fortnight; materialising the whole run
 * first would allocate a list whose only purpose was to be reduced.
 *
 * It yields nothing at all when `to` is before `from`. That is not this function's
 * rule to enforce — a period that runs backwards is a fact about a leave request
 * rather than about the calendar — and the calculator refuses it by name before
 * ever getting here.
 */
export function* eachDay(from: CalendarDate, to: CalendarDate): Generator<CalendarDate> {
  let day = from;

  while (day <= to) {
    yield day;
    day = dayAfter(day);
  }
}

/**
 * How many days there are from one to another, inclusive at both ends. LMS 207.
 *
 * `2026-12-25` to `2026-12-26` is two days, not one, for the same reason
 * {@link eachDay} is inclusive. Zero where the period runs backwards, which is the
 * honest count of a run of days that does not exist.
 *
 * Arithmetic on the two instants rather than a walk, because the answer does not
 * depend on which days those are and a caller asking only "how long is this" should
 * not pay for the walk. Both are UTC midnights, so the difference is a whole number
 * of days with no daylight saving in it to round — which is the second half of why
 * a calendar date is never stored in a zone that has any.
 */
export function calendarDaysBetween(from: CalendarDate, to: CalendarDate): number {
  const first = new Date(`${requireCalendarDate(from)}T00:00:00Z`).getTime();
  const last = new Date(`${requireCalendarDate(to)}T00:00:00Z`).getTime();

  return Math.max(0, Math.round((last - first) / 86_400_000) + 1);
}

/** A calendar date, or a refusal naming the value that was not one. */
function requireCalendarDate(day: CalendarDate): CalendarDate {
  if (!isCalendarDate(day)) {
    throw new Error(
      `${String(day)} is not a calendar date. Days are written YYYY-MM-DD, which is ` +
        'the one form that means the same thing to everybody reading it.',
    );
  }

  return day;
}

/**
 * A date a spreadsheet has decided is a datetime, with the midnight taken off.
 *
 * Excel and Google Sheets write `2026-09-01 00:00:00` for a cell they have typed
 * as a datetime, and mean the first of September. Dropping a midnight is
 * unambiguous, so it is done; dropping anything else would be guessing at which
 * day somebody meant, so a value with a real time on it comes back unchanged and
 * is refused by whoever asked. `T` as well as a space, and a trailing `Z`,
 * because both appear in files people actually send.
 *
 * Here rather than in ../domain/staff-import.ts because it is a fact about the
 * form rather than about importing, and because the next reader of a file will
 * be a leave request upload rather than a staff list.
 */
export function withoutMidnight(value: string): string {
  return value.replace(/[ T]00:00(:00(\.0+)?)?Z?$/, '');
}

/**
 * The zone leave is read in when nothing says otherwise.
 *
 * Remat Holdings is in Accra, which is UTC+0 all year and observes no daylight
 * saving. That makes it a poor default to test against and a correct one to
 * ship: a suite that only ever ran here would pass with every conversion in it
 * removed, which is why server/tests/unit/time.test.ts does its arithmetic in
 * zones that are hours away and on the wrong side of midnight.
 */
export const DEFAULT_DISPLAY_TIMEZONE = 'Africa/Accra';

/**
 * Whether this is a zone this runtime knows.
 *
 * An IANA name — `Africa/Accra`, `Europe/London`, `UTC`. Asked of `Intl` rather
 * than of a list kept here, because the list is the runtime's and a copy of it
 * would be wrong the first time a country changed its mind about daylight
 * saving, which happens somewhere most years.
 *
 * A zone this returns false for is either a typo or a Node built without full
 * ICU, and the refusal in {@link displayTimezone} says both.
 */
export function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone instants are shown in. `DISPLAY_TIMEZONE`.
 *
 * Display only, and the name is the promise: nothing is stored in it, nothing is
 * calculated in it, and changing it changes what a screen says and not one row
 * in the database. That is what makes it configurable at all — a setting that
 * moved stored values would be a migration wearing an environment variable's
 * clothes.
 *
 * Blank means the usual one, as `MFA_CODE_LENGTH` blank does, because there is a
 * usual one and an unset zone is not ambiguous. Present and unknown is refused
 * rather than quietly falling back, and that is the case worth being firm about:
 * `Africa/Akkra` silently becoming Accra is right this once and wrong the day
 * somebody sets `Europe/Lisbon` and means it, and a company that has moved its
 * office wants to be told its typo rather than shown UTC for a year.
 *
 * It is not a per-person setting, and the difference will matter if anybody ever
 * asks. This is where the *company* reads its leave. Somebody travelling wants
 * their leave to look the same as it does to the colleague approving it, which
 * is one zone for everybody rather than one each.
 */
export function displayTimezone(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DISPLAY_TIMEZONE;

  if (value === undefined || value.trim() === '') {
    return DEFAULT_DISPLAY_TIMEZONE;
  }

  const zone = value.trim();

  if (!isKnownTimeZone(zone)) {
    throw new Error(
      `DISPLAY_TIMEZONE is "${value}". It must be an IANA time zone name, as ` +
        `${DEFAULT_DISPLAY_TIMEZONE} or Europe/London. If the name looks right, this ` +
        `Node was built without the full timezone data. See .env.example.`,
    );
  }

  return zone;
}

/**
 * Which day an instant fell on, somewhere.
 *
 * The one function in this file that crosses between an instant and a date, and
 * it takes the zone as an argument because there is no answer without one. The
 * twenty eighth of August at half past eleven at night in Accra is already the
 * twenty ninth in Tokyo, and both are the same instant.
 *
 * Use it on an instant. Never on a {@link CalendarDate} — a date has already
 * been converted by whoever wrote it down, and converting it again is the off by
 * one day this whole file exists to prevent. If the value came out of a `date`
 * column it is finished; show it as it is.
 *
 * Assembled from `formatToParts` rather than from a formatted string, so that
 * the output is `YYYY-MM-DD` whatever the runtime's idea of a locale's date
 * order is.
 */
export function calendarDateIn(instant: Date, zone: string): CalendarDate {
  const parts = partsOf(instant, zone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * An instant, for somebody to read, in the zone they read leave in.
 *
 * `1 September 2026, 14:32 GMT`. Four decisions in that, and each is somebody
 * misreading it otherwise:
 *
 *   The zone is named. A time with no zone on it is a time the reader assumes is
 *   theirs, and the whole reason this function exists is that it might not be.
 *
 *   Twenty four hour, so there is no am and pm to lose and no midnight that
 *   could be either end of the day.
 *
 *   The month is a word. `01/09/2026` and `09/01/2026` are the same characters
 *   meaning two different days — the same argument the staff import makes about
 *   what it will accept, made about what a screen shows.
 *
 *   Assembled from parts rather than from `dateStyle`, so that the sentence is
 *   the same on every runtime. A format that shifts with the ICU version is a
 *   format nothing can assert on.
 */
export function formatInstant(instant: Date, zone: string): string {
  const parts = partsOf(instant, zone, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  });

  return (
    `${parts.day} ${parts.month} ${parts.year}, ` +
    `${parts.hour}:${parts.minute} ${parts.timeZoneName}`
  );
}

/**
 * The pieces of an instant in a zone, by name.
 *
 * `en-GB` fixes the calendar and the numerals — Gregorian and Western Arabic —
 * and nothing else about it is read, because every piece is taken by name and
 * put together here. The locale is not a display choice; the zone is.
 */
function partsOf(
  instant: Date,
  zone: string,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const parts: Record<string, string> = {};

  for (const part of new Intl.DateTimeFormat('en-GB', { ...options, timeZone: zone }).formatToParts(
    instant,
  )) {
    parts[part.type] = part.value;
  }

  return parts;
}
