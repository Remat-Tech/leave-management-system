/**
 * The working pattern. FR 23, LMS 106.
 *
 * A pattern is the week somebody works, and it exists so that leave is counted
 * against the days they actually work. Abena Sarpong works Monday, Tuesday,
 * Thursday and Friday: a week off costs her four days rather than five, and a
 * public holiday that falls on a Wednesday costs her nothing. Every one of those
 * answers comes out of this record.
 *
 * The same split as ./employee.ts and ./department.ts. The rules that need
 * nothing but the record in hand are here as pure functions; the ones that have
 * to count rows or look another record up are in the service. The database holds
 * the same rules as constraints, an index and two deferred triggers; see the
 * working-pattern-rules migration. That duplication is deliberate and the
 * division of labour is the usual one — the constraints make a bad pattern
 * impossible including when something other than this code is writing, and the
 * functions here make the refusal say which field was wrong and why.
 *
 * Two things are worth knowing before reading any of it.
 *
 * A week is always seven days. A pattern is stored as seven rows, one per day,
 * each saying whether it is worked, rather than as a list of the days that are.
 * The list is what a caller supplies and what {@link WorkPattern.workingDays}
 * hands back, because that is how somebody describes their own week; the seven
 * rows are how it is stored, so that "does this Saturday cost a day" has an
 * answer in the data rather than in whichever join the counting query used.
 *
 * Counting is not here. {@link worksOn} answers "is this weekday worked", which
 * is the primitive the leave calculator of Phase 2 is built from, and that is as
 * far as this story goes. Turning a date range into a number of days also needs
 * public holidays and the counting basis of the leave type, neither of which
 * exists yet.
 */

/** ISO day numbering: 1 is Monday, 7 is Sunday. The database uses the same. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/**
 * The standard week, and the pattern every database has.
 *
 * The name matches the row the working-pattern-rules migration inserts. It is
 * here so that the seed, the tests and anything that wants to say "the ordinary
 * week" name the same string rather than each spelling it out; the row is found
 * by `is_default` rather than by this name, so renaming it in HR's own words does
 * not break the system.
 */
export const STANDARD_PATTERN_NAME = 'Standard Mon-Fri';

/** Monday to Friday. */
export const MONDAY_TO_FRIDAY: readonly Weekday[] = [1, 2, 3, 4, 5];

/** What the caller supplies to create one. */
export interface NewWorkPattern {
  name: string;
  /**
   * The days that are worked, as ISO weekdays. The four days a part timer works,
   * not the seven rows they are stored as.
   */
  workingDays: readonly number[];
}

/**
 * The fields of an existing one that may change.
 *
 * `isDefault` is not among them, deliberately, and for the same reason
 * `isActive` is not an ordinary department edit: making a pattern the default
 * means unmaking the current one, which is two rows and one transaction rather
 * than a field. It is {@link WorkPatternService.makeDefault} instead.
 */
export type WorkPatternChanges = Partial<NewWorkPattern>;

/** A record as it comes back out. */
export interface WorkPattern {
  id: string;
  name: string;
  /** The days worked, ascending. Exactly one pattern in the table is the default. */
  workingDays: Weekday[];
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** The shape a validated record has by the time it reaches the repository. */
export interface ValidatedWorkPattern {
  name: string;
  workingDays: Weekday[];
}

/**
 * A record that was refused, and the field that caused it.
 *
 * The field is carried separately rather than only mentioned in the message, for
 * the reason {@link InvalidEmployee} carries one: the form that will sit in front
 * of this has to put the message next to the input.
 */
export class InvalidWorkPattern extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidWorkPattern';
    this.field = field;
  }
}

export class DuplicateWorkPatternName extends Error {
  constructor(name: string) {
    super(`There is already a working pattern called ${name}.`);
    this.name = 'DuplicateWorkPatternName';
  }
}

export class WorkPatternNotFound extends Error {
  readonly workPatternId: string;

  constructor(id: string) {
    super(`No working pattern with id ${id}.`);
    this.name = 'WorkPatternNotFound';
    this.workPatternId = id;
  }
}

