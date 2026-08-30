/**
 * Pro rating an entitlement for part of a year. FR 29, FR 29a, §8.6d. LMS 215.
 *
 * Somebody who joins on 1 July has not had a year, and the figure they are owed is not
 * a year's. The story's "so that" is the whole of the design: their balance should be
 * right on their first day rather than right after somebody notices.
 *
 * ## The formula is behind a name, because the formula is not settled
 *
 * The story's first criterion, and its fourth explains it: **LMS 013 has not delivered
 * the formula.** §8.6d gives a worked example — a joiner on 1 July is owed
 * 20 × 184/365 = 10.08 days — and that is what {@link BY_CALENDAR_DAYS} implements and
 * what {@link THE_RULE_IN_FORCE} points at today. It is the documented answer, and it
 * is not yet the decided one.
 *
 * So the arithmetic sits behind a {@link ProRataRule}: a name, a sentence, and one
 * function. Three things follow, and each is worth more than the indirection costs.
 *
 *   **Changing the formula is one line.** `THE_RULE_IN_FORCE` moves, and nothing that
 *   posts a grant is edited.
 *
 *   **Every figure says which rule produced it.** The rule's name goes into the ledger
 *   entry's reason — the story's third criterion — so a balance granted under the old
 *   answer is findable and correctable rather than indistinguishable. That matters
 *   precisely because this is blocked: the figures granted before LMS 013 lands are the
 *   ones somebody will have to go back to.
 *
 *   **A second rule proves the seam is real.** {@link BY_COMPLETED_TWELFTHS} is not in
 *   force and is not a recommendation. It is here so that "swappable" is a property
 *   somebody has tested rather than a shape nobody has put a second thing into — the
 *   same argument the migration suite makes about an exception that never applies.
 *
 * ## One formula, both ends of the year
 *
 * The story's second criterion, and it falls out rather than being arranged. A joiner
 * and a leaver are the same question — what part of this leave year were you employed
 * for — asked at the two ends. {@link employedPortionOf} answers it once, by clipping
 * the employment to the year, and somebody who joins *and* leaves inside one year is
 * the same call with both ends moved in.
 *
 * FR 29 is the joining half and FR 29a the leaving half, and there is one
 * implementation because there is one question.
 *
 * ## What decides *whether* to pro rate is not here
 *
 * `leave_entitlement_rule.prorate_on_join`, FR 29. Annual leave is pro rated and the
 * three days of sick leave are not — a joiner in December gets all three, because a
 * sick day is not accrued. That is a column HR sets per figure, read by the caller, and
 * nothing here has an opinion about which types it is true of. Design principle 5.
 */

import { calendarDaysBetween, type CalendarDate } from './time.js';

/** The leave year being pro rated within. */
export interface LeaveYearDates {
  startsOn: CalendarDate;
  endsOn: CalendarDate;
}

/** Somebody's employment, as far as it is known today. */
export interface Employment {
  startedOn: CalendarDate;
  /** Their last day, or null while they are still here. */
  leftOn: CalendarDate | null;
}

/** The part of a leave year somebody was employed for. Inclusive at both ends. */
export interface EmployedPortion {
  from: CalendarDate;
  to: CalendarDate;
}

/** What a rule is asked. */
export interface ProRataInput {
  /** What a whole year of this leave type is worth to this person. */
  fullYearDays: number;
  year: LeaveYearDates;
  portion: EmployedPortion;
}

/**
 * One way of working out what part of a year is worth.
 *
 * `name` is written into the ledger entry that carries the figure, so it is a stable
 * handle rather than a sentence: it is what somebody greps for when a formula changes
 * and the grants made under the old one have to be found.
 */
export interface ProRataRule {
  readonly name: string;
  /** One line, for a report and for the person asking why they have 10.08 days. */
  readonly says: string;
  daysOf(input: ProRataInput): number;
}

/**
 * §8.6d, and the worked example it gives: a joiner on 1 July is owed
 * 20 × 184/365 = 10.08 days.
 *
 * Every day of the year counts the same, whether it was worked or not — this is a
 * proportion of a year rather than a count of days at a desk, which is why a part timer
 * on a three day week is owed the same proportion as anybody else. What their working
 * pattern changes is what a day of leave *costs* them, FR 23, and that is the day
 * calculator's business rather than this one's.
 *
 * Rounded to the hundredth of a day, which is the precision the ledger's column holds
 * and the precision §8.6d's own example is quoted to. Refusing to round would put a
 * figure the column cannot hold into a grant, and the ledger would refuse it — which is
 * the right refusal in the wrong place.
 */
export const BY_CALENDAR_DAYS: ProRataRule = {
  name: 'calendar-days',
  says: 'a share of the year in proportion to the calendar days employed',

  daysOf({ fullYearDays, year, portion }: ProRataInput): number {
    const inTheYear = calendarDaysBetween(year.startsOn, year.endsOn);

    /* A leave year of no days is not one this system can hold — the leave year rules
       refuse it — and dividing by it here would produce a figure rather than an error,
       which is the worse of the two. */
    if (inTheYear === 0) {
      return 0;
    }

    return round((fullYearDays * calendarDaysBetween(portion.from, portion.to)) / inTheYear);
  },
};