/**
 * A database with no default working pattern, which is one where nobody can be
 * hired.
 *
 * `employee.work_pattern_id` is NOT NULL and a caller does not have to name a
 * pattern, so one has to stand in. Removing the pattern that stands in is not
 * noticed by whoever did it; it is noticed by the HR officer creating a joiner on
 * a Monday morning.
 */
export class DefaultWorkPatternRequired extends Error {
  constructor(pattern?: WorkPattern) {
    super(
      (pattern === undefined
        ? 'A working pattern has to be the default one, '
        : `${pattern.name} is the default working pattern, `) +
        'because a new employee who is not given a pattern is given that one. ' +
        'Make another pattern the default first.',
    );
    this.name = 'DefaultWorkPatternRequired';
  }
}

/**
 * Two patterns made the default at the same moment.
 *
 * Named for the same thing {@link SecondRootEmployee} is named for, and reached
 * the same way: the service reads the current default, decides, and writes, and
 * between the read and the write another transaction committed. Making a pattern
 * the default clears the old one first, so the loser of that race clears nothing
 * — the row it meant to clear had already been cleared by the winner — and then
 * writes a second default, which work_pattern_one_default refuses.
 *
 * Unlike a second root employee there is nobody to name, because the winner is
 * whichever pattern the other admin chose a moment ago and saying so would not
 * help. Trying again is the answer, and this time it succeeds.
 */
export class SecondDefaultWorkPattern extends Error {
  constructor() {
    super(
      'Another working pattern was made the default at the same moment, and only ' +
        'one may be. Try again.',
    );
    this.name = 'SecondDefaultWorkPattern';
  }
}

/**
 * A pattern somebody is still working.
 *
 * Deleting one is not a rewrite of history the way deleting an employee would be
 * — a pattern is a current fact about a week, not a record of anything that
 * happened — but the people on it would be left with no week at all, and
 * `employee.work_pattern_id` is NOT NULL, so the database refuses it in any case.
 * The count is carried because "move them first" is only actionable if HR knows
 * how many there are.
 */
export class WorkPatternInUse extends Error {
  readonly headcount: number;

  constructor(pattern: WorkPattern, headcount: number) {
    super(
      `${pattern.name} is the working pattern of ${headcount} ` +
        `${headcount === 1 ? 'person' : 'people'}. Move ` +
        `${headcount === 1 ? 'them' : 'them all'} to another pattern before ` +
        `deleting this one.`,
    );
    this.name = 'WorkPatternInUse';
    this.headcount = headcount;
  }
}

/** Checks and tidies a new record. */
export function validateNewWorkPattern(input: NewWorkPattern): ValidatedWorkPattern {
  return {
    name: requireName(input.name),
    workingDays: requireWorkingDays(input.workingDays),
  };
}

/**
 * Checks and tidies a change to an existing one.
 *
 * Only the fields actually supplied are returned, so a change mentioning nothing
 * leaves the record exactly as it was rather than rewriting it with whatever the
 * caller happened to have loaded. Supplying `workingDays` replaces the week
 * outright rather than adding to it: a week is a whole thing, and "Wednesdays as
 * well" and "Wednesdays instead" are not distinguishable in a list of days.
 *
 * Takes no `current`, like the department equivalent and unlike the employee one,
 * because no rule here spans two fields.
 */
export function validateWorkPatternChanges(
  changes: WorkPatternChanges,
): Partial<ValidatedWorkPattern> {
  const validated: Partial<ValidatedWorkPattern> = {};

  if ('name' in changes) {
    validated.name = requireName(changes.name);
  }
  if ('workingDays' in changes) {
    validated.workingDays = requireWorkingDays(changes.workingDays);
  }

  return validated;
}

/**
 * Whether a pattern works a given weekday. FR 23.
 *
 * The primitive every day count is built from, and deliberately the only one
 * this story ships. It takes an ISO weekday rather than a date, so it needs no
 * timezone and cannot acquire one: turning a date into a weekday is the caller's
 * business, and in Phase 2 it will be the leave calculator's, alongside the
 * public holiday calendar and the counting basis of the leave type.
 */
export function worksOn(pattern: WorkPattern, weekday: number): boolean {
  return pattern.workingDays.includes(weekday as Weekday);
}