/**
 * A candidate, and **not the rule in force**. LMS 013 may or may not choose it.
 *
 * Each complete twelfth of the leave year employed earns a twelfth of the figure, and
 * a part twelfth earns nothing. A joiner on 1 July gets 20 × 6/12 = 10 days rather than
 * 10.08 — which is the point of it being here: it gives a visibly different answer, so
 * a test that swaps the rule proves something.
 *
 * It exists because a seam with one implementation is a seam nobody has tried to use.
 * It is deliberately the simplest honest alternative rather than a guess at what HR will
 * decide, and it is named for exactly what it does rather than for "whole months",
 * which it is not: a twelfth of a 365 day year is 30.42 days and no month is.
 */
export const BY_COMPLETED_TWELFTHS: ProRataRule = {
  name: 'completed-twelfths',
  says: 'a twelfth of the year for each complete twelfth of it employed',

  daysOf({ fullYearDays, year, portion }: ProRataInput): number {
    const inTheYear = calendarDaysBetween(year.startsOn, year.endsOn);

    if (inTheYear === 0) {
      return 0;
    }

    const twelfths = Math.floor(calendarDaysBetween(portion.from, portion.to) / (inTheYear / 12));

    return round((fullYearDays * Math.min(twelfths, 12)) / 12);
  },
};

/**
 * Every rule there is, so that a name read back off an old ledger entry can be turned
 * into the sentence that explains it.
 *
 * Not a registry anybody adds to at runtime. A rule is a policy decision and arrives as
 * a release, which is the same reason the eight ledger entry types are a list rather
 * than a table.
 */
export const PRO_RATA_RULES: readonly ProRataRule[] = [BY_CALENDAR_DAYS, BY_COMPLETED_TWELFTHS];

/**
 * The one the system uses. **This line is the swap.**
 *
 * §8.6d's, because it is the only formula this build has been given in writing and it
 * comes with a worked example. LMS 013 has not answered, and when it does the answer is
 * this line and nothing else — every grant already posted keeps the name of the rule
 * that made it, so what has to be corrected is a query rather than an investigation.
 */
export const THE_RULE_IN_FORCE: ProRataRule = BY_CALENDAR_DAYS;

/** The rule of that name, or undefined. For reading an old entry back. */
export function ruleNamed(name: string): ProRataRule | undefined {
  return PRO_RATA_RULES.find((rule) => rule.name === name);
}

/**
 * The part of the leave year somebody was employed for, or nothing.
 *
 * Both ends clipped to the year, which is the whole of "the same implementation for
 * joining and leaving": a joiner moves the near end in, a leaver moves the far end in,
 * and somebody who did both in one year moves both. Nothing here knows which of the
 * three it is looking at.
 *
 * Undefined where the employment and the year do not overlap at all — somebody
 * recorded before they start, or a year they had already left before. That is an
 * answer rather than a failure: there is nothing to grant, which is different from
 * granting nothing.
 */
export function employedPortionOf(
  year: LeaveYearDates,
  employment: Employment,
): EmployedPortion | undefined {
  const from = later(year.startsOn, employment.startedOn);
  const to = earlier(year.endsOn, employment.leftOn ?? year.endsOn);

  return from > to ? undefined : { from, to };
}

/**
 * Whether somebody was employed for every day of the year.
 *
 * What tells a full grant from a pro rated one, and it is asked rather than inferred
 * from the figures: a rule that happened to return the whole year's days for part of a
 * year would otherwise be reported as a full grant, and the reason on the ledger entry
 * would say something that was not true.
 */
export function coversTheWholeYear(year: LeaveYearDates, portion: EmployedPortion): boolean {
  return portion.from <= year.startsOn && portion.to >= year.endsOn;
}

/**
 * What somebody is owed for the part of the year they were employed.
 *
 * The rule is a parameter with a default rather than read from a module-level constant
 * inside, so that a test can ask a different one the same question and a future story
 * can pro rate an old year under the rule that was in force then.
 */
export function proRataDaysFor(input: ProRataInput, rule: ProRataRule = THE_RULE_IN_FORCE): number {
  return rule.daysOf(input);
}

/** The later of two days, as text. Calendar dates sort correctly as strings. */
function later(one: CalendarDate, other: CalendarDate): CalendarDate {
  return one > other ? one : other;
}

function earlier(one: CalendarDate, other: CalendarDate): CalendarDate {
  return one < other ? one : other;
}

/**
 * Two decimal places, which is what the ledger's `days` column holds.
 *
 * The one place in this system where rounding a number of days is right rather than
 * refused. FR 24's whole days are about what somebody may *request*; §8.6d is explicit
 * that "FR 24 governs how leave is requested, not how entitlement is held", and 10.08
 * is the figure it quotes. See ./whole-days.ts for the rule this is the exception to.
 */
function round(days: number): number {
  return Math.round(days * 100) / 100;
}