/**
 * How many days a week this pattern works.
 *
 * What a pro rated entitlement is scaled by, and never zero: a pattern with no
 * working day is refused here and by the work_pattern_week_complete trigger, so
 * nothing downstream has to guard the division.
 */
export function workingDaysPerWeek(pattern: WorkPattern): number {
  return pattern.workingDays.length;
}

/** The week in the seven row form the database holds, ascending by day. */
export function weekOf(workingDays: readonly Weekday[]): {
  dayOfWeek: Weekday;
  isWorkingDay: boolean;
}[] {
  return WEEKDAYS.map((day) => ({ dayOfWeek: day, isWorkingDay: workingDays.includes(day) }));
}

/** Reads a week back out of the seven rows. */
export function workingDaysOf(
  days: readonly { dayOfWeek: number; isWorkingDay: boolean }[],
): Weekday[] {
  return days
    .filter((day) => day.isWorkingDay)
    .map((day) => day.dayOfWeek as Weekday)
    .sort((a, b) => a - b);
}

/**
 * Whether a pattern may be deleted, given the default and how many people are on
 * it.
 *
 * Both facts are passed in rather than read here, so the rule needs no database
 * and there is one description of it however the counting is done.
 *
 * "On it" means everybody, leavers included, which is a deliberate difference
 * from closing a department. There a leaver is no bar, because they are not going
 * to raise a request that has to appear under a team heading. Here they are:
 * FR 37a settles a leaver's final figure by counting days against the week they
 * worked, and a leaver whose pattern had been deleted could not be settled at
 * all. The foreign key says the same thing and says it to everybody.
 */
export function assertCanDelete(pattern: WorkPattern, headcount: number): void {
  if (pattern.isDefault) {
    throw new DefaultWorkPatternRequired(pattern);
  }
  if (headcount > 0) {
    throw new WorkPatternInUse(pattern, headcount);
  }
}

/**
 * The name a pattern is picked out of a list by.
 *
 * Trimmed rather than refused when it arrives padded, for the reason a department
 * name is: it is copied off a spreadsheet more often than it is typed. Blank is
 * refused rather than trimmed to nothing, because a pattern with no name is an
 * empty entry in the box an HR officer chooses from.
 */
function requireName(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidWorkPattern('name', 'A working pattern needs a name.');
  }

  const name = value.trim();
  if (name.length > 80) {
    throw new InvalidWorkPattern(
      'name',
      'A working pattern name is longer than the 80 characters the record holds.',
    );
  }

  return name;
}

/**
 * The days worked, as a tidy ascending set.
 *
 * Duplicates are collapsed rather than refused: `[1, 1, 2]` is a caller building
 * a list from checkboxes, and it says the same thing as `[1, 2]`. Everything else
 * is refused, and each refusal names what was wrong with it:
 *
 *   Not a list, or an empty one. A pattern with no working day is somebody whose
 *   leave costs nothing and whose entitlement divides by zero. That is
 *   employment_status, not a week.
 *
 *   A day outside 1 to 7, or one with a fraction in it. There is no eighth day
 *   and there is no Tuesday and a half; both are a caller sending the wrong
 *   units, and 0 in particular is somebody counting Sunday from zero as
 *   JavaScript's `getDay()` does. Silently accepting it would move every day of
 *   their week by one.
 */
function requireWorkingDays(value: readonly number[] | undefined): Weekday[] {
  if (!Array.isArray(value)) {
    throw new InvalidWorkPattern(
      'workingDays',
      'A working pattern needs the days of the week it works, as numbers from ' +
        '1 (Monday) to 7 (Sunday).',
    );
  }

  const days = [...new Set(value)].sort((a, b) => a - b);

  for (const day of days) {
    if (!Number.isInteger(day) || day < 1 || day > 7) {
      throw new InvalidWorkPattern(
        'workingDays',
        `${String(day)} is not a day of the week. Days are 1 (Monday) to 7 (Sunday); ` +
          'note that 0 is not Sunday here, unlike JavaScript.',
      );
    }
  }

  if (days.length === 0) {
    throw new InvalidWorkPattern(
      'workingDays',
      'A working pattern has to work at least one day. Somebody who works none ' +
        'takes no leave and has no entitlement to pro rate.',
    );
  }

  return days as Weekday[];
}
